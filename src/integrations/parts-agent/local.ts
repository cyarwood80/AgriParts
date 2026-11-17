/**
 * The local Claude parts agent: runs through the Claude Agent SDK, which
 * drives Claude Code on this machine and uses its sign-in (a Claude
 * subscription login or CLAUDE_CODE_OAUTH_TOKEN), so no API key is needed.
 *
 * Same contract as the API engine (ADR-0003):
 *  - Catalogue tools are our own services, exposed as an in-process MCP
 *    server. Tenant and customer come from the input, never from arguments.
 *  - Part numbers from our tools go in `picks`; the service re-checks them.
 *  - For machines or parts we hold no data for, the agent may search the
 *    web. Those go in `web`, never in `picks`, and only survive if their URL
 *    appeared in a search or fetch result in this run (no invented sources).
 */
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { PARTS_AGENT_MODEL, runTool } from './claude.js';
import type { AgentInput, AgentProgress, AgentProposal, PartsAgentEngine, WebFinding } from './types.js';

const SYSTEM = `You are Linchpin, the parts expert at a UK agricultural machinery dealer. You are talking directly with the person who needs the part: a farmer, a contractor, an engineer or a parts person. Get them to the exact right part, then hand them to the fitting guide.

How to work:
1. The machine. If they gave a serial, registration or customer name, use find_machine. If the machine is in our records, use parts_for_machine, search_parts and check_part. If it isn't (for example "Valtra T214"), say so plainly and work from the make and model they gave; ask for the serial or year only if it changes the part.
2. The part. Prefer the machine's own fitted parts list. If two parts fit what they said, ask ONE short question that splits them. Don't guess.
3. Our catalogue first. Part numbers that our tools returned go in "picks". Never invent or "correct" a number.
4. Outside our data. If the machine or part isn't in our catalogue, search the web for the genuine OEM part number, preferring the manufacturer's own parts site, then main dealers, then reputable parts suppliers. Put what you find in "web" with the exact page URL you got it from, and say in "note" what still needs confirming (serial break, model year, engine variant). Never put a web number in "picks".
5. Safety-critical systems (brakes, steering, hitch and linkage, PTO guards, ROPS or cab structure, tyres and wheels): give what you found but set "escalate" so the parts desk confirms it.

The reply: plain British English, short and specific, like the best parts person they've dealt with. Give the number when you have one. Say if it replaces an old number. If the answer came from the web, say it's unconfirmed and where it came from. No "AI", no exclamation marks, no sales talk. Don't quote prices or stock: the screen shows those for parts in our catalogue.

Finish with the structured answer.`;

const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    machine_serial: { type: ['string', 'null'], description: 'Serial of a machine in our records, if identified' },
    machine_text: { type: ['string', 'null'], description: 'The machine as described, when it is not in our records' },
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
    web: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          make: { type: 'string' },
          partNumber: { type: 'string' },
          description: { type: 'string' },
          note: { type: 'string' },
          source_title: { type: 'string' },
          source_url: { type: 'string' },
        },
        required: ['make', 'partNumber', 'description', 'note', 'source_title', 'source_url'],
        additionalProperties: false,
      },
    },
    question: { type: ['string', 'null'] },
    reply: { type: 'string' },
    escalate: {
      anyOf: [
        { type: 'null' },
        { type: 'object', properties: { reason: { type: 'string' }, urgency: { type: 'string', enum: ['normal', 'vor'] } }, required: ['reason', 'urgency'], additionalProperties: false },
      ],
    },
    notes: { type: 'array', items: { type: 'string' } },
  },
  required: ['machine_serial', 'machine_text', 'picks', 'web', 'question', 'reply', 'escalate', 'notes'],
  additionalProperties: false,
} as const;

interface Answer {
  machine_serial: string | null;
  machine_text: string | null;
  picks: AgentProposal['picks'];
  web: { make: string; partNumber: string; description: string; note: string; source_title: string; source_url: string }[];
  question: string | null;
  reply: string;
  escalate: AgentProposal['escalate'];
  notes: string[];
}

// ---------------------------------------------------------------- availability

let lastFailure: { at: number; reason: string } | null = null;
const RETRY_AFTER_MS = 60_000;

/** Off when PARTS_AGENT_ENGINE says so, or for a minute after a sign-in failure. */
export function localAvailable(): boolean {
  const mode = process.env.PARTS_AGENT_ENGINE;
  if (mode === 'rules' || mode === 'api') return false;
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) return mode === 'local';
  return !(lastFailure && Date.now() - lastFailure.at < RETRY_AFTER_MS);
}

export function localStatus() {
  return { available: localAvailable(), lastFailure: lastFailure?.reason ?? null };
}

/**
 * The environment for the Claude Code process. When this server is itself
 * started from inside a Claude Code session, the parent's session variables
 * would make the child try to borrow that session; drop them so it uses the
 * machine's own sign-in.
 */
function childEnv(): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_(?!OAUTH_TOKEN$)|CLAUDE_AGENT_SDK_|ANTHROPIC_BASE_URL$)/.test(k)));
}

// ---------------------------------------------------------------- engine

function conversation(input: AgentInput): string {
  const lines = [
    input.machine ? `Machine already chosen: ${input.machine.make} ${input.machine.model}, serial ${input.machine.serial}${input.machine.year ? `, ${input.machine.year}` : ''}.` : 'Machine: not chosen yet.',
    input.customer ? `Owner on our records: ${input.customer.name} (${input.customer.accountCode}).` : '',
    '',
    'Conversation so far (oldest first):',
    ...input.messages.map((m) => `${m.role === 'assistant' ? 'YOU (Linchpin)' : 'THEM'}: ${m.body}`),
  ];
  return lines.filter(Boolean).join('\n');
}

const URL_RE = /https?:\/\/[^\s"'<>)\]]+/g;
const norm = (u: string) => u.replace(/[#?].*$/, '').replace(/\/+$/, '').toLowerCase();

function toolStatus(name: string, args: Record<string, unknown>): string {
  const q = String(args.query ?? args.serial ?? args.partNumber ?? args.url ?? '').slice(0, 80);
  switch (name.replace(/^mcp__linchpin__/, '')) {
    case 'find_machine': return `Looking up the machine: ${q}`;
    case 'parts_for_machine': return `Reading the parts book for ${q}`;
    case 'search_parts': return `Searching our catalogue for ${q}`;
    case 'check_part': return `Checking ${q}: supersessions and equivalents`;
    case 'customer_history': return 'Checking what they bought before';
    case 'WebSearch': return `Searching the web: ${q}`;
    case 'WebFetch': return `Reading ${q.replace(/^https?:\/\//, '').slice(0, 60)}`;
    case 'StructuredOutput': return 'Writing the answer';
    default: return 'Working';
  }
}

export const localEngine: PartsAgentEngine = {
  name: 'claude-local',
  async propose(input: AgentInput, onProgress?: AgentProgress): Promise<AgentProposal> {
    const call = (name: string) => async (args: Record<string, unknown>) => {
      try {
        return { content: [{ type: 'text' as const, text: JSON.stringify(await runTool(input, name, args)) }] };
      } catch (e) {
        return { content: [{ type: 'text' as const, text: e instanceof Error ? e.message : String(e) }], isError: true };
      }
    };
    const server = createSdkMcpServer({
      name: 'linchpin',
      version: '1.0.0',
      tools: [
        tool('find_machine', "Find machines on the dealer's records by serial, registration, model or customer name.", { query: z.string() }, call('find_machine')),
        tool('parts_for_machine', 'Parts that fit one machine in our records (by serial), with assembly and parts-book reference. Optional word filter.', { serial: z.string(), filter: z.string().nullable() }, call('parts_for_machine')),
        tool('search_parts', "Search the dealer's catalogue by part number (any format) or words.", { query: z.string(), make: z.string().nullable() }, call('search_parts')),
        tool('check_part', 'Resolve one of our part numbers: what we supply today after supersessions, straight swap or not, equivalents.', { partNumber: z.string(), make: z.string().nullable() }, call('check_part')),
        tool('customer_history', "Parts the machine's owner bought before, newest first.", {}, call('customer_history')),
      ],
    });

    const seenUrls = new Set<string>();
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), Number(process.env.PARTS_AGENT_TIMEOUT_MS ?? 150_000));
    onProgress?.('Thinking about what you need');
    try {
      const run = query({
        prompt: (async function* () {
          yield { type: 'user' as const, message: { role: 'user' as const, content: conversation(input) }, parent_tool_use_id: null };
        })(),
        options: {
          model: process.env.PARTS_AGENT_MODEL ?? PARTS_AGENT_MODEL,
          systemPrompt: SYSTEM,
          mcpServers: { linchpin: server },
          tools: ['WebSearch', 'WebFetch'],
          allowedTools: ['WebSearch', 'WebFetch', 'mcp__linchpin__find_machine', 'mcp__linchpin__parts_for_machine', 'mcp__linchpin__search_parts', 'mcp__linchpin__check_part', 'mcp__linchpin__customer_history'],
          permissionMode: 'dontAsk',
          settingSources: [],
          persistSession: false,
          maxTurns: 16,
          effort: 'medium',
          env: childEnv(),
          abortController: abort,
          outputFormat: { type: 'json_schema', schema: ANSWER_SCHEMA as unknown as Record<string, unknown> },
        },
      });
      for await (const m of run) {
        if (m.type === 'assistant') {
          for (const b of m.message.content) if (b.type === 'tool_use') onProgress?.(toolStatus(b.name, (b.input ?? {}) as Record<string, unknown>));
        } else if (m.type === 'user') {
          const c = m.message.content;
          const text = typeof c === 'string' ? c : JSON.stringify(c);
          for (const u of text.match(URL_RE) ?? []) seenUrls.add(norm(u));
          if (m.tool_use_result) for (const u of JSON.stringify(m.tool_use_result).match(URL_RE) ?? []) seenUrls.add(norm(u));
        } else if (m.type === 'result') {
          if (m.subtype !== 'success') throw new AppError('INTEGRATION_FAILED', `Local Claude stopped: ${m.subtype}`);
          if (m.is_error) throw new AppError('INTEGRATION_FAILED', String(m.result ?? 'Local Claude returned an error'));
          const a = m.structured_output as Answer | undefined;
          if (!a) throw new AppError('INTEGRATION_FAILED', 'Local Claude finished without an answer');
          lastFailure = null;
          const notes = [...(a.notes ?? [])];
          const web: WebFinding[] = [];
          for (const w of a.web ?? []) {
            if (!seenUrls.has(norm(w.source_url))) { notes.push(`Dropped web finding ${w.partNumber}: its source wasn't in the search results`); continue; }
            web.push({ make: w.make, partNumber: w.partNumber, description: w.description, note: w.note, source: { title: w.source_title, url: w.source_url } });
          }
          return {
            engine: 'claude-local', machineSerial: a.machine_serial, machineText: a.machine_text, picks: a.picks ?? [], web,
            question: a.question, reply: a.reply || null, escalate: a.escalate, notes,
          };
        }
      }
      throw new AppError('INTEGRATION_FAILED', 'Local Claude did not finish');
    } catch (e) {
      const msg = abort.signal.aborted ? 'took too long' : e instanceof Error ? e.message : String(e);
      lastFailure = { at: Date.now(), reason: /not logged in|login/i.test(msg) ? 'Claude Code is not signed in' : msg.slice(0, 200) };
      throw e instanceof AppError ? e : new AppError('INTEGRATION_FAILED', lastFailure.reason);
    } finally {
      clearTimeout(timer);
    }
  },
};
