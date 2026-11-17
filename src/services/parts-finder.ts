/**
 * Parts finder (ADR-0003): customer enquiries worked by the parts agent.
 *
 *   customer says something -> agent proposes parts -> we check every one
 *   against the catalogue and build the evidence -> draft reply for the
 *   parts person -> or a callback case with a real person and time
 *
 * Rules
 *  - The engine only proposes numbers. Each is resolved here; anything that
 *    doesn't resolve is dropped. Evidence, price, stock and the fitting guide
 *    come from our data, never from the model.
 *  - Hand over to a person for safety-critical parts (always), after 3 agent
 *    rounds without a confident answer, or when nothing matches.
 *  - Callbacks: 15 minutes for a stopped machine (VOR), otherwise 1 hour.
 *  - Resolving with the right part teaches the system: it becomes a fitment
 *    line for that machine model (source "enquiry").
 */
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  customers, enquiries, enquiryMessages, machineModels, machines, partFitment, parts, partSalesHistory, partSupersessions,
  type EnquiryCandidate, type EnquiryEvidence, type EnquiryResult,
} from '../db/schema.js';
import { claudeAvailable, claudeEngine } from '../integrations/parts-agent/claude.js';
import { localAvailable, localEngine, localStatus } from '../integrations/parts-agent/local.js';
import { rulesEngine } from '../integrations/parts-agent/rules.js';
import type { AgentInput, AgentMachine, AgentPick, AgentProgress, AgentProposal, PartsAgentEngine } from '../integrations/parts-agent/types.js';
import { AppError, notFound } from '../lib/errors.js';
import { looksLikePartNumber, normalisePartNumber } from '../lib/part-number.js';
import { audit, nextNumber, type ServiceContext } from './context.js';
import { guidanceForPart } from './guidance.js';
import { equivalents, resolvePart, stockByDepot } from './parts.js';
import { priceFor } from './pricing.js';

export const CALLBACK_MINUTES = { vor: 15, normal: 60 } as const;
export const MAX_AGENT_ROUNDS = 3;
const SAFETY_CRITICAL = /\b(brakes?|steering|hitch|linkage|top link|lower link|pto (shaft )?guard|guard cone|rops|roll ?bar|cab frame|tyres?|tires?|wheels?)\b/i;

export const OpenEnquirySchema = z.object({
  channel: z.enum(['counter', 'phone', 'whatsapp', 'email', 'web']).default('counter'),
  customerAccount: z.string().min(1).optional(),
  contactName: z.string().max(120).optional(),
  machineSerial: z.string().min(1).optional(),
  priority: z.enum(['normal', 'vor']).default('normal'),
  message: z.string().min(2).max(4000),
});

// ---------------------------------------------------------------- loading

async function loadEnquiry(ctx: ServiceContext, id: string) {
  const [e] = await ctx.db.select().from(enquiries).where(and(eq(enquiries.tenantId, ctx.tenantId), eq(enquiries.id, id)));
  if (!e) throw notFound('Enquiry', id);
  return e;
}

async function machineRows(ctx: ServiceContext, where: ReturnType<typeof eq>) {
  return ctx.db
    .select({ id: machines.id, serial: machines.serial, regNo: machines.regNo, year: machines.year, engineHours: machines.engineHours, site: machines.site, make: machineModels.make, model: machineModels.model, kind: machineModels.kind, modelId: machineModels.id, customerId: machines.customerId })
    .from(machines)
    .innerJoin(machineModels, eq(machineModels.id, machines.machineModelId))
    .where(and(eq(machines.tenantId, ctx.tenantId), where));
}

const asAgentMachine = (m: { serial: string; make: string; model: string; kind: string | null; year: number | null; engineHours: number | null }): AgentMachine => ({
  serial: m.serial, make: m.make, model: m.model, kind: m.kind, year: m.year, engineHours: m.engineHours,
});

// ---------------------------------------------------------------- public API

export async function openEnquiry(ctx: ServiceContext, raw: z.input<typeof OpenEnquirySchema>) {
  ctx.require('enquiries:write');
  const input = OpenEnquirySchema.parse(raw);
  let customerId: string | null = null;
  if (input.customerAccount) {
    const [c] = await ctx.db.select().from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.accountCode, input.customerAccount.toUpperCase())));
    if (!c) throw notFound('Customer', input.customerAccount);
    customerId = c.id;
  }
  let machineId: string | null = null;
  if (input.machineSerial) {
    const [m] = await machineRows(ctx, eq(machines.serial, input.machineSerial.trim()));
    if (!m) throw notFound('Machine', input.machineSerial);
    machineId = m.id;
    customerId ??= m.customerId;
  }
  const ref = await nextNumber(ctx, 'enquiry', 'ENQ');
  const [e] = await ctx.db
    .insert(enquiries)
    .values({
      tenantId: ctx.tenantId, ref, channel: input.channel, customerId, contactName: input.contactName ?? null, machineId,
      subject: input.message.split('\n')[0]!.slice(0, 140), priority: input.priority, createdBy: ctx.actorLabel,
    })
    .returning();
  await ctx.db.insert(enquiryMessages).values({ tenantId: ctx.tenantId, enquiryId: e!.id, role: 'customer', body: input.message, author: input.contactName ?? null });
  await audit(ctx, 'enquiry.opened', 'enquiry', e!.id, { ref, channel: input.channel, priority: input.priority });
  await runAgent(ctx, e!.id);
  return getEnquiry(ctx, e!.id);
}

/** The queue: stopped machines first, then callbacks by due time, then the rest by last activity. */
export async function listEnquiries(ctx: ServiceContext, opts: { include?: 'active' | 'all' } = {}) {
  ctx.require('parts:read');
  const rows = await ctx.db
    .select({ e: enquiries, customer: customers.name, account: customers.accountCode, serial: machines.serial, model: machineModels.model, make: machineModels.make })
    .from(enquiries)
    .leftJoin(customers, eq(customers.id, enquiries.customerId))
    .leftJoin(machines, eq(machines.id, enquiries.machineId))
    .leftJoin(machineModels, eq(machineModels.id, machines.machineModelId))
    .where(and(eq(enquiries.tenantId, ctx.tenantId), opts.include === 'all' ? undefined : inArray(enquiries.status, ['open', 'waiting_customer', 'callback'])))
    .orderBy(desc(enquiries.updatedAt))
    .limit(100);
  const rank = (r: (typeof rows)[number]) => (r.e.priority === 'vor' ? 0 : r.e.status === 'callback' ? 1 : r.e.status === 'open' ? 2 : 3);
  return rows
    .sort((a, b) => rank(a) - rank(b) || (a.e.callbackDueAt?.getTime() ?? 0) - (b.e.callbackDueAt?.getTime() ?? 0))
    .map((r) => {
      const best = r.e.result?.candidates.find((c) => c.role === 'best');
      return {
        id: r.e.id, ref: r.e.ref, channel: r.e.channel, status: r.e.status, priority: r.e.priority, subject: r.e.subject,
        customer: r.customer, account: r.account, contactName: r.e.contactName,
        machine: r.serial ? { serial: r.serial, make: r.make, model: r.model } : null,
        confidence: r.e.result?.confidence ?? null,
        bestPart: best ? best.partNumber : null,
        assignedTo: r.e.assignedTo, callbackDueAt: r.e.callbackDueAt, createdAt: r.e.createdAt, updatedAt: r.e.updatedAt,
      };
    });
}

export async function getEnquiry(ctx: ServiceContext, id: string) {
  ctx.require('parts:read');
  const e = await loadEnquiry(ctx, id);
  const [customer] = e.customerId ? await ctx.db.select({ accountCode: customers.accountCode, name: customers.name, phone: customers.phone, priceBand: customers.priceBand }).from(customers).where(eq(customers.id, e.customerId)) : [];
  const [machine] = e.machineId ? await machineRows(ctx, eq(machines.id, e.machineId)) : [];
  const theirMachines = e.customerId ? await machineRows(ctx, eq(machines.customerId, e.customerId)) : [];
  const messages = await ctx.db.select().from(enquiryMessages).where(eq(enquiryMessages.enquiryId, e.id)).orderBy(asc(enquiryMessages.id));
  return {
    id: e.id, ref: e.ref, channel: e.channel, status: e.status, priority: e.priority, subject: e.subject,
    contactName: e.contactName, assignedTo: e.assignedTo, callbackDueAt: e.callbackDueAt, callbackReason: e.callbackReason,
    agentRounds: e.agentRounds, resolution: e.resolution,
    resolvedPart: e.resolvedPartNumberNorm ? { make: e.resolvedMake, partNumber: e.resolvedPartNumberNorm } : null,
    createdAt: e.createdAt, updatedAt: e.updatedAt,
    customer: customer ?? null,
    machine: machine ? { serial: machine.serial, regNo: machine.regNo, make: machine.make, model: machine.model, kind: machine.kind, year: machine.year, engineHours: machine.engineHours, site: machine.site } : null,
    customerMachines: theirMachines.map((m) => ({ serial: m.serial, make: m.make, model: m.model })),
    messages: messages.map((m) => ({ id: m.id, role: m.role, body: m.body, author: m.author, at: m.createdAt })),
    result: e.result,
    engine: claudeAvailable() ? 'claude' : 'rules',
  };
}

/** The customer said something more: record it and let the agent take another turn. */
export async function addCustomerMessage(ctx: ServiceContext, id: string, body: string) {
  ctx.require('enquiries:write');
  const e = await loadEnquiry(ctx, id);
  if (e.status === 'resolved' || e.status === 'closed') throw new AppError('INVALID_STATE', `Enquiry ${e.ref} is ${e.status}`);
  const text = body.trim();
  if (!text) throw new AppError('VALIDATION', 'Message is empty');
  await ctx.db.insert(enquiryMessages).values({ tenantId: ctx.tenantId, enquiryId: e.id, role: 'customer', body: text.slice(0, 4000), author: e.contactName });
  await runAgent(ctx, e.id);
  return getEnquiry(ctx, e.id);
}

/** The parts person sends a reply (the agent's draft, edited or not). */
export async function sendReply(ctx: ServiceContext, id: string, body: string) {
  ctx.require('enquiries:write');
  const e = await loadEnquiry(ctx, id);
  const text = body.trim();
  if (!text) throw new AppError('VALIDATION', 'Reply is empty');
  await ctx.db.insert(enquiryMessages).values({ tenantId: ctx.tenantId, enquiryId: e.id, role: 'staff', body: text.slice(0, 4000), author: ctx.actorLabel });
  const status = e.status === 'callback' ? 'callback' : e.result?.question ? 'waiting_customer' : 'open';
  await ctx.db.update(enquiries).set({ status, updatedAt: new Date() }).where(eq(enquiries.id, e.id));
  await audit(ctx, 'enquiry.replied', 'enquiry', e.id, { ref: e.ref, chars: text.length });
  return getEnquiry(ctx, e.id);
}

/** Hand over to a person. The customer is told who and by when. */
export async function requestCallback(ctx: ServiceContext, id: string, input: { reason: string; assignee?: string | undefined }) {
  ctx.require('enquiries:write');
  const e = await loadEnquiry(ctx, id);
  await handOver(ctx, e, input.reason, input.assignee);
  return getEnquiry(ctx, e.id);
}

/**
 * Close the loop with the part that was actually right. If we know the
 * machine and that part isn't on its model's list yet, it becomes a fitment
 * line (source "enquiry"), so the next customer gets it straight away.
 */
export async function resolveEnquiry(ctx: ServiceContext, id: string, input: { make?: string | undefined; partNumber: string; notes?: string | undefined }) {
  ctx.require('enquiries:write');
  const e = await loadEnquiry(ctx, id);
  if (e.status === 'resolved') throw new AppError('INVALID_STATE', `Enquiry ${e.ref} is already resolved`);
  const r = await resolvePart(ctx, { partNumber: input.partNumber, make: input.make });
  let learned = false;
  if (e.machineId) {
    const [m] = await machineRows(ctx, eq(machines.id, e.machineId));
    const existing = await ctx.db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(partFitment)
      .where(and(eq(partFitment.tenantId, ctx.tenantId), eq(partFitment.machineModelId, m!.modelId), eq(partFitment.make, r.part.make), eq(partFitment.partNumberNorm, r.part.partNumberNorm)));
    if (!existing[0]!.n) {
      await ctx.db.insert(partFitment).values({
        tenantId: ctx.tenantId, machineModelId: m!.modelId, make: r.part.make, partNumberNorm: r.part.partNumberNorm,
        assembly: 'Confirmed on enquiry', source: 'enquiry', confidence: 80, verifiedBy: ctx.actorLabel,
      });
      learned = true;
    }
  }
  await ctx.db
    .update(enquiries)
    .set({ status: 'resolved', resolvedMake: r.part.make, resolvedPartNumberNorm: r.part.partNumber, resolution: input.notes ?? null, callbackDueAt: null, updatedAt: new Date() })
    .where(eq(enquiries.id, e.id));
  await ctx.db.insert(enquiryMessages).values({ tenantId: ctx.tenantId, enquiryId: e.id, role: 'system', body: `Resolved by ${ctx.actorLabel}: ${r.part.partNumber} ${r.part.description}${learned ? '. Added to this model\'s parts list.' : ''}` });
  await audit(ctx, 'enquiry.resolved', 'enquiry', e.id, { ref: e.ref, part: r.part.partNumber, learned, agentBest: e.result?.candidates.find((c) => c.role === 'best')?.partNumber ?? null });
  return { ...(await getEnquiry(ctx, e.id)), learnedFitment: learned };
}

// ---------------------------------------------------------------- the agent turn

export async function runAgent(ctx: ServiceContext, id: string): Promise<EnquiryResult> {
  const e = await loadEnquiry(ctx, id);
  const [customer] = e.customerId ? await ctx.db.select().from(customers).where(eq(customers.id, e.customerId)) : [];
  const theirMachines = e.customerId ? await machineRows(ctx, eq(machines.customerId, e.customerId)) : [];
  const [machine] = e.machineId ? await machineRows(ctx, eq(machines.id, e.machineId)) : [];
  const messages = await ctx.db.select({ role: enquiryMessages.role, body: enquiryMessages.body }).from(enquiryMessages).where(eq(enquiryMessages.enquiryId, e.id)).orderBy(asc(enquiryMessages.id));
  const input: AgentInput = {
    ctx, channel: e.channel, priority: e.priority,
    customer: customer ? { id: customer.id, accountCode: customer.accountCode, name: customer.name } : null,
    machine: machine ? asAgentMachine(machine) : null,
    customerMachines: theirMachines.map(asAgentMachine),
    messages, rounds: e.agentRounds,
  };

  let proposal: AgentProposal;
  const extraNotes: string[] = [];
  const engine = claudeAvailable() ? claudeEngine : localAvailable() ? localEngine : null;
  if (engine) {
    try {
      proposal = await engine.propose(input);
    } catch (err) {
      extraNotes.push(`${engine.name === 'claude-local' ? 'Local Claude' : 'Claude agent'} unavailable (${err instanceof Error ? err.message : String(err)}); used the offline matcher`);
      proposal = await rulesEngine.propose(input);
    }
  } else proposal = await rulesEngine.propose(input);

  // The machine, if the engine identified one.
  let machineRow = machine;
  if (!machineRow && proposal.machineSerial) {
    const [m] = await machineRows(ctx, eq(machines.serial, proposal.machineSerial));
    if (m && (!e.customerId || m.customerId === e.customerId)) {
      machineRow = m;
      await ctx.db.update(enquiries).set({ machineId: m.id, customerId: e.customerId ?? m.customerId }).where(eq(enquiries.id, e.id));
    } else extraNotes.push(`Ignored machine ${proposal.machineSerial}: not found on this account`);
  }

  // Every pick checked against our data.
  const candidates: EnquiryCandidate[] = [];
  const seen = new Set<string>();
  for (const pick of proposal.picks) {
    const c = await buildCandidate(ctx, pick, customer ?? null, machineRow ?? null);
    if (!c) {
      extraNotes.push(`Dropped ${pick.make} ${pick.partNumber}: not in the catalogue`);
      continue;
    }
    const k = `${c.make}|${normalisePartNumber(c.partNumber)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(c);
  }
  const best = candidates.find((c) => c.role === 'best');
  if (best) {
    for (const alt of await alternativesFor(ctx, best)) {
      const k = `${alt.make}|${normalisePartNumber(alt.partNumber)}`;
      if (!seen.has(k)) { seen.add(k); candidates.push(alt); }
    }
  }

  const confidence = confidenceFor(candidates, Boolean(machineRow));
  const rounds = e.agentRounds + 1;
  let escalate = proposal.escalate;
  const safety = candidates.find((c) => c.safetyCritical && c.role !== 'alternative');
  if (!escalate && safety) escalate = { reason: `${safety.description} is safety-critical: a person checks it with the customer before ordering`, urgency: e.priority === 'vor' ? 'vor' : 'normal' };
  if (!escalate && rounds >= MAX_AGENT_ROUNDS && confidence !== 'high') escalate = { reason: `No confident match after ${rounds} rounds`, urgency: e.priority === 'vor' ? 'vor' : 'normal' };
  if (!escalate && !candidates.length && !proposal.question) escalate = { reason: 'Couldn\'t find a part that matches', urgency: e.priority === 'vor' ? 'vor' : 'normal' };

  const question = escalate ? null : proposal.question;
  let reply = proposal.reply;
  if (reply && !replyIsGrounded(reply, candidates)) {
    extraNotes.push('Draft reply mentioned a part number we could not check; rewritten from the checked parts');
    reply = null;
  }
  const dueAt = escalate ? callbackDue(escalate.urgency === 'vor' || e.priority === 'vor' ? 'vor' : 'normal') : null;
  reply ??= composeReply({ candidates, question, escalate, dueAt, machine: machineRow ?? null });

  const result: EnquiryResult = {
    engine: proposal.engine, confidence, reply, question, candidates, escalate,
    notes: [...proposal.notes, ...extraNotes], at: new Date().toISOString(),
  };
  await ctx.db.update(enquiries).set({ result, agentRounds: rounds, updatedAt: new Date(), status: e.status === 'waiting_customer' ? 'open' : e.status }).where(eq(enquiries.id, e.id));
  if (escalate && e.status !== 'callback') await handOver(ctx, { ...e, priority: escalate.urgency === 'vor' ? 'vor' : e.priority }, escalate.reason, undefined, dueAt!);
  await audit(ctx, 'enquiry.agent_turn', 'enquiry', e.id, { ref: e.ref, engine: proposal.engine, confidence, candidates: candidates.map((c) => `${c.role}:${c.partNumber}`), escalated: Boolean(escalate) });
  return result;
}

// ---------------------------------------------------------------- building candidates

type CustomerRow = typeof customers.$inferSelect;
type MachineRow = Awaited<ReturnType<typeof machineRows>>[number];

async function buildCandidate(ctx: ServiceContext, pick: AgentPick, customer: CustomerRow | null, machine: MachineRow | null): Promise<EnquiryCandidate | null> {
  let r;
  try {
    r = await resolvePart(ctx, { partNumber: pick.partNumber, make: pick.make || undefined });
  } catch (e) {
    if (e instanceof AppError) return null;
    throw e;
  }
  const part = r.part;
  const evidence: EnquiryEvidence[] = [];
  const older = await predecessors(ctx, part.make, part.partNumberNorm);
  const asked = normalisePartNumber(pick.partNumber);

  if (pick.matchedBy === 'number') evidence.push({ kind: 'number', text: asked === part.partNumberNorm ? `Customer gave this number` : `Customer gave ${pick.partNumber}` });
  if (r.superseded || older.length) {
    const chain = await displayNumbers(ctx, part.make, r.superseded ? r.chain : [...[...older].reverse(), part.partNumberNorm]);
    evidence.push({ kind: 'supersession', text: `Replaces ${chain.slice(0, -1).join(' → ')}. ${r.straightSwap ? 'Straight swap.' : 'Fitting changes: check before fitting.'}` });
  }
  let fitAssembly: string | null = null;
  if (machine) {
    const [f] = await ctx.db
      .select()
      .from(partFitment)
      .where(and(eq(partFitment.tenantId, ctx.tenantId), eq(partFitment.machineModelId, machine.modelId), eq(partFitment.make, part.make), eq(partFitment.partNumberNorm, part.partNumberNorm)));
    if (f) {
      fitAssembly = f.assembly;
      const where = f.page ? `p${f.page}${f.figureRef ? ` · ${f.figureRef}` : ''}` : f.assembly ?? '';
      const verified = f.source !== 'sales_inferred';
      evidence.push({ kind: 'parts_book', text: `${verified ? 'Fits' : 'Probably fits'} the ${machine.make} ${machine.model}${f.serialFrom ? ` from serial ${f.serialFrom}` : ''}${f.serialTo ? ` to ${f.serialTo}` : ''}${verified ? '' : ' (from repeat sales, not verified)'}`, ref: where || undefined });
    }
  }
  if (customer) {
    const norms = [part.partNumberNorm, ...older];
    const hist = await ctx.db
      .select({ on: partSalesHistory.invoicedOn, machineId: partSalesHistory.machineId })
      .from(partSalesHistory)
      .where(and(eq(partSalesHistory.tenantId, ctx.tenantId), eq(partSalesHistory.customerId, customer.id), eq(partSalesHistory.make, part.make), inArray(partSalesHistory.partNumberNorm, norms)))
      .orderBy(desc(partSalesHistory.invoicedOn))
      .limit(10);
    if (hist.length) {
      const months = [...new Set(hist.map((h) => new Date(h.on).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })))].slice(0, 3);
      const forThis = machine && hist.some((h) => h.machineId === machine.id);
      evidence.push({ kind: 'history', text: `${customer.name} bought this ${hist.length === 1 ? 'once' : `${hist.length} times`}${forThis ? ' for this machine' : ''}: ${months.join(', ')}` });
    }
  }
  if (pick.matchedBy === 'described') evidence.push({ kind: 'described', text: pick.why });

  const price = customer ? await priceFor(ctx, part, customer) : null;
  const stock = ctx.can('stock:read') ? (await stockByDepot(ctx, part.id)).filter((s) => s.available > 0).map((s) => ({ depot: s.depotName, available: s.available })) : undefined;

  let guide: EnquiryCandidate['guide'] = null;
  let withIt: EnquiryCandidate['withIt'] = [];
  let bulletins: EnquiryCandidate['bulletins'] = [];
  if (ctx.can('guidance:read')) {
    try {
      const g = await guidanceForPart(ctx, { make: part.make, partNumber: part.partNumber, serial: machine?.serial });
      const bulletin = (x: (typeof g.procedures)[number]) => x.source.kind === 'service_bulletin';
      bulletins = g.procedures.filter(bulletin).map((x) => ({ code: x.code, title: x.title, summary: x.summary }));
      const p = g.procedures.find((x) => !bulletin(x));
      if (p) {
        guide = { procedureId: p.id, code: p.code, title: p.title, pages: p.pages, estMinutes: p.estMinutes };
        withIt = p.parts.filter((x) => x.partNumber !== part.partNumber && x.role === 'consumable').map((x) => ({ make: x.make, partNumber: x.partNumber, description: x.description, role: x.role, qty: x.qty }));
      }
    } catch (e) {
      if (!(e instanceof AppError)) throw e;
    }
  }

  return {
    make: part.make, partNumber: part.partNumber, description: part.description, role: pick.role, why: pick.why, evidence,
    requested: asked === part.partNumberNorm ? null : pick.partNumber, superseded: r.superseded, straightSwap: r.straightSwap, warning: r.warning,
    unitNetPence: price?.unitNetPence ?? part.listPricePence, priceBasis: price ? price.explanation : 'list price',
    stock, guide, withIt, bulletins,
    safetyCritical: SAFETY_CRITICAL.test(`${part.description} ${fitAssembly ?? ''}`),
  };
}

/** Part numbers as people write them (from the master), else a readable guess (ACM10021 -> ACM-10021). */
async function displayNumbers(ctx: ServiceContext, make: string, norms: string[]): Promise<string[]> {
  const rows = norms.length ? await ctx.db.select({ norm: parts.partNumberNorm, pn: parts.partNumber }).from(parts).where(and(eq(parts.tenantId, ctx.tenantId), eq(parts.make, make), inArray(parts.partNumberNorm, norms))) : [];
  const known = new Map(rows.map((r) => [r.norm, r.pn]));
  return norms.map((n) => known.get(n) ?? n.replace(/^([A-Z]+)(\d.*)$/, '$1-$2'));
}

/** Older numbers that lead to this one (walks the supersession table backwards). */
async function predecessors(ctx: ServiceContext, make: string, norm: string): Promise<string[]> {
  const rows = await ctx.db.select().from(partSupersessions).where(and(eq(partSupersessions.tenantId, ctx.tenantId), eq(partSupersessions.make, make)));
  const prev = new Map(rows.map((r) => [r.toPartNumberNorm, r.fromPartNumberNorm]));
  const out: string[] = [];
  let cur = norm;
  for (let i = 0; i < 20 && prev.has(cur); i++) {
    cur = prev.get(cur)!;
    if (out.includes(cur)) break;
    out.push(cur);
  }
  return out;
}

async function alternativesFor(ctx: ServiceContext, best: EnquiryCandidate): Promise<EnquiryCandidate[]> {
  const r = await resolvePart(ctx, { partNumber: best.partNumber, make: best.make });
  const eqs = await equivalents(ctx, r.part.id);
  return eqs.map((x) => ({
    make: x.make, partNumber: x.partNumber, description: x.description, role: 'alternative',
    why: x.verified ? 'Verified equivalent' : 'Suggested equivalent, not verified',
    evidence: [{ kind: 'equivalent', text: x.verified ? `Verified ${x.kind.replace('_', ' ')} ${best.partNumber}` : `Not verified: confirm before supplying` }],
  }));
}

/**
 * high: the customer's number, or three independent sources agree.
 * medium: two sources, or a choice between parts that fit.
 * low: one source, or nothing checked against the machine.
 */
export function confidenceFor(candidates: EnquiryCandidate[], machineKnown: boolean): 'high' | 'medium' | 'low' {
  const best = candidates.find((c) => c.role === 'best');
  if (!best) return candidates.some((c) => c.role === 'option') && machineKnown ? 'medium' : 'low';
  const kinds = new Set(best.evidence.map((e) => e.kind));
  let score = 0;
  if (kinds.has('number')) score += 3;
  if (best.evidence.some((e) => e.kind === 'parts_book' && e.text.startsWith('Fits'))) score += 1;
  else if (kinds.has('parts_book')) score += 0.5;
  if (kinds.has('history')) score += 1;
  if (kinds.has('described')) score += 1;
  if (!machineKnown && !kinds.has('number')) score = Math.min(score, 2);
  return score >= 3 ? 'high' : score >= 2 ? 'medium' : 'low';
}

/** Any part-number-looking token in the reply must be one we checked (or an older number it replaces). */
function replyIsGrounded(reply: string, candidates: EnquiryCandidate[]): boolean {
  const ok = new Set<string>();
  for (const c of candidates) {
    ok.add(normalisePartNumber(c.partNumber));
    if (c.requested) ok.add(normalisePartNumber(c.requested));
    for (const e of c.evidence) for (const m of e.text.match(/[A-Z]{2,4}-?\d{3,}[A-Z]?/g) ?? []) ok.add(normalisePartNumber(m));
    for (const w of c.withIt ?? []) ok.add(normalisePartNumber(w.partNumber));
  }
  const tokens = reply.match(/\b[A-Za-z]{2,4}[- ]?\d{3,}[A-Za-z]?\b/g) ?? [];
  return tokens.every((t) => !looksLikePartNumber(t) || ok.has(normalisePartNumber(t)));
}

function callbackDue(urgency: 'vor' | 'normal', from = new Date()): Date {
  return new Date(from.getTime() + CALLBACK_MINUTES[urgency] * 60_000);
}

const hhmm = (d: Date) => d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' });

function composeReply(o: { candidates: EnquiryCandidate[]; question: string | null; escalate: { reason: string } | null; dueAt: Date | null; machine: MachineRow | null }): string {
  if (o.escalate) {
    const safety = /safety-critical/.test(o.escalate.reason);
    return safety
      ? `That's a safety part, so someone in parts will check it with you before we order. They'll ring you by ${hhmm(o.dueAt!)}.`
      : `I want a person to check this one rather than guess. Someone in parts will ring you by ${hhmm(o.dueAt!)}.`;
  }
  if (o.question) return o.machine ? `For your ${o.machine.model}: ${o.question}` : o.question;
  const best = o.candidates.find((c) => c.role === 'best');
  if (!best) return 'What machine is it for? A serial number or a photo of the plate is best.';
  const parts = [`It's ${best.partNumber}, ${best.description.charAt(0).toLowerCase()}${best.description.slice(1)}.`];
  const sup = best.evidence.find((e) => e.kind === 'supersession');
  if (sup) parts.push(sup.text);
  const stock = best.stock?.filter((s) => s.available > 0) ?? [];
  if (stock.length) parts.push(`${stock.slice(0, 2).map((s) => `${s.available} at ${s.depot}`).join(', ')}.`);
  else if (best.stock) parts.push('None in stock: I\'ll check the supplier and come back to you.');
  return parts.join(' ');
}

async function handOver(ctx: ServiceContext, e: typeof enquiries.$inferSelect, reason: string, assignee?: string, due?: Date) {
  const dueAt = due ?? callbackDue(e.priority === 'vor' ? 'vor' : 'normal');
  const who = assignee?.trim() || 'Parts team';
  await ctx.db
    .update(enquiries)
    .set({ status: 'callback', priority: e.priority, callbackDueAt: dueAt, callbackReason: reason, assignedTo: who, updatedAt: new Date() })
    .where(and(eq(enquiries.id, e.id), ne(enquiries.status, 'resolved')));
  await ctx.db.insert(enquiryMessages).values({ tenantId: ctx.tenantId, enquiryId: e.id, role: 'system', body: `Handed to ${who}: ${reason}. Callback by ${hhmm(dueAt)}.` });
  await audit(ctx, 'enquiry.callback_requested', 'enquiry', e.id, { ref: e.ref, reason, assignee: who, dueAt: dueAt.toISOString() });
}

// ---------------------------------------------------------------- direct find (no enquiry)

/**
 * The guided "Find a part" flow: machine -> what the user says -> checked
 * candidates. Same engines and the same checks as an enquiry, but nothing is
 * stored: the user is the one looking, so there's no reply to draft and no
 * callback. Safety-critical parts are still flagged for a person to confirm.
 */
export const FindPartSchema = z.object({
  serial: z.string().trim().min(1).optional(),
  /** The conversation, oldest first. A plain string is something the user said. */
  messages: z
    .array(z.union([z.string().trim().min(1).max(2000), z.object({ role: z.enum(['user', 'assistant']), body: z.string().trim().min(1).max(4000) })]))
    .min(1)
    .max(30),
});

/** Which engine answers a guided find, and whether it's connected. */
export function findEngineStatus() {
  if (claudeAvailable()) return { engine: 'claude' as const, connected: true, detail: 'Claude API' };
  const local = localStatus();
  if (process.env.PARTS_AGENT_ENGINE !== 'rules' && process.env.PARTS_AGENT_ENGINE !== 'api') {
    return { engine: 'claude-local' as const, connected: local.available, detail: local.lastFailure ?? 'Claude through this computer\'s Claude Code sign-in' };
  }
  return { engine: 'rules' as const, connected: true, detail: 'Offline matcher' };
}

export async function findPart(ctx: ServiceContext, raw: z.input<typeof FindPartSchema>, onProgress?: AgentProgress) {
  ctx.require('parts:read');
  const input = FindPartSchema.parse(raw);
  let [machine] = input.serial ? await machineRows(ctx, eq(machines.serial, input.serial)) : [];
  if (input.serial && !machine) throw notFound('Machine', input.serial);
  const loadCustomer = async (m: typeof machine) => (m?.customerId ? (await ctx.db.select().from(customers).where(eq(customers.id, m.customerId)))[0] : undefined);
  let customer = await loadCustomer(machine);

  const messages = input.messages.map((m) => (typeof m === 'string' ? { role: 'customer', body: m } : { role: m.role === 'user' ? 'customer' : 'assistant', body: m.body }));
  const agentInput: AgentInput = {
    ctx, channel: 'web', priority: 'normal',
    customer: customer ? { id: customer.id, accountCode: customer.accountCode, name: customer.name } : null,
    machine: machine ? asAgentMachine(machine) : null,
    customerMachines: machine ? [asAgentMachine(machine)] : [],
    messages,
    rounds: messages.filter((m) => m.role === 'customer').length - 1,
  };
  const notes: string[] = [];
  let proposal: AgentProposal | null = null;
  const engines = [claudeAvailable() ? claudeEngine : null, !claudeAvailable() && localAvailable() ? localEngine : null].filter(Boolean) as PartsAgentEngine[];
  for (const engine of engines) {
    try {
      proposal = await engine.propose(agentInput, onProgress);
      break;
    } catch (err) {
      notes.push(`${engine.name === 'claude-local' ? 'Local Claude' : 'Claude'} unavailable (${err instanceof Error ? err.message : String(err)}); used the offline matcher`);
    }
  }
  if (!proposal) {
    onProgress?.('Checking the parts book');
    proposal = await rulesEngine.propose(agentInput);
  }

  // The machine, if the engine identified one in our records.
  if (!machine && proposal.machineSerial) {
    [machine] = await machineRows(ctx, eq(machines.serial, proposal.machineSerial));
    if (machine) customer = await loadCustomer(machine);
    else notes.push(`Ignored machine ${proposal.machineSerial}: not in our records`);
  }

  const candidates: EnquiryCandidate[] = [];
  const seen = new Set<string>();
  for (const pick of proposal.picks) {
    const c = await buildCandidate(ctx, pick, customer ?? null, machine ?? null);
    if (!c) { notes.push(`Dropped ${pick.make} ${pick.partNumber}: not in the catalogue`); continue; }
    const k = `${c.make}|${normalisePartNumber(c.partNumber)}`;
    if (seen.has(k)) continue;
    seen.add(k);
    candidates.push(c);
  }
  // A web finding that turns out to be in our catalogue becomes a checked candidate.
  const web = [];
  for (const w of proposal.web ?? []) {
    const c = await buildCandidate(ctx, { make: w.make, partNumber: w.partNumber, role: candidates.some((x) => x.role === 'best') ? 'option' : 'best', why: w.note, matchedBy: 'described' }, customer ?? null, machine ?? null);
    const k = c ? `${c.make}|${normalisePartNumber(c.partNumber)}` : '';
    if (c && !seen.has(k)) { seen.add(k); candidates.push(c); } else if (!c) web.push(w);
  }
  const confidence = confidenceFor(candidates, Boolean(machine));
  const safety = candidates.find((c) => c.safetyCritical);
  const needsPerson = proposal.escalate?.reason
    ?? (safety ? `${safety.description} is safety-critical: the parts desk confirms it before it's supplied` : null)
    ?? (!candidates.length && !web.length && !proposal.question && !proposal.reply ? "Couldn't find a part that matches" : null);
  return {
    machine: machine ? { serial: machine.serial, make: machine.make, model: machine.model, kind: machine.kind, year: machine.year } : null,
    machineText: proposal.machineText ?? null,
    engine: proposal.engine,
    confidence,
    reply: proposal.reply ?? composeReply({ candidates, question: proposal.question, escalate: null, dueAt: null, machine: machine ?? null }),
    question: proposal.question,
    candidates,
    web,
    needsPerson,
    notes: [...proposal.notes, ...notes],
  };
}

/** Everything about one part for the part page: evidence, price, stock, guide. */
export async function partCard(ctx: ServiceContext, input: { make: string; partNumber: string; serial?: string | undefined }) {
  ctx.require('parts:read');
  const [machine] = input.serial ? await machineRows(ctx, eq(machines.serial, input.serial)) : [];
  if (input.serial && !machine) throw notFound('Machine', input.serial);
  const [customer] = machine?.customerId ? await ctx.db.select().from(customers).where(eq(customers.id, machine.customerId)) : [];
  const card = await buildCandidate(ctx, { make: input.make, partNumber: input.partNumber, role: 'best', why: 'Chosen from the machine', matchedBy: 'machine' }, customer ?? null, machine ?? null);
  if (!card) throw notFound('Part', input.partNumber);
  const fits = card.evidence.some((e) => e.kind === 'parts_book');
  return {
    machine: machine ? { serial: machine.serial, make: machine.make, model: machine.model, kind: machine.kind, year: machine.year, customer: customer?.name ?? null } : null,
    fitsMachine: machine ? fits : null,
    part: card,
  };
}
