/**
 * Outbox dispatcher. Services write domain events in the same transaction as
 * the change; this worker delivers them, so a slow or down integration never
 * blocks the parts counter, and nothing is lost if the process dies.
 *
 *   1. fan-out:  each new event -> one delivery row per matching target
 *                (webhook subscription or integration connection)
 *   2. deliver:  claim due deliveries with a lease, call out (no DB locks
 *                held across the network), record the outcome
 *   3. retry:    exponential backoff; dead-letter after MAX_ATTEMPTS
 *
 * At-least-once delivery: receivers de-duplicate on the delivery id
 * (webhooks) or on the invoice number (accounting idempotency keys).
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DB } from '../../db/client.js';
import { rows } from '../../db/rows.js';
import { domainEvents, eventDeliveries, integrationConnections, integrationRuns, invoices, webhookSubscriptions } from '../../db/schema.js';
import type { AccountingAdapter, FetchLike, InvoiceCreatedPayload } from '../accounting/types.js';

export const MAX_ATTEMPTS = 10;
const LEASE_MS = 5 * 60_000;

export interface DispatcherDeps {
  fetch: FetchLike;
  accounting: Map<string, AccountingAdapter>;
  now?: () => Date;
  log?: (msg: string, data?: Record<string, unknown>) => void;
}

export function backoffMs(attempt: number): number {
  return Math.min(30_000 * 2 ** (attempt - 1), 6 * 3_600_000);
}

// ---------------------------------------------------------------------------
// Webhook signatures (Stripe-style): AgriParts-Signature: t=<unix>,v1=<hex hmac>
// ---------------------------------------------------------------------------

export function signPayload(secret: string, body: string, timestamp: number): string {
  const mac = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${mac}`;
}

/** For receivers (and our tests). Rejects signatures older than toleranceSec. */
export function verifySignature(secret: string, body: string, header: string, toleranceSec = 300, nowSec = Math.floor(Date.now() / 1000)): boolean {
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=') as [string, string]));
  const t = Number(parts.t);
  if (!parts.v1 || !Number.isFinite(t) || Math.abs(nowSec - t) > toleranceSec) return false;
  const expected = signPayload(secret, body, t).split('v1=')[1]!;
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(parts.v1, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

// ---------------------------------------------------------------------------

export async function fanOut(db: DB, limit = 500): Promise<number> {
  return db.transaction(async (tx) => {
    const events = await rows<{ id: number; tenant_id: string; type: string }>(
      tx as unknown as DB,
      sql`SELECT id, tenant_id, type FROM domain_events WHERE fanned_out_at IS NULL ORDER BY id LIMIT ${limit} FOR UPDATE SKIP LOCKED`,
    );
    if (events.length === 0) return 0;
    const tenantIds = [...new Set(events.map((e) => e.tenant_id))];
    const subs = await tx.select().from(webhookSubscriptions).where(and(inArray(webhookSubscriptions.tenantId, tenantIds), eq(webhookSubscriptions.isActive, true)));
    const conns = await tx.select().from(integrationConnections).where(and(inArray(integrationConnections.tenantId, tenantIds), eq(integrationConnections.isActive, true)));
    const deliveries: (typeof eventDeliveries.$inferInsert)[] = [];
    for (const e of events) {
      for (const s of subs) {
        if (s.tenantId === e.tenant_id && (s.eventTypes.includes('*') || s.eventTypes.includes(e.type))) {
          deliveries.push({ tenantId: e.tenant_id, eventId: e.id, target: `webhook:${s.id}` });
        }
      }
      for (const c of conns) {
        if (c.tenantId === e.tenant_id && c.eventTypes.includes(e.type)) {
          deliveries.push({ tenantId: e.tenant_id, eventId: e.id, target: `connection:${c.id}` });
        }
      }
    }
    if (deliveries.length) await tx.insert(eventDeliveries).values(deliveries).onConflictDoNothing();
    await tx.update(domainEvents).set({ fannedOutAt: new Date() }).where(inArray(domainEvents.id, events.map((e) => e.id)));
    return events.length;
  });
}

async function claimDue(db: DB, now: Date, limit: number) {
  // Lease: push next_attempt_at forward so concurrent workers skip these rows.
  return rows<{ id: number; tenant_id: string; event_id: number; target: string; attempts: number }>(
    db,
    sql`UPDATE event_deliveries SET next_attempt_at = ${new Date(now.getTime() + LEASE_MS)}
         WHERE id IN (SELECT id FROM event_deliveries
                       WHERE status = 'pending' AND next_attempt_at <= ${now}
                       ORDER BY next_attempt_at LIMIT ${limit} FOR UPDATE SKIP LOCKED)
     RETURNING id, tenant_id, event_id, target, attempts`,
  );
}

export async function deliverDue(db: DB, deps: DispatcherDeps, limit = 100) {
  const now = deps.now?.() ?? new Date();
  const due = await claimDue(db, now, limit);
  const results = { delivered: 0, failed: 0, dead: 0 };
  for (const d of due) {
    const [event] = await db.select().from(domainEvents).where(eq(domainEvents.id, d.event_id));
    if (!event) continue;
    const attempt = d.attempts + 1;
    try {
      let responseCode: number | null = null;
      if (d.target.startsWith('webhook:')) {
        responseCode = await deliverWebhook(db, deps, d.target.slice(8), d.id, event);
      } else {
        await deliverToConnection(db, deps, d.target.slice(11), event);
      }
      await db.update(eventDeliveries).set({ status: 'done', attempts: attempt, lastError: null, lastResponseCode: responseCode }).where(eq(eventDeliveries.id, d.id));
      results.delivered++;
    } catch (e) {
      const err = e as Error & { status?: number };
      const dead = attempt >= MAX_ATTEMPTS;
      await db
        .update(eventDeliveries)
        .set({
          status: dead ? 'dead' : 'pending',
          attempts: attempt,
          lastError: err.message.slice(0, 1000),
          lastResponseCode: err.status ?? null,
          nextAttemptAt: new Date(now.getTime() + backoffMs(attempt)),
        })
        .where(eq(eventDeliveries.id, d.id));
      deps.log?.('delivery failed', { delivery: d.id, target: d.target, attempt, dead, error: err.message });
      if (dead) results.dead++;
      else results.failed++;
    }
  }
  return results;
}

async function deliverWebhook(db: DB, deps: DispatcherDeps, subscriptionId: string, deliveryId: number, event: typeof domainEvents.$inferSelect) {
  const [sub] = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, subscriptionId));
  if (!sub || !sub.isActive) return null; // unsubscribed meanwhile: treat as done
  const body = JSON.stringify({
    id: `evt_${event.id}`,
    type: event.type,
    createdAt: event.createdAt.toISOString(),
    aggregate: { type: event.aggregateType, id: event.aggregateId },
    data: event.payload,
  });
  const ts = Math.floor((deps.now?.() ?? new Date()).getTime() / 1000);
  const res = await deps.fetch(sub.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'AgriParts-Webhooks/1',
      'AgriParts-Event': event.type,
      'AgriParts-Delivery': String(deliveryId),
      'AgriParts-Signature': signPayload(sub.secret, body, ts),
    },
    body,
  });
  if (!res.ok) {
    const err = new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`) as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return res.status;
}

async function deliverToConnection(db: DB, deps: DispatcherDeps, connectionId: string, event: typeof domainEvents.$inferSelect) {
  const [conn] = await db.select().from(integrationConnections).where(eq(integrationConnections.id, connectionId));
  if (!conn || !conn.isActive) return;
  if (conn.kind !== 'accounting' || event.type !== 'invoice.created') return;
  const adapter = deps.accounting.get(conn.provider);
  if (!adapter) throw new Error(`No accounting adapter "${conn.provider}"`);
  const payload = event.payload as unknown as InvoiceCreatedPayload;
  const result = await adapter.pushInvoice(payload, conn.config);
  await db.transaction(async (tx) => {
    if (result.externalId) {
      await tx.update(invoices).set({ accountingRef: result.externalId }).where(and(eq(invoices.tenantId, conn.tenantId), eq(invoices.number, payload.invoiceNumber)));
    }
    await tx.insert(integrationRuns).values({
      tenantId: conn.tenantId, kind: 'accounting', provider: conn.provider, status: 'ok',
      summary: { invoice: payload.invoiceNumber, externalId: result.externalId, ...(result.detail ?? {}) }, actor: 'system:dispatcher', finishedAt: new Date(),
    });
  });
}

export async function runDispatcherOnce(db: DB, deps: DispatcherDeps) {
  const fanned = await fanOut(db);
  const delivered = await deliverDue(db, deps);
  return { fanned, ...delivered };
}

export function startDispatcher(db: DB, deps: DispatcherDeps, intervalMs = 2_000) {
  let running = false;
  const timer = setInterval(async () => {
    if (running) return;
    running = true;
    try {
      await runDispatcherOnce(db, deps);
    } catch (e) {
      deps.log?.('dispatcher error', { error: (e as Error).message });
    } finally {
      running = false;
    }
  }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** Pull-based alternative to webhooks: read the event log after a cursor. */
export async function listEvents(db: DB, tenantId: string, after: number, limit = 100) {
  return db
    .select({ id: domainEvents.id, type: domainEvents.type, aggregateType: domainEvents.aggregateType, aggregateId: domainEvents.aggregateId, payload: domainEvents.payload, createdAt: domainEvents.createdAt })
    .from(domainEvents)
    .where(and(eq(domainEvents.tenantId, tenantId), sql`${domainEvents.id} > ${after}`))
    .orderBy(asc(domainEvents.id))
    .limit(Math.min(limit, 500));
}

export async function deliveryStats(db: DB, tenantId: string) {
  return db
    .select({ status: eventDeliveries.status, count: sql<number>`count(*)::int` })
    .from(eventDeliveries)
    .where(eq(eventDeliveries.tenantId, tenantId))
    .groupBy(eventDeliveries.status);
}

