import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.js';
import { auditLog, domainEvents, numberSequences } from '../db/schema.js';
import { AppError } from '../lib/errors.js';

export const SCOPES = [
  'parts:read',
  'stock:read',
  'stock:write',
  'customers:read',
  'orders:read',
  'orders:write',
  'invoices:write',
  'purchasing:read',
  'purchasing:write',
  'insights:read',
  'guidance:read',
  /** Work customer enquiries with the parts agent: open, reply, hand over, resolve. */
  'enquiries:write',
  /** Register manuals, submit extractions, edit steps, manage portal links. */
  'content:write',
  /** Approve/reject procedures for publication: the workshop foreman. */
  'content:review',
  'integrations:write',
  'webhooks:manage',
  'admin',
] as const;
export type Scope = (typeof SCOPES)[number];

export const READ_ONLY_SCOPES: Scope[] = [
  'parts:read',
  'stock:read',
  'customers:read',
  'orders:read',
  'purchasing:read',
  'insights:read',
  'guidance:read',
];

export type Channel = 'rest' | 'mcp' | 'system' | 'import';

export interface Actor {
  type: 'api_key' | 'user' | 'system';
  id: string;
  name: string;
}

/**
 * Everything a service needs to act on behalf of someone: which tenant, who,
 * through which channel, and what they're allowed to do. REST and MCP build
 * one of these per request and call the same services.
 */
export class ServiceContext {
  constructor(
    readonly db: DB,
    readonly tenantId: string,
    readonly actor: Actor,
    readonly scopes: ReadonlySet<Scope>,
    readonly channel: Channel,
  ) {}

  get actorLabel(): string {
    return `${this.actor.type}:${this.actor.name}`;
  }

  can(scope: Scope): boolean {
    return this.scopes.has('admin') || this.scopes.has(scope);
  }

  require(scope: Scope): void {
    if (!this.can(scope)) throw new AppError('FORBIDDEN', `Missing scope: ${scope}`, { scope });
  }

  /** Same identity, different executor: used to run service code inside a transaction. */
  withDb(db: DB): ServiceContext {
    return new ServiceContext(db, this.tenantId, this.actor, this.scopes, this.channel);
  }

  async transaction<T>(fn: (tx: ServiceContext) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => fn(this.withDb(tx as unknown as DB)));
  }

  static system(db: DB, tenantId: string): ServiceContext {
    return new ServiceContext(db, tenantId, { type: 'system', id: 'system', name: 'system' }, new Set(['admin']), 'system');
  }
}

/** Write to the outbox. Call inside the same transaction as the change. */
export async function emitEvent(
  ctx: ServiceContext,
  type: string,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await ctx.db.insert(domainEvents).values({ tenantId: ctx.tenantId, type, aggregateType, aggregateId, payload });
}

export async function audit(
  ctx: ServiceContext,
  action: string,
  entityType: string,
  entityId: string,
  data: Record<string, unknown> = {},
): Promise<void> {
  await ctx.db.insert(auditLog).values({
    tenantId: ctx.tenantId,
    actor: ctx.actorLabel,
    channel: ctx.channel,
    action,
    entityType,
    entityId,
    data,
  });
}

/** Gap-free-per-tenant document numbers (SO-000001, INV-000001...). Atomic upsert. */
export async function nextNumber(ctx: ServiceContext, name: string, prefix: string): Promise<string> {
  const rows = await ctx.db
    .insert(numberSequences)
    .values({ tenantId: ctx.tenantId, name, nextValue: 2 })
    .onConflictDoUpdate({
      target: [numberSequences.tenantId, numberSequences.name],
      set: { nextValue: sql`${numberSequences.nextValue} + 1` },
    })
    .returning({ next: numberSequences.nextValue });
  const issued = rows[0]!.next - 1;
  return `${prefix}-${String(issued).padStart(6, '0')}`;
}
