/**
 * The offline parts agent: no model, just our data. Used when there's no
 * ANTHROPIC_API_KEY, when the model call fails, and as the baseline the
 * Claude engine has to beat on the eval set.
 *
 * Order: identify the machine -> numbers the customer gave -> words matched
 * against the machine's fitted parts -> catalogue search. One question at a
 * time when two parts fit the description equally well.
 */
import { AppError } from '../../lib/errors.js';
import { looksLikePartNumber, normalisePartNumber } from '../../lib/part-number.js';
import { machineDetail } from '../../services/guidance.js';
import { resolvePart, searchParts } from '../../services/parts.js';
import type { AgentInput, AgentMachine, AgentPick, AgentProposal, PartsAgentEngine } from './types.js';

const STOP = new Set([
  'a', 'an', 'the', 'for', 'on', 'my', 'our', 'his', 'her', 'it', 'its', 'is', 'are', 'to', 'of', 'and', 'or', 'need', 'needs', 'want', 'wants', 'please',
  'one', 'ones', 'some', 'new', 'got', 'have', 'has', 'can', 'you', 'i', 'we', 'me', 'us', 'do', 'any', 'in', 'by', 'with', 'from', 'this', 'that', 'there',
  'about', 'just', 'bit', 'down', 'low', 'left', 'right', 'side', 'front', 'back', 'rear', 'blue', 'black', 'red', 'green', 'yellow', 'thanks', 'cheers',
  'today', 'asap', 'urgent', 'mate', 'hi', 'hello', 'morning', 'tractor', 'machine', 'part', 'parts', 'off', 'next', 'last', 'time', 'same', 'again',
  'spin', 'it\'s', 'thing', 'stopped', 'broke', 'broken', 'gone', 'flying', 'keep', 'keeps', 'like', 'old', 'when', 'what', 'which', 'did', 'was',
]);

/** Farm words -> catalogue words. Keys are what people say; values are what descriptions say. */
const SYNONYMS: Record<string, string[]> = {
  flail: ['hammer'], flails: ['hammer'], hammers: ['hammer'], blades: ['hammer', 'blade'],
  wiper: ['wiper'], wipers: ['wiper'], screen: ['wiper'],
  diesel: ['fuel'], water: ['fuel'], sedimenter: ['fuel'],
  hyd: ['hydraulic'], hydraulics: ['hydraulic'], transmission: ['hydraulic', 'transmission'],
  knotter: ['knotter'], knotters: ['knotter'], bill: ['bill', 'hook'], billhook: ['bill', 'hook'],
  tines: ['tine'], pickup: ['pick-up', 'tine'], knife: ['knife'], twine: ['twine'],
  bearing: ['bearing'], bearings: ['bearing'], rotor: ['rotor'],
  seat: ['seat'], toplink: ['top', 'link'], link: ['link'],
  filter: ['filter'], filters: ['filter'], oil: ['oil'], air: ['air'], element: ['element'],
};

/** Words that mean a different part from the one described, used to split near-ties. */
const SPLITTERS = ['primary', 'secondary', 'outer', 'inner', 'early', 'late', '80mm', '100mm'];

export function queryWords(text: string): string[] {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w) && !/^\d+$/.test(w));
  const out = new Set<string>();
  for (const w of words) {
    out.add(w);
    for (const s of SYNONYMS[w] ?? []) out.add(s);
  }
  return [...out];
}

function haystack(...parts: (string | null | undefined)[]) {
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/** Which machine is this about? Exact serial, then reg, then model words among the customer's machines. */
export function pickMachine(text: string, machines: AgentMachine[]): AgentMachine | null {
  if (!machines.length) return null;
  const t = text.toLowerCase();
  const bySerial = machines.find((m) => t.includes(m.serial.toLowerCase()) || t.includes(m.serial.toLowerCase().split('-').pop()!));
  if (bySerial) return bySerial;
  const scored = machines
    .map((m) => {
      const modelBits = m.model.toLowerCase().split(/[\s-]+/).filter((b) => b.length >= 2);
      let score = 0;
      for (const b of modelBits) if (new RegExp(`(^|[^a-z0-9])${b.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`).test(t)) score += /\d/.test(b) ? 3 : 1;
      if (m.kind && t.includes(m.kind.toLowerCase())) score += 2;
      for (const w of KIND_WORDS[m.kind?.toLowerCase() ?? ''] ?? []) if (t.includes(w)) score += 2;
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);
  if (scored.length && (scored.length === 1 || scored[0]!.score > scored[1]!.score)) return scored[0]!.m;
  return machines.length === 1 ? machines[0]! : null;
}

const KIND_WORDS: Record<string, string[]> = {
  hedgecutter: ['flail', 'hedge', 'hammer'],
  'small square baler': ['baler', 'knotter', 'bale', 'twine', 'pick-up', 'pickup'],
  tractor: ['tractor', 'engine', 'cab'],
};

function numbersIn(text: string): string[] {
  const tokens = text.split(/[\s,;]+/).map((t) => t.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, ''));
  const out: string[] = [];
  // "acm 10021" written with a space: join a make-like word with the number after it.
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]!;
    const next = tokens[i + 1];
    if (/^[A-Za-z]{2,4}$/.test(t) && next && /^\d{3,}[A-Za-z]?$/.test(next)) {
      out.push(`${t}-${next}`);
      i++;
    } else if (looksLikePartNumber(t) && /[A-Za-z]/.test(t) && /\d{3,}/.test(t)) out.push(t);
  }
  return [...new Set(out)];
}

export const rulesEngine: PartsAgentEngine = {
  name: 'rules',
  async propose(input: AgentInput): Promise<AgentProposal> {
    const { ctx } = input;
    const notes: string[] = [];
    const customerText = input.messages.filter((m) => m.role === 'customer').map((m) => m.body).join('\n');
    const latest = [...input.messages].reverse().find((m) => m.role === 'customer')?.body ?? '';

    // 1. The machine.
    const machine = input.machine ?? pickMachine(customerText, input.customerMachines);
    if (machine && !input.machine) notes.push(`Machine identified from the conversation: ${machine.make} ${machine.model} ${machine.serial}`);

    // 2. Numbers the customer gave.
    const picks: AgentPick[] = [];
    for (const raw of numbersIn(customerText)) {
      try {
        const r = await resolvePart(ctx, { partNumber: raw, make: machine?.make });
        picks.push({ make: r.part.make, partNumber: r.part.partNumber, role: 'best', why: `Customer gave ${raw}`, matchedBy: 'number' });
      } catch (e) {
        if (!(e instanceof AppError)) throw e;
        notes.push(`${raw} isn't in the catalogue`);
      }
    }
    if (picks.length) return { engine: 'rules', machineSerial: machine?.serial ?? null, picks: dedupe(picks), question: null, reply: null, escalate: null, notes };

    // Which machine, if the customer has several and we can't tell.
    if (!machine && input.customerMachines.length > 1) {
      const list = input.customerMachines.map((m) => `${m.model} (${m.serial.split('-').pop()})`);
      return {
        engine: 'rules', machineSerial: null, picks: [], reply: null, escalate: null, notes,
        question: `Which machine is it for: ${list.slice(0, -1).join(', ')} or ${list.at(-1)}?`,
      };
    }

    // 3. Words against the machine's fitted parts. Latest message counts double: it usually answers our question.
    const words = queryWords(customerText);
    const latestWords = new Set(queryWords(latest));
    if (machine) {
      const detail = await machineDetail(ctx, machine.serial);
      const scored = detail.fittedParts
        .filter((f) => f.inMaster)
        .map((f) => {
          const hay = haystack(f.description, f.assembly);
          let score = 0;
          for (const w of words) if (hay.includes(w)) score += latestWords.has(w) ? 2 : 1;
          return { f, score };
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score);
      if (scored.length) {
        const top = scored[0]!.score;
        const tied = scored.filter((x) => x.score === top);
        if (tied.length === 1) {
          const f = tied[0]!.f;
          picks.push({ make: f.make, partNumber: f.partNumber, role: 'best', why: `Matches "${words.filter((w) => haystack(f.description, f.assembly).includes(w)).join(' ')}" on this ${machine.model}`, matchedBy: 'described' });
          return { engine: 'rules', machineSerial: machine.serial, picks, question: null, reply: null, escalate: null, notes };
        }
        // Near-tie: ask the one question that splits them.
        const options = tied.slice(0, 3);
        for (const o of options) picks.push({ make: o.f.make, partNumber: o.f.partNumber, role: 'option', why: `Fits this ${machine.model}: ${o.f.description}`, matchedBy: 'described' });
        return { engine: 'rules', machineSerial: machine.serial, picks, question: splitQuestion(options.map((o) => o.f.description ?? o.f.partNumber)), reply: null, escalate: null, notes };
      }
      notes.push(`Nothing on the ${machine.model}'s parts list matches "${words.join(' ')}"`);
    }

    // 4. Catalogue search as a last resort (unverified for this machine).
    if (words.length) {
      const hits = await searchParts(ctx, { query: words.join(' '), make: machine?.make, limit: 3 });
      for (const h of hits.slice(0, 3)) {
        picks.push({ make: h.make, partNumber: h.partNumber, role: 'option', why: `Catalogue match for "${words.join(' ')}" (not checked against this machine)`, matchedBy: 'described' });
      }
      if (picks.length === 1) picks[0]!.role = 'best';
    }
    return {
      engine: 'rules',
      machineSerial: machine?.serial ?? null,
      picks,
      question: picks.length > 1 ? splitQuestion(picks.map((p) => p.why.split(': ').pop() ?? p.partNumber)) : !machine ? 'What machine is it for? A serial number or a photo of the plate is best.' : null,
      reply: null,
      escalate: null,
      notes,
    };
  },
};

function dedupe(picks: AgentPick[]): AgentPick[] {
  const seen = new Set<string>();
  return picks.filter((p) => {
    const k = `${p.make}|${normalisePartNumber(p.partNumber)}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** "Primary or secondary?" when the descriptions differ by one word; otherwise list them. */
export function splitQuestion(descriptions: string[]): string {
  const lower = descriptions.map((d) => d.toLowerCase());
  const split = SPLITTERS.filter((w) => lower.filter((d) => d.includes(w)).length === 1);
  if (split.length >= 2 && split.length === descriptions.length) {
    const cap = split[0]!.charAt(0).toUpperCase() + split[0]!.slice(1);
    return `${cap} or ${split.slice(1).join(' or ')}?`;
  }
  return `Which one: ${descriptions.slice(0, -1).join(', ')} or ${descriptions.at(-1)}?`;
}
