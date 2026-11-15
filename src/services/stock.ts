import { and, eq, sql } from 'drizzle-orm';
import { stockLevels, stockMovements, tenants } from '../db/schema.js';
import { rows } from '../db/rows.js';
import { AppError } from '../lib/errors.js';
import { audit, emitEvent, type ServiceContext } from './context.js';
import { getDepotByCode } from './lookups.js';
import { findPart, getPartById } from './parts.js';

export type MovementType = (typeof stockMovements.$inferInsert)['type'];
export type StockLevel = typeof stockLevels.$inferSelect;

/**
 * Lock (and lazily create) the stock row for a part at a depot. Every change
 * to on_hand/allocated/on_order goes through a locked row so concurrent
 * counter sales can't oversell.
 */
export async function lockStock(ctx: ServiceContext, partId: string, depotId: string): Promise<StockLevel> {
  await ctx.db
    .insert(stockLevels)
    .values({ tenantId: ctx.tenantId, partId, depotId })
    .onConflictDoNothing({ target: [stockLevels.partId, stockLevels.depotId] });
  const [row] = await ctx.db
    .select()
    .from(stockLevels)
    .where(and(eq(stockLevels.tenantId, ctx.tenantId), eq(stockLevels.partId, partId), eq(stockLevels.depotId, depotId)))
    .for('update');
  return row!;
}

async function allowNegative(ctx: ServiceContext): Promise<boolean> {
  const [t] = await ctx.db.select({ settings: tenants.settings }).from(tenants).where(eq(tenants.id, ctx.tenantId));
  return Boolean(t?.settings.allowNegativeStock);
}

export interface MovementInput {
  partId: string;
  depotId: string;
  type: MovementType;
  qty: number;
  unitCostPence?: number;
  referenceType?: string;
  referenceId?: string;
  note?: string;
  /** Change to allocated alongside on_hand (e.g. invoicing consumes the allocation). */
  allocatedDelta?: number;
  onOrderDelta?: number;
}

/**
 * The only way on_hand changes. Writes the ledger row and the balance in the
 * same transaction; caller must already be inside one.
 */
export async function recordMovement(ctx: ServiceContext, m: MovementInput): Promise<StockLevel> {
  if (!Number.isInteger(m.qty)) throw new AppError('VALIDATION', 'Quantities must be whole units');
  const level = await lockStock(ctx, m.partId, m.depotId);
  const onHand = level.onHand + m.qty;
  const allocated = level.allocated + (m.allocatedDelta ?? 0);
  const onOrder = level.onOrder + (m.onOrderDelta ?? 0);
  if (onHand < 0 && m.qty < 0 && !(await allowNegative(ctx))) {
    throw new AppError('INSUFFICIENT_STOCK', `Not enough stock: on hand ${level.onHand}, requested ${-m.qty}`, {
      partId: m.partId,
      depotId: m.depotId,
      onHand: level.onHand,
    });
  }
  if (m.qty !== 0) {
    await ctx.db.insert(stockMovements).values({
      tenantId: ctx.tenantId,
      partId: m.partId,
      depotId: m.depotId,
      type: m.type,
      qty: m.qty,
      unitCostPence: m.unitCostPence ?? 0,
      referenceType: m.referenceType,
      referenceId: m.referenceId,
      note: m.note,
      actor: ctx.actorLabel,
    });
  }
  const [updated] = await ctx.db
    .update(stockLevels)
    .set({ onHand, allocated, onOrder, updatedAt: new Date() })
    .where(and(eq(stockLevels.partId, m.partId), eq(stockLevels.depotId, m.depotId)))
    .returning();
  return updated!;
}

/** Change allocated / on_order without a physical movement. */
export async function adjustCommitments(
  ctx: ServiceContext,
  partId: string,
  depotId: string,
  deltas: { allocated?: number; onOrder?: number },
): Promise<StockLevel> {
  const level = await lockStock(ctx, partId, depotId);
  const [updated] = await ctx.db
    .update(stockLevels)
    .set({
      allocated: level.allocated + (deltas.allocated ?? 0),
      onOrder: level.onOrder + (deltas.onOrder ?? 0),
      updatedAt: new Date(),
    })
    .where(and(eq(stockLevels.partId, partId), eq(stockLevels.depotId, depotId)))
    .returning();
  return updated!;
}

export async function adjustStock(
  ctx: ServiceContext,
  input: { partNumber: string; make?: string | undefined; depotCode: string; countedQty?: number | undefined; delta?: number | undefined; reason: string },
) {
  ctx.require('stock:write');
  if ((input.countedQty === undefined) === (input.delta === undefined)) {
    throw new AppError('VALIDATION', 'Provide exactly one of countedQty or delta');
  }
  const part = await findPart(ctx, { partNumber: input.partNumber, make: input.make });
  const depot = await getDepotByCode(ctx, input.depotCode);
  return ctx.transaction(async (tx) => {
    const level = await lockStock(tx, part.id, depot.id);
    const delta = input.countedQty !== undefined ? input.countedQty - level.onHand : input.delta!;
    const updated = await recordMovement(tx, {
      partId: part.id,
      depotId: depot.id,
      type: 'adjustment',
      qty: delta,
      unitCostPence: part.costPricePence,
      note: input.reason,
    });
    await audit(tx, 'stock.adjusted', 'part', part.id, { depot: depot.code, delta, reason: input.reason });
    await emitEvent(tx, 'stock.adjusted', 'part', part.id, {
      partNumber: part.partNumber,
      make: part.make,
      depot: depot.code,
      delta,
      onHand: updated.onHand,
    });
    return { part: { make: part.make, partNumber: part.partNumber }, depot: depot.code, delta, level: updated };
  });
}

export async function transferStock(
  ctx: ServiceContext,
  input: { partNumber: string; make?: string | undefined; fromDepotCode: string; toDepotCode: string; qty: number; reason?: string | undefined },
) {
  ctx.require('stock:write');
  if (!Number.isInteger(input.qty) || input.qty <= 0) throw new AppError('VALIDATION', 'qty must be a positive whole number');
  const part = await findPart(ctx, { partNumber: input.partNumber, make: input.make });
  const from = await getDepotByCode(ctx, input.fromDepotCode);
  const to = await getDepotByCode(ctx, input.toDepotCode);
  if (from.id === to.id) throw new AppError('VALIDATION', 'Source and destination depot are the same');
  return ctx.transaction(async (tx) => {
    // Lock in a consistent order (by depot id) to avoid deadlocks between opposite transfers.
    const [first, second] = from.id < to.id ? [from, to] : [to, from];
    await lockStock(tx, part.id, first.id);
    await lockStock(tx, part.id, second.id);
    const src = await lockStock(tx, part.id, from.id);
    if (src.onHand - src.allocated < input.qty) {
      throw new AppError('INSUFFICIENT_STOCK', `Only ${src.onHand - src.allocated} free at ${from.code}`, {
        free: src.onHand - src.allocated,
      });
    }
    const ref = `${from.code}->${to.code}`;
    const out = await recordMovement(tx, {
      partId: part.id, depotId: from.id, type: 'transfer_out', qty: -input.qty,
      unitCostPence: part.costPricePence, referenceType: 'transfer', referenceId: ref, note: input.reason,
    });
    const inn = await recordMovement(tx, {
      partId: part.id, depotId: to.id, type: 'transfer_in', qty: input.qty,
      unitCostPence: part.costPricePence, referenceType: 'transfer', referenceId: ref, note: input.reason,
    });
    await audit(tx, 'stock.transferred', 'part', part.id, { from: from.code, to: to.code, qty: input.qty });
    await emitEvent(tx, 'stock.transferred', 'part', part.id, {
      partNumber: part.partNumber, make: part.make, from: from.code, to: to.code, qty: input.qty,
    });
    return { part: { make: part.make, partNumber: part.partNumber }, qty: input.qty, from: { depot: from.code, level: out }, to: { depot: to.code, level: inn } };
  });
}

/**
 * Ledger integrity check: for every stock row, on_hand must equal the sum of
 * its movements. Run nightly and after imports; any mismatch is a bug.
 */
export async function reconcileLedger(ctx: ServiceContext) {
  return rows<{ part_id: string; depot_id: string; on_hand: number; ledger: number }>(ctx.db, sql`
    SELECT sl.part_id, sl.depot_id, sl.on_hand, coalesce(sum(m.qty), 0)::int AS ledger
      FROM stock_levels sl
 LEFT JOIN stock_movements m ON m.part_id = sl.part_id AND m.depot_id = sl.depot_id
     WHERE sl.tenant_id = ${ctx.tenantId}
  GROUP BY sl.part_id, sl.depot_id, sl.on_hand
    HAVING sl.on_hand <> coalesce(sum(m.qty), 0)`);
}

export async function partMovements(ctx: ServiceContext, partId: string, limit = 50) {
  ctx.require('stock:read');
  await getPartById(ctx, partId);
  return ctx.db
    .select()
    .from(stockMovements)
    .where(and(eq(stockMovements.tenantId, ctx.tenantId), eq(stockMovements.partId, partId)))
    .orderBy(sql`${stockMovements.id} DESC`)
    .limit(limit);
}
