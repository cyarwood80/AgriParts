/**
 * What a parts-agent engine sees and what it may return (ADR-0003).
 *
 * An engine only PROPOSES part numbers it found through our tools. The
 * parts-finder service then resolves each one against the catalogue and
 * builds the evidence, price, stock and fitting guide from our own data.
 * Anything that doesn't resolve is dropped.
 */
import type { ServiceContext } from '../../services/context.js';

export interface AgentMachine {
  serial: string;
  make: string;
  model: string;
  kind: string | null;
  year: number | null;
  engineHours: number | null;
}

export interface AgentInput {
  ctx: ServiceContext;
  channel: string;
  priority: string;
  customer: { id: string; accountCode: string; name: string } | null;
  machine: AgentMachine | null;
  /** The customer's machines, so the engine can ask "which one?". */
  customerMachines: AgentMachine[];
  messages: { role: string; body: string }[];
  /** Agent turns already taken on this enquiry. */
  rounds: number;
}

export interface AgentPick {
  make: string;
  partNumber: string;
  /** best | option | alternative */
  role: 'best' | 'option' | 'alternative';
  why: string;
  /** How the engine matched it: the customer gave the number, or the description matched. */
  matchedBy: 'number' | 'described' | 'machine' | 'history';
}

/** A part found on the web for a machine or part we hold no data for. Never supplied as-is. */
export interface WebFinding {
  make: string;
  partNumber: string;
  description: string;
  /** Why the agent thinks this is it, and what still needs confirming (serial break, year). */
  note: string;
  source: { title: string; url: string };
}

export interface AgentProposal {
  engine: 'claude' | 'claude-local' | 'rules';
  /** The machine as the user described it, when it isn't in our records (e.g. "Valtra T214"). */
  machineText?: string | null;
  /** Unverified web findings; only URLs the agent actually fetched or searched survive. */
  web?: WebFinding[];
  machineSerial: string | null;
  picks: AgentPick[];
  question: string | null;
  /** Draft reply. Null: the service writes one from the checked candidates. */
  reply: string | null;
  escalate: { reason: string; urgency: 'normal' | 'vor' } | null;
  notes: string[];
}

/** Progress for the screen while the agent works ("Searching the web for ..."). */
export type AgentProgress = (status: string) => void;

export interface PartsAgentEngine {
  readonly name: 'claude' | 'claude-local' | 'rules';
  propose(input: AgentInput, onProgress?: AgentProgress): Promise<AgentProposal>;
}
