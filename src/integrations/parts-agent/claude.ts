/**
 * The Claude parts agent (ADR-0003): a tool loop over our own services.
 *
 *  - The model can only see what the tools return, and can only propose part
 *    numbers. The service re-resolves every pick against the catalogue and
 *    builds the evidence itself, so an invented number is simply dropped.
 *  - Tenant and customer come from the enquiry, never from tool arguments.
 *  - Tool choice can't be forced on this model, so the prompt asks for
 *    submit_answer and we re-prompt once if it doesn't come.
 */
import Anthropic from '@anthropic-ai/sdk';
import { and, desc, eq } from 'drizzle-orm';
import { partSalesHistory } from '../../db/schema.js';
import { AppError } from '../../lib/errors.js';
import { machineDetail, searchMachines } from '../../services/guidance.js';
import { equivalents, resolvePart, searchParts } from '../../services/parts.js';
import type { AgentInput, AgentPick, AgentProposal, PartsAgentEngine } from './types.js';

export const PARTS_AGENT_MODEL = 'claude-opus-5-5';
const MAX_STEPS = 8;

const SYSTEM = `You are the parts agent at a UK agricultural machinery dealer. A parts person is working a customer enquiry with you. Your job: work out exactly which part the customer needs, with evidence, or hand over to a person.

Rules:
- Only propose part numbers that a tool returned. Never invent or "correct" a number yourself.
- Identify the machine first (serial, reg, or which of the customer's machines). Prefer parts on that machine's fitted parts list.
- If two parts fit the description, ask ONE short question that splits them (e.g. "Primary or secondary?"). Don't guess.
- Hand over (escalate) when you can't get to one confident answer, when the customer is unhappy, or for safety-critical systems: brakes, steering, hitch and linkage, PTO guards, ROPS/cab structure, tyres and wheels.
- Machine stopped / "VOR" / urgent breakdown: urgency "vor".
- Write the reply as the best parts person they've dealt with: plain British English, specific, short. Give the number. Say if it replaces an old number and whether it's a straight swap. No "AI", no exclamation marks, no sales talk. Don't quote prices or stock: the screen shows those.

When you're done, call submit_answer exactly once.`;

const TOOLS: Anthropic.Tool[] = [
  {
    name: 'find_machine',
    description: 'Find machines by serial, registration, model or customer name. Returns serial, make, model, owner.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
  },
  {
    name: 'parts_for_machine',
    description: "The parts that fit one machine (by serial), with assembly, description and parts-book reference. Optionally filter by a word in the assembly or description.",
    input_schema: {
      type: 'object',
      properties: { serial: { type: 'string' }, filter: { type: ['string', 'null'] } },
      required: ['serial', 'filter'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_parts',
    description: 'Search the catalogue by part number (any format) or words. Not machine-specific.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' }, make: { type: ['string', 'null'] } },
      required: ['query', 'make'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_part',
    description: 'Resolve a part number: what we would supply today (after supersessions), whether it is a straight swap, and cross-brand equivalents.',
    input_schema: {
      type: 'object',
      properties: { partNumber: { type: 'string' }, make: { type: ['string', 'null'] } },
      required: ['partNumber', 'make'],
      additionalProperties: false,
    },
  },
  {
    name: 'customer_history',
    description: "Parts this enquiry's customer has bought before (most recent first), with the machine when known.",
    input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  },
  {
    name: 'submit_answer',
    description: 'Finish: the machine, the parts you propose (only numbers a tool returned), one question if you need one, a draft reply, and whether to hand over to a person.',
    strict: true,
    input_schema: {
      type: 'object',
      properties: {
        machine_serial: { type: ['string', 'null'] },
        picks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              make: { type: 'string' },
              partNumber: { type: 'string' },
              role: { type: 'string', enum: ['best', 'option', 'alternative'] },
              why: { type: 'string' },
              matchedBy: { type: 'string', enum: ['number', 'described', 'machine', 'history'] },
            },
            required: ['make', 'partNumber', 'role', 'why', 'matchedBy'],
            additionalProperties: false,
          },
        },
        question: { type: ['string', 'null'] },
        reply: { type: 'string' },
        escalate: {
          anyOf: [
            { type: 'null' },
            {
              type: 'object',
              properties: { reason: { type: 'string' }, urgency: { type: 'string', enum: ['normal', 'vor'] } },
              required: ['reason', 'urgency'],
              additionalProperties: false,
            },
          ],
        },
        notes: { type: 'array', items: { type: 'string' } },
      },
      required: ['machine_serial', 'picks', 'question', 'reply', 'escalate', 'notes'],
      additionalProperties: false,
    },
  },
];

interface SubmitInput {
  machine_serial: string | null;
  picks: AgentPick[];
  question: string | null;
  reply: string;
  escalate: { reason: string; urgency: 'normal' | 'vor' } | null;
  notes: string[];
}

let client: Anthropic | undefined;

export function claudeAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY) && process.env.PARTS_AGENT_ENGINE !== 'rules';
}

async function runTool(input: AgentInput, name: string, args: Record<string, unknown>): Promise<unknown> {
  const { ctx } = input;
  const str = (k: string) => (typeof args[k] === 'string' && (args[k] as string).trim() ? (args[k] as string).trim() : undefined);
  switch (name) {
    case 'find_machine':
      return searchMachines(ctx, str('query') ?? '', 8);
    case 'parts_for_machine': {
      const d = await machineDetail(ctx, str('serial') ?? '');
      const f = str('filter')?.toLowerCase();
      return {
        machine: `${d.model.make} ${d.model.model} ${d.serial}`,
        parts: d.fittedParts
          .filter((p) => !f || `${p.assembly ?? ''} ${p.description ?? ''}`.toLowerCase().includes(f))
          .map((p) => ({ make: p.make, partNumber: p.partNumber, description: p.description, assembly: p.assembly, reference: p.reference, verified: p.verified })),
      };
    }
    case 'search_parts':
      return (await searchParts(ctx, { query: str('query') ?? '', make: str('make'), limit: 10 })).map((p) => ({ make: p.make, partNumber: p.partNumber, description: p.description }));
    case 'check_part': {
      const r = await resolvePart(ctx, { partNumber: str('partNumber') ?? '', make: str('make') });
      const eq = await equivalents(ctx, r.part.id);
      return { supply: { make: r.part.make, partNumber: r.part.partNumber, description: r.part.description }, superseded: r.superseded, chain: r.chain, straightSwap: r.straightSwap, warning: r.warning, equivalents: eq };
    }
    case 'customer_history': {
      if (!input.customer) return { note: 'No customer on this enquiry' };
      return ctx.db
        .select({ invoicedOn: partSalesHistory.invoicedOn, make: partSalesHistory.make, partNumber: partSalesHistory.partNumber, qty: partSalesHistory.qty })
        .from(partSalesHistory)
        .where(and(eq(partSalesHistory.tenantId, ctx.tenantId), eq(partSalesHistory.customerId, input.customer.id)))
        .orderBy(desc(partSalesHistory.invoicedOn))
        .limit(30);
    }
    default:
      throw new AppError('VALIDATION', `Unknown tool ${name}`);
  }
}

function brief(input: AgentInput): string {
  const lines = [
    `Channel: ${input.channel}. Priority: ${input.priority}. Agent turns so far: ${input.rounds}.`,
    input.customer ? `Customer: ${input.customer.name} (${input.customer.accountCode}).` : 'Customer: not on an account yet.',
    input.machine ? `Machine on the enquiry: ${input.machine.make} ${input.machine.model}, serial ${input.machine.serial}.` : 'Machine: not identified yet.',
    input.customerMachines.length ? `Their machines: ${input.customerMachines.map((m) => `${m.make} ${m.model} ${m.serial}`).join('; ')}.` : '',
    '',
    'Conversation so far (oldest first):',
    ...input.messages.map((m) => `${m.role === 'customer' ? 'CUSTOMER' : m.role === 'staff' ? 'PARTS PERSON' : m.role.toUpperCase()}: ${m.body}`),
  ];
  return lines.filter((l) => l !== undefined).join('\n');
}

export const claudeEngine: PartsAgentEngine = {
  name: 'claude',
  async propose(input: AgentInput): Promise<AgentProposal> {
    client ??= new Anthropic();
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: brief(input) }];
    let reprompted = false;
    for (let step = 0; step < MAX_STEPS; step++) {
      const response = await client.messages.create({
        model: PARTS_AGENT_MODEL,
        max_tokens: 4000,
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        messages,
      });
      if (response.stop_reason === 'refusal') throw new AppError('INTEGRATION_FAILED', 'Parts agent declined this enquiry');
      if (response.stop_reason === 'max_tokens') throw new AppError('INTEGRATION_FAILED', 'Parts agent ran out of room');
      const uses = response.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
      const submit = uses.find((u) => u.name === 'submit_answer');
      if (submit) {
        const a = submit.input as SubmitInput;
        return {
          engine: 'claude',
          machineSerial: a.machine_serial,
          picks: a.picks ?? [],
          question: a.question,
          reply: a.reply || null,
          escalate: a.escalate,
          notes: a.notes ?? [],
        };
      }
      messages.push({ role: 'assistant', content: response.content });
      if (!uses.length) {
        if (reprompted) break;
        reprompted = true;
        messages.push({ role: 'user', content: 'Call submit_answer now with what you have.' });
        continue;
      }
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const u of uses) {
        try {
          results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(await runTool(input, u.name, (u.input ?? {}) as Record<string, unknown>)) });
        } catch (e) {
          results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: e instanceof Error ? e.message : String(e) });
        }
      }
      messages.push({ role: 'user', content: results });
    }
    throw new AppError('INTEGRATION_FAILED', 'Parts agent did not finish');
  },
};
