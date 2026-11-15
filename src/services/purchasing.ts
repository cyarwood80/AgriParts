import { and, asc, eq } from 'drizzle-orm';
import { depots, integrationRuns, parts, purchaseOrderLines, purchaseOrders, suppliers } from '../db/schema.js';
import type { OrderingAdapterRegistry } from '../integrations/ordering/adapters.js';
import type { SubmitResult } from '../integrations/ordering/types.js';
import { AppError, invalidState, notFound } from '../lib/errors.js';
import { audit, emitEvent, nextNumber, type ServiceContext } from './context.js';
import { getDepotByCode, getSupplier, getSupplierByCode } from './lookups.js';
import { allocateBackorders } from './orders.js';
import { findPart } from './parts.js';
import { adjustCommitments, recordMovement } from './stock.js';

type PurchaseOrder = typeof purchaseOrders.$inferSelect;

export interface CreatePoInput {
  supplierCode: string;
  depotCode: string;
  orderType?: 'stock' | 'vor' | undefined;
  lines: { partNumber: string; make?: string | undefined; qty: number; unitCostPence?: number | undefined }[];
}

export async function createPurchaseOrder(ctx: ServiceContext, input: CreatePoInput) {
  ctx.require('purchasing:write');
  if (input.lines.length === 0) throw new AppError('VALIDATION', 'A purchase order needs at least one line');
  const supplier = await getSupplierByCode(ctx, input.supplierCode);
  const depot = await getDepotByCode(ctx, input.depotCode);
  const resolved: { part: Awaited<ReturnType<typeof findPart>>; qty: number; cost: number }[] = [];
  for (const l of input.lines) {
    if (!Number.isInteger(l.qty) || l.qty <= 0) throw new AppError('VALIDATION', `qty must be a positive whole number (${l.partNumber})`);
    const part = await findPart(ctx, { partNumber: l.partNumber, make: l.make });
    resolved.push({ part, qty: l.qty, cost: l.unitCostPence ?? part.costPricePence });
  }
  return ctx.transaction(async (tx) => {
    const number = await nextNumber(tx, 'purchase_order', 'PO');
    const [po] = await tx.db
      .insert(purchaseOrders)
      .values({ tenantId: ctx.tenantId, number, supplierId: supplier.id, depotId: depot.id, orderType: input.orderType ?? 'stock', createdBy: ctx.actorLabel })
      .returning();
    await tx.db.insert(purchaseOrderLines).values(
      resolved.map((r) => ({ tenantId: ctx.tenantId, purchaseOrderId: po!.id, partId: r.part.id, qtyOrdered: r.qty, unitCostPence: r.cost })),
    );
    await audit(tx, 'po.created', 'purchase_order', po!.id, { number, supplier: supplier.code, lines: resolved.length });
    return getPurchaseOrder(tx, po!.id);
  });
}

async function loadPo(ctx: ServiceContext, idOrNumber: string, lock = false): Promise<PurchaseOrder> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrNumber);
  const q = ctx.db
    .select()
    .from(purchaseOrders)
    .where(and(eq(purchaseOrders.tenantId, ctx.tenantId), isUuid ? eq(purchaseOrders.id, idOrNumber) : eq(purchaseOrders.number, idOrNumber.toUpperCase())));
  const [po] = lock ? await q.for('update') : await q;
  if (!po) throw notFound('Purchase order', idOrNumber);
  return po;
}

export async function getPurchaseOrder(ctx: ServiceContext, idOrNumber: string) {
  ctx.require('purchasing:read');
  const po = await loadPo(ctx, idOrNumber);
  const [supplier] = await ctx.db.select().from(suppliers).where(eq(suppliers.id, po.supplierId));
  const [depot] = await ctx.db.select().from(depots).where(eq(depots.id, po.depotId));
  const lines = await ctx.db
    .select({ line: purchaseOrderLines, part: parts })
    .from(purchaseOrderLines)
    .innerJoin(parts, eq(parts.id, purchaseOrderLines.partId))
    .where(eq(purchaseOrderLines.purchaseOrderId, po.id))
    .orderBy(asc(parts.partNumberNorm));
  return {
    id: po.id,
    number: po.number,
    status: po.status,
    orderType: po.orderType,
    supplier: { code: supplier!.code, name: supplier!.name, adapter: supplier!.orderingAdapter },
    depot: { code: depot!.code, name: depot!.name },
    externalRef: po.externalRef,
    lines: lines.map(({ line, part }) => ({
      id: line.id,
      make: part.make,
      partNumber: part.partNumber,
      description: part.description,
      qtyOrdered: line.qtyOrdered,
      qtyReceived: line.qtyReceived,
      outstanding: line.qtyOrdered - line.qtyReceived,
      unitCostPence: line.unitCostPence,
    })),
    totalCostPence: lines.reduce((s, { line }) => s + line.qtyOrdered * line.unitCostPence, 0),
    createdAt: po.createdAt,
    sentAt: po.sentAt,
  };
}

/**
 * Send a draft PO through the supplier's ordering adapter.
 *
 * The external call happens outside any DB transaction (never hold locks
 * across the network). Double-sends are prevented by the conditional status
 * update afterwards, and adapters de-duplicate on our PO number.
 */
export async function sendPurchaseOrder(ctx: ServiceContext, idOrNumber: string, registry: OrderingAdapterRegistry) {
  ctx.require('purchasing:write');
  const view = await getPurchaseOrder(ctx, idOrNumber);
  if (view.status !== 'draft') throw invalidState(`Purchase order ${view.number} is ${view.status}, not draft`);
  const po = await loadPo(ctx, view.id);
  const supplier = await getSupplier(ctx, po.supplierId);
  const adapter = registry.get(supplier.orderingAdapter);

  let result: SubmitResult;
  try {
    result = await adapter.submit(
      {
        number: view.number,
        orderType: view.orderType === 'vor' ? 'vor' : 'stock',
        depot: view.depot,
        supplier: { code: supplier.code, name: supplier.name, accountRef: supplier.accountRef },
        lines: view.lines.map((l) => ({ lineId: l.id, make: l.make, partNumber: l.partNumber, description: l.description, qty: l.qtyOrdered, unitCostPence: l.unitCostPence })),
      },
      supplier.adapterConfig,
    );
  } catch (e) {
    await ctx.db.insert(integrationRuns).values({
      tenantId: ctx.tenantId, kind: 'supplier_ordering', provider: adapter.id, status: 'failed',
      summary: { po: view.number, error: (e as Error).message }, actor: ctx.actorLabel, finishedAt: new Date(),
    });
    throw new AppError('INTEGRATION_FAILED', `Supplier ${supplier.code} rejected or failed to receive ${view.number}: ${(e as Error).message}`);
  }

  return ctx.transaction(async (tx) => {
    const updated = await tx.db
      .update(purchaseOrders)
      .set({ status: 'sent', sentAt: new Date(), externalRef: result.externalRef })
      .where(and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, 'draft')))
      .returning();
    if (updated.length === 0) throw new AppError('CONFLICT', `${view.number} was sent by someone else meanwhile`);
    const accepted = new Set(result.acceptedLineIds);
    for (const line of view.lines) {
      if (accepted.has(line.id)) {
        const [pl] = await tx.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.id));
        await adjustCommitments(tx, pl!.partId, po.depotId, { onOrder: line.qtyOrdered });
      } else {
        await tx.db.delete(purchaseOrderLines).where(eq(purchaseOrderLines.id, line.id));
      }
    }
    await tx.db.insert(integrationRuns).values({
      tenantId: ctx.tenantId, kind: 'supplier_ordering', provider: adapter.id, status: 'ok',
      summary: { po: view.number, externalRef: result.externalRef, accepted: result.acceptedLineIds.length, rejected: result.rejected, detail: result.detail ?? {} },
      actor: ctx.actorLabel, finishedAt: new Date(),
    });
    await audit(tx, 'po.sent', 'purchase_order', po.id, { number: view.number, adapter: adapter.id, externalRef: result.externalRef });
    await emitEvent(tx, 'purchase_order.sent', 'purchase_order', po.id, {
      number: view.number, supplier: supplier.code, externalRef: result.externalRef, rejectedLines: result.rejected.length,
    });
    return { purchaseOrder: await getPurchaseOrder(tx, po.id), rejected: result.rejected, document: result.document };
  });
}

/**
 * Book in goods against a PO. Receives into stock, reduces on-order, then
 * hands the new stock to any customer backorders at that depot.
 */
export async function receivePurchaseOrder(
  ctx: ServiceContext,
  idOrNumber: string,
  input: { lines?: { partNumber: string; make?: string | undefined; qty: number }[] | undefined; all?: boolean | undefined },
) {
  ctx.require('purchasing:write');
  return ctx.transaction(async (tx) => {
    const po = await loadPo(tx, idOrNumber, true);
    if (po.status !== 'sent' && po.status !== 'part_received') throw invalidState(`Purchase order ${po.number} is ${po.status}; cannot receive`);
    const lines = await tx.db
      .select({ line: purchaseOrderLines, part: parts })
      .from(purchaseOrderLines)
      .innerJoin(parts, eq(parts.id, purchaseOrderLines.partId))
      .where(eq(purchaseOrderLines.purchaseOrderId, po.id));

    const receipts = new Map<string, number>();
    if (input.all) {
      for (const { line } of lines) receipts.set(line.id, line.qtyOrdered - line.qtyReceived);
    } else {
      for (const r of input.lines ?? []) {
        const part = await findPart(tx, { partNumber: r.partNumber, make: r.make });
        const match = lines.find((l) => l.part.id === part.id);
        if (!match) throw new AppError('VALIDATION', `${r.partNumber} is not on ${po.number}`);
        receipts.set(match.line.id, (receipts.get(match.line.id) ?? 0) + r.qty);
      }
    }

    const received = [];
    const backorderAllocations = [];
    for (const { line, part } of lines) {
      const q = receipts.get(line.id) ?? 0;
      if (q === 0) continue;
      const outstanding = line.qtyOrdered - line.qtyReceived;
      if (!Number.isInteger(q) || q < 0 || q > outstanding) {
        throw new AppError('VALIDATION', `${part.partNumber}: receiving ${q} but ${outstanding} outstanding`);
      }
      await recordMovement(tx, {
        partId: part.id, depotId: po.depotId, type: 'receipt', qty: q, onOrderDelta: -q,
        unitCostPence: line.unitCostPence, referenceType: 'purchase_order', referenceId: po.number,
      });
      await tx.db.update(purchaseOrderLines).set({ qtyReceived: line.qtyReceived + q }).where(eq(purchaseOrderLines.id, line.id));
      received.push({ partNumber: part.partNumber, qty: q });
      const allocs = await allocateBackorders(tx, part.id, po.depotId);
      if (allocs.length) backorderAllocations.push({ partNumber: part.partNumber, orders: allocs });
    }
    if (received.length === 0) throw new AppError('VALIDATION', 'Nothing to receive');

    const after = await tx.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.purchaseOrderId, po.id));
    const complete = after.every((l) => l.qtyReceived >= l.qtyOrdered);
    await tx.db.update(purchaseOrders).set({ status: complete ? 'received' : 'part_received' }).where(eq(purchaseOrders.id, po.id));
    await audit(tx, 'po.received', 'purchase_order', po.id, { number: po.number, received });
    await emitEvent(tx, 'goods.received', 'purchase_order', po.id, { number: po.number, received, backorderAllocations });
    return { purchaseOrder: await getPurchaseOrder(tx, po.id), received, backorderAllocations };
  });
}
