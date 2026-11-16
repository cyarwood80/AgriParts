/**
 * Field guidance: licensed manufacturer procedures aligned to the part being
 * swapped and the machine it goes on, and offline "job packs" for engineers
 * working where there's no signal.
 *
 * Rules
 *  - Licensed or invisible. Expired licences hide content (and we say how
 *    much was withheld rather than pretending there's nothing).
 *  - Purpose matters: `offline` only includes licences with allowOffline,
 *    `ai` only licences with allowAi.
 *  - Lookup goes through the supersession chain, so an engineer holding the
 *    old number still finds the manual, and the new part's procedure.
 *  - Specs are returned verbatim with page references. Never estimate.
 */
import { createHash } from 'node:crypto';
import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  contentLicences, customers, guidancePacks, machineModels, machines, partFitment, parts,
  procedureParts, procedureSteps, procedures, serviceDocuments, stockLevels,
} from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { normalisePartNumber } from '../lib/part-number.js';
import { audit, nextNumber, type ServiceContext } from './context.js';
import { resolvePart, type PartRef } from './parts.js';

export type GuidancePurpose = 'view' | 'offline' | 'ai';

export const SPEC_RULE =
  'Quote specs exactly as written, with the document reference and page. If a procedure does not cover the job, say so and escalate to the workshop. Never estimate a torque, pressure or capacity.';

const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- machines

export async function searchMachines(ctx: ServiceContext, query: string, limit = 10) {
  ctx.require('guidance:read');
  const q = `%${query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return ctx.db
    .select({
      serial: machines.serial,
      regNo: machines.regNo,
      year: machines.year,
      engineHours: machines.engineHours,
      site: machines.site,
      make: machineModels.make,
      model: machineModels.model,
      kind: machineModels.kind,
      customer: customers.accountCode,
      customerName: customers.name,
    })
    .from(machines)
    .innerJoin(machineModels, eq(machineModels.id, machines.machineModelId))
    .leftJoin(customers, eq(customers.id, machines.customerId))
    .where(
      and(
        eq(machines.tenantId, ctx.tenantId),
        or(ilike(machines.serial, q), ilike(machines.regNo, q), ilike(customers.name, q), ilike(customers.accountCode, q), ilike(machineModels.model, q)),
      ),
    )
    .orderBy(asc(customers.name), asc(machines.serial))
    .limit(Math.min(limit, 50));
}

async function loadMachine(ctx: ServiceContext, serial: string) {
  const [row] = await ctx.db
    .select({ machine: machines, model: machineModels, customer: { accountCode: customers.accountCode, name: customers.name, phone: customers.phone } })
    .from(machines)
    .innerJoin(machineModels, eq(machineModels.id, machines.machineModelId))
    .leftJoin(customers, eq(customers.id, machines.customerId))
    .where(and(eq(machines.tenantId, ctx.tenantId), eq(machines.serial, serial.trim())));
  if (!row) throw notFound('Machine', serial);
  return row;
}

/** A machine with the parts that fit it, and which of them have licensed guidance. */
export async function machineDetail(ctx: ServiceContext, serial: string) {
  ctx.require('guidance:read');
  const { machine, model, customer } = await loadMachine(ctx, serial);
  const fitAll = await ctx.db
    .select()
    .from(partFitment)
    .where(and(eq(partFitment.tenantId, ctx.tenantId), eq(partFitment.machineModelId, model.id)))
    .orderBy(asc(partFitment.assembly), asc(partFitment.partNumberNorm));
  // Serial breaks: drop lines whose range excludes this machine.
  const fit = fitAll.filter((f) => serialInRange(machine.serial, f.serialFrom, f.serialTo));
  const norms = fit.map((f) => f.partNumberNorm);
  const master = norms.length
    ? await ctx.db.select().from(parts).where(and(eq(parts.tenantId, ctx.tenantId), inArray(parts.partNumberNorm, norms)))
    : [];
  const byKey = new Map(master.map((p) => [`${p.make}|${p.partNumberNorm}`, p]));
  const covered = norms.length
    ? await ctx.db
        .selectDistinct({ make: procedureParts.make, norm: procedureParts.partNumberNorm })
        .from(procedureParts)
        .innerJoin(procedures, eq(procedures.id, procedureParts.procedureId))
        .innerJoin(serviceDocuments, eq(serviceDocuments.id, procedures.documentId))
        .innerJoin(contentLicences, eq(contentLicences.id, serviceDocuments.licenceId))
        .where(and(eq(procedureParts.tenantId, ctx.tenantId), inArray(procedureParts.partNumberNorm, norms), published(), licenceLive(), modelMatches(model.id)))
    : [];
  const hasGuide = new Set(covered.map((c) => `${c.make}|${c.norm}`));
  return {
    serial: machine.serial,
    regNo: machine.regNo,
    year: machine.year,
    engineHours: machine.engineHours,
    site: machine.site,
    model: { make: model.make, model: model.model, series: model.series, kind: model.kind },
    customer,
    fittedParts: fit.map((f) => {
      const p = byKey.get(`${f.make}|${f.partNumberNorm}`);
      return {
        make: f.make,
        partNumber: p?.partNumber ?? f.partNumberNorm,
        description: p?.description ?? null,
        assembly: f.assembly,
        qtyPerMachine: f.qtyPerMachine,
        inMaster: Boolean(p),
        hasGuidance: hasGuide.has(`${f.make}|${f.partNumberNorm}`),
        fitmentSource: f.source,
        verified: f.source === 'parts_book' || f.source === 'oem_epc' || f.source === 'seed' || Boolean(f.verifiedBy),
        confidence: f.confidence,
        serialRange: f.serialFrom || f.serialTo ? `${f.serialFrom ?? '*'}-${f.serialTo ?? '*'}` : null,
        reference: f.page ? `p${f.page}${f.figureRef ? ` ${f.figureRef}` : ''}` : null,
      };
    }),
  };
}

/**
 * Serial-break check. Serials compare numerically within a shared prefix
 * ("J002198" < "J010000"). If the prefixes differ the range can't be judged,
 * so the line is kept rather than hidden.
 */
export function serialInRange(serial: string, from: string | null, to: string | null): boolean {
  const split = (s: string) => /^(.*?)(\d+)$/.exec(s.replace(/[\s-]/g, '').toUpperCase());
  const s = split(serial);
  const check = (bound: string, dir: 1 | -1) => {
    const b = split(bound);
    if (!s || !b) return true;
    const sp = s[1]!.slice(-b[1]!.length);
    if (b[1] && sp !== b[1]) return true;
    return dir * (Number(s[2]) - Number(b[2])) >= 0;
  };
  return (!from || check(from, 1)) && (!to || check(to, -1));
}

// ---------------------------------------------------------------- guidance

/** Engineers, packs and agents only ever see foreman-verified, published procedures (ADR-0005). */
function published() {
  return eq(procedures.status, 'published');
}
function licenceLive() {
  return or(isNull(contentLicences.expiresOn), sql`${contentLicences.expiresOn} >= ${today()}`)!;
}
function modelMatches(machineModelId?: string) {
  return machineModelId ? or(isNull(procedures.machineModelId), eq(procedures.machineModelId, machineModelId))! : sql`true`;
}

interface Found {
  procedure: typeof procedures.$inferSelect;
  document: typeof serviceDocuments.$inferSelect;
  licence: typeof contentLicences.$inferSelect;
}

/** Procedures that touch any of these (make, normalised number) pairs. */
async function proceduresFor(ctx: ServiceContext, make: string, norms: string[], machineModelId: string | undefined) {
  const rows = await ctx.db
    .selectDistinctOn([procedures.id], { procedure: procedures, document: serviceDocuments, licence: contentLicences })
    .from(procedureParts)
    .innerJoin(procedures, eq(procedures.id, procedureParts.procedureId))
    .innerJoin(serviceDocuments, eq(serviceDocuments.id, procedures.documentId))
    .innerJoin(contentLicences, eq(contentLicences.id, serviceDocuments.licenceId))
    .where(and(eq(procedureParts.tenantId, ctx.tenantId), eq(procedureParts.make, make), inArray(procedureParts.partNumberNorm, norms), published(), modelMatches(machineModelId)))
    .orderBy(procedures.id);
  return rows as Found[];
}

async function expandProcedures(ctx: ServiceContext, found: Found[]) {
  if (!found.length) return [];
  const ids = found.map((f) => f.procedure.id);
  const steps = await ctx.db.select().from(procedureSteps).where(inArray(procedureSteps.procedureId, ids)).orderBy(asc(procedureSteps.seq));
  const pp = await ctx.db.select().from(procedureParts).where(inArray(procedureParts.procedureId, ids));
  const norms = [...new Set(pp.map((p) => p.partNumberNorm))];
  const master = norms.length ? await ctx.db.select().from(parts).where(and(eq(parts.tenantId, ctx.tenantId), inArray(parts.partNumberNorm, norms))) : [];
  const byKey = new Map(master.map((p) => [`${p.make}|${p.partNumberNorm}`, p]));
  const stock = master.length && ctx.can('stock:read')
    ? await ctx.db
        .select({ partId: stockLevels.partId, available: sql<number>`sum(${stockLevels.onHand} - ${stockLevels.allocated})`.mapWith(Number) })
        .from(stockLevels)
        .where(and(eq(stockLevels.tenantId, ctx.tenantId), inArray(stockLevels.partId, master.map((p) => p.id))))
        .groupBy(stockLevels.partId)
    : [];
  const avail = new Map(stock.map((s) => [s.partId, s.available]));
  const roleOrder = { replaced: 0, consumable: 1, may_need: 2 } as Record<string, number>;

  return found.map(({ procedure: p, document: d, licence: l }) => ({
    id: p.id,
    code: p.code,
    title: p.title,
    summary: p.summary,
    estMinutes: p.estMinutes,
    skill: p.skill,
    pages: p.pageFrom ? (p.pageTo && p.pageTo !== p.pageFrom ? `${p.pageFrom}-${p.pageTo}` : `${p.pageFrom}`) : null,
    tools: p.tools,
    safety: p.safety,
    source: {
      documentId: d.id,
      publisher: l.publisher,
      document: d.title,
      docRef: d.docRef,
      revision: d.revision,
      kind: d.kind,
      publishedOn: d.publishedOn,
    },
    licence: { title: l.title, reference: l.reference, allowOffline: l.allowOffline, allowAi: l.allowAi, expiresOn: l.expiresOn, offlineDays: l.offlineDays },
    parts: pp
      .filter((x) => x.procedureId === p.id)
      .sort((a, b) => (roleOrder[a.role] ?? 9) - (roleOrder[b.role] ?? 9))
      .map((x) => {
        const m = byKey.get(`${x.make}|${x.partNumberNorm}`);
        return {
          make: x.make,
          partNumber: m?.partNumber ?? x.partNumberNorm,
          description: m?.description ?? null,
          role: x.role,
          qty: x.qty,
          available: m && ctx.can('stock:read') ? (avail.get(m.id) ?? 0) : undefined,
        };
      }),
    steps: steps
      .filter((s) => s.procedureId === p.id)
      .map((s) => ({ seq: s.seq, instruction: s.instruction, page: s.page, specs: s.specs, caution: s.caution })),
  }));
}

function allowedFor(purpose: GuidancePurpose, l: typeof contentLicences.$inferSelect): boolean {
  if (l.expiresOn && l.expiresOn < today()) return false;
  if (purpose === 'offline') return l.allowOffline;
  if (purpose === 'ai') return l.allowAi;
  return true;
}

function withheldReason(purpose: GuidancePurpose, l: typeof contentLicences.$inferSelect): string {
  if (l.expiresOn && l.expiresOn < today()) return `Licence "${l.title}" expired ${l.expiresOn}`;
  if (purpose === 'offline') return `Licence "${l.title}" does not permit offline copies (view online only)`;
  if (purpose === 'ai') return `Licence "${l.title}" does not permit AI use`;
  return 'Not licensed';
}

/**
 * Guidance for the part being fitted. Follows supersessions both ways along
 * the chain, so the procedure for the old and new number are both found.
 */
export async function guidanceForPart(
  ctx: ServiceContext,
  ref: PartRef & { serial?: string | undefined; purpose?: GuidancePurpose },
) {
  ctx.require('guidance:read');
  const purpose = ref.purpose ?? 'view';
  const resolved = await resolvePart(ctx, ref);
  const machine = ref.serial ? await loadMachine(ctx, ref.serial) : undefined;
  const norms = [...new Set([normalisePartNumber(ref.partNumber), ...resolved.chain])];
  const found = await proceduresFor(ctx, resolved.part.make, norms, machine?.model.id);
  const usable = found.filter((f) => allowedFor(purpose, f.licence));
  const withheld = found
    .filter((f) => !allowedFor(purpose, f.licence))
    .map((f) => ({ code: f.procedure.code, title: f.procedure.title, reason: withheldReason(purpose, f.licence) }));
  const procs = await expandProcedures(ctx, usable);
  // Model-specific procedures first, then by code.
  procs.sort((a, b) => a.code.localeCompare(b.code));
  return {
    part: { make: resolved.part.make, partNumber: resolved.part.partNumber, description: resolved.part.description },
    requested: ref.partNumber,
    superseded: resolved.superseded,
    straightSwap: resolved.straightSwap,
    warning: resolved.warning,
    machine: machine ? { serial: machine.machine.serial, make: machine.model.make, model: machine.model.model } : null,
    coverage: procs.length ? 'licensed' : withheld.length ? 'withheld' : 'none',
    procedures: procs,
    withheld,
    rule: procs.length ? SPEC_RULE : 'No licensed instructions for this part. Say so and escalate to the workshop.',
  };
}

// ---------------------------------------------------------------- offline packs

export interface JobPackInput {
  serial: string;
  parts: PartRef[];
  jobRef?: string | undefined;
}

/**
 * Build and record an offline job pack: machine, parts, and every licensed
 * procedure that allows offline copies. Expiry is the shortest of the
 * licences' offline windows and their end dates. Issuance is audited.
 */
export async function issueJobPack(ctx: ServiceContext, input: JobPackInput) {
  ctx.require('guidance:read');
  if (!input.parts.length) throw new AppError('VALIDATION', 'A job pack needs at least one part');
  if (input.parts.length > 30) throw new AppError('VALIDATION', 'A job pack can hold at most 30 parts');
  const machine = await machineDetail(ctx, input.serial);

  const results: Awaited<ReturnType<typeof guidanceForPart>>[] = [];
  for (const p of input.parts) results.push(await guidanceForPart(ctx, { ...p, serial: input.serial, purpose: 'offline' }));

  const procedures = new Map<string, (typeof results)[number]['procedures'][number]>();
  const onlineOnly = new Map<string, { code: string; title: string; reason: string }>();
  for (const r of results) {
    for (const pr of r.procedures) procedures.set(pr.id, pr);
    for (const w of r.withheld) onlineOnly.set(w.code, w);
  }
  const procList = [...procedures.values()].sort((a, b) => a.code.localeCompare(b.code));

  const now = Date.now();
  let expires = now + 14 * 86_400_000;
  for (const pr of procList) {
    expires = Math.min(expires, now + pr.licence.offlineDays * 86_400_000);
    if (pr.licence.expiresOn) expires = Math.min(expires, Date.parse(`${pr.licence.expiresOn}T23:59:59Z`));
  }
  const expiresAt = new Date(expires);

  const content = {
    machine,
    parts: results.map((r) => ({
      requested: r.requested,
      supplied: r.part,
      superseded: r.superseded,
      warning: r.warning,
      procedureCodes: r.procedures.map((x) => x.code),
      coverage: r.coverage,
    })),
    procedures: procList,
    onlineOnly: [...onlineOnly.values()],
    rule: SPEC_RULE,
  };
  const contentHash = createHash('sha256').update(JSON.stringify(content)).digest('hex');

  return ctx.transaction(async (tx) => {
    const packRef = await nextNumber(tx, 'guidance_pack', 'GP');
    const [row] = await tx.db
      .insert(guidancePacks)
      .values({
        tenantId: tx.tenantId,
        packRef,
        issuedTo: tx.actorLabel,
        machineId: (await loadMachine(tx, input.serial)).machine.id,
        jobRef: input.jobRef,
        partNumbers: results.map((r) => `${r.part.make}/${r.part.partNumber}`),
        procedureIds: procList.map((p) => p.id),
        contentHash,
        expiresAt,
      })
      .returning();
    await audit(tx, 'guidance.pack_issued', 'guidance_pack', row!.id, { packRef, serial: input.serial, procedures: procList.map((p) => p.code), expiresAt: expiresAt.toISOString() });
    return {
      packRef,
      jobRef: input.jobRef ?? null,
      issuedTo: tx.actorLabel,
      issuedAt: row!.issuedAt,
      expiresAt,
      contentHash,
      watermark: `${packRef} · issued to ${tx.actorLabel} · expires ${expiresAt.toISOString().slice(0, 10)}`,
      ...content,
    };
  });
}

/** Devices call this when they get signal: is my pack still valid? */
export async function packStatus(ctx: ServiceContext, packRef: string) {
  ctx.require('guidance:read');
  const [p] = await ctx.db.select().from(guidancePacks).where(and(eq(guidancePacks.tenantId, ctx.tenantId), eq(guidancePacks.packRef, packRef)));
  if (!p) throw notFound('Guidance pack', packRef);
  const expired = p.expiresAt.getTime() < Date.now();
  return {
    packRef: p.packRef,
    issuedAt: p.issuedAt,
    expiresAt: p.expiresAt,
    revoked: Boolean(p.revokedAt),
    valid: !expired && !p.revokedAt,
    reason: p.revokedAt ? 'Revoked: delete the local copy' : expired ? 'Expired: re-download while online' : null,
  };
}

export async function listPacks(ctx: ServiceContext, limit = 25) {
  ctx.require('guidance:read');
  return ctx.db
    .select({ packRef: guidancePacks.packRef, issuedTo: guidancePacks.issuedTo, jobRef: guidancePacks.jobRef, partNumbers: guidancePacks.partNumbers, issuedAt: guidancePacks.issuedAt, expiresAt: guidancePacks.expiresAt, revokedAt: guidancePacks.revokedAt, serial: machines.serial })
    .from(guidancePacks)
    .leftJoin(machines, eq(machines.id, guidancePacks.machineId))
    .where(eq(guidancePacks.tenantId, ctx.tenantId))
    .orderBy(sql`${guidancePacks.issuedAt} DESC`)
    .limit(Math.min(limit, 100));
}
