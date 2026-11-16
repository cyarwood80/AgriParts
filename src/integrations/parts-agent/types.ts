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

export interface AgentProposal {
  engine: 'claude' | 'rules';
  machineSerial: string | null;
  picks: AgentPick[];
  question: string | null;
  /** Draft reply. Null: the service writes one from the checked candidates. */
  reply: string | null;
  escalate: { reason: string; urgency: 'normal' | 'vor' } | null;
  notes: string[];
}

export interface PartsAgentEngine {
  readonly name: 'claude' | 'rules';
  propose(input: AgentInput): Promise<AgentProposal>;
}
