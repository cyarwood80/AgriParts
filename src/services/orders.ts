import { and, asc, eq, gt, inArray, or, sql } from 'drizzle-orm';
import { customers, depots, invoiceLines, invoices, parts, salesOrderLines, salesOrders, tenants } from '../db/schema.js';
import { AppError, invalidState, notFound } from '../lib/errors.js';
import { applyBps } from '../lib/money.js';
import { audit, emitEvent, nextNumber, type ServiceContext } from './context.js';
import { getCustomer, getCustomerByAccount, getDepot, getDepotByCode } from './lookups.js';
import { resolvePart, stockByDepot } from './parts.js';
import { priceFor } from './pricing.js';
import { adjustCommitments, lockStock, recordMovement } from './stock.js';

export type SalesOrder = typeof salesOrders.$inferSelect;
type OrderLine = typeof salesOrderLines.$inferSelect;

export interface QuoteLineInput {
  partNumber: string;
  make?: string | undefined;
  qty: number;
}

export interface CreateQuoteInput {
  customerAccount: string;
  depotCode: string;
  lines: QuoteLineInput[];
  customerRef?: string | undefined;
  notes?: string | undefined;
  channel?: string | undefined;
}

/**
 * Price a basket and save it as a quote. A quote has no stock effect, so it's
 * safe for agents to create freely; confirming it is the step that commits.
 */
export async function createQuote(ctx: ServiceContext, input: CreateQuoteInput) {
  ctx.require('orders:write');
  if (input.lines.length === 0) throw new AppError('VALIDATION', 'A quote needs at least one line');
  if (input.lines.length > 200) throw new AppError('VALIDATION', 'Too many lines (max 200)');
  const customer = await getCustomerByAccount(ctx, input.customerAccount);
  const depot = await getDepotByCode(ctx, input.depotCode);

  const priced: { lineNo: number; line: QuoteLineInput; resolved: Awaited<ReturnType<typeof resolvePart>>; qty: number; price: Awaited<ReturnType<typeof priceFor>>; warnings: string[] }[] = [];
  for (const [i, line] of input.lines.entries()) {
    if (!Number.isInteger(line.qty) || line.qty <= 0) throw new AppError('VALIDATION', `Line ${i + 1}: qty must be a positive whole number`);
    const resolved = await resolvePart(ctx, { partNumber: line.partNumber, make: line.make });
    const qty = line.qty * resolved.qtyMultiplier;
    const price = await priceFor(ctx, resolved.part, customer);
    const warnings = [...price.warnings];
    if (resolved.superseded) warnings.push(`Superseded: ${line.partNumber} -> ${resolved.part.partNumber}`);
    if (resolved.warning) warnings.push(resolved.warning);
    priced.push({ lineNo: i + 1, line, resolved, qty, price, warnings });
  }

  return ctx.transaction(async (tx) => {
    const number = await nextNumber(tx, 'sales_order', 'SO');
    let net = 0;
    let vat = 0;
    const lineRows = priced.map((p) => {
      const lineNet = p.price.unitNetPence * p.qty;
      net += lineNet;
      vat += applyBps(lineNet, p.price.vatRateBps);
      return {
        tenantId: ctx.tenantId,
        lineNo: p.lineNo,
        partId: p.resolved.part.id,
        requestedPartNumber: p.line.partNumber,
        qty: p.qty,
        unitListPence: p.price.unitListPence,
        unitNetPence: p.price.unitNetPence,
        unitCostPence: p.price.unitCostPence,
        vatRateBps: p.price.vatRateBps,
        lineNetPence: lineNet,
        priceExplanation: {
          basis: p.price.basis,
          explanation: p.price.explanation,
          discountBps: p.price.discountBps,
          supersessionChain: p.resolved.chain,
          straightSwap: p.resolved.straightSwap,
          warnings: p.warnings,
        },
      };
    });
    const [order] = await tx.db
      .insert(salesOrders)
      .values({
        tenantId: ctx.tenantId,
        number,
        customerId: customer.id,
        depotId: depot.id,
        customerRef: input.customerRef,
        notes: input.notes,
        channel: input.channel ?? ctx.channel,
        netPence: net,
        vatPence: vat,
        grossPence: net + vat,
        createdBy: ctx.actorLabel,
      })
      .returning();
    await tx.db.insert(salesOrderLines).values(lineRows.map((l) => ({ ...l, orderId: order!.id })));
    await audit(tx, 'quote.created', 'sales_order', order!.id, { number, lines: lineRows.length, netPence: net });
    await emitEvent(tx, 'quote.created', 'sales_order', order!.id, { number, customer: customer.accountCode, netPence: net });
    return getOrder(tx, order!.id);
  });
}

async function loadOrder(ctx: ServiceContext, idOrNumber: string, lock = false): Promise<SalesOrder> {
  const isUuid = /^[0-9a-f-]{36}$/i.test(idOrNumber);
  const q = ctx.db
    .select()
    .from(salesOrders)
    .where(
      and(
        eq(salesOrders.tenantId, ctx.tenantId),
        isUuid ? eq(salesOrders.id, idOrNumber) : eq(salesOrders.number, idOrNumber.toUpperCase()),
      ),
    );
  const [order] = lock ? await q.for('update') : await q;
  if (!order) throw notFound('Sales order', idOrNumber);
  return order;
}

async function loadLines(ctx: ServiceContext, orderId: string): Promise<OrderLine[]> {
  return ctx.db.select().from(salesOrderLines).where(eq(salesOrderLines.orderId, orderId)).orderBy(asc(salesOrderLines.lineNo));
}

export async function getOrder(ctx: ServiceContext, idOrNumber: string) {
  ctx.require('orders:read');
  const order = await loadOrder(ctx, idOrNumber);
  const lines = await ctx.db
    .select({ line: salesOrderLines, part: { make: parts.make, partNumber: parts.partNumber, description: parts.description, uom: parts.uom } })
    .from(salesOrderLines)
    .innerJoin(parts, eq(parts.id, salesOrderLines.partId))
    .where(eq(salesOrderLines.orderId, order.id))
    .orderBy(asc(salesOrderLines.lineNo));
  const customer = await getCustomer(ctx, order.customerId);
  const depot = await getDepot(ctx, order.depotId);
  const invs = await ctx.db.select().from(invoices).where(eq(invoices.orderId, order.id)).orderBy(asc(invoices.issuedAt));

  // Availability is only interesting before stock is committed.
  const availability =
    order.status === 'quote' && ctx.can('stock:read')
      ? Object.fromEntries(
          await Promise.all(
            lines.map(async ({ line }) => {
              const s = await stockByDepot(ctx, line.partId);
              const here = s.find((d) => d.depotId === order.depotId);
              return [line.id, { atDepot: here?.available ?? 0, elsewhere: s.filter((d) => d.depotId !== order.depotId && d.available > 0).map((d) => ({ depot: d.depotCode, available: d.available })) }];
            }),
          ),
        )
      : undefined;

  return {
    id: order.id,
    number: order.number,
    status: order.status,
    customer: { id: customer.id, accountCode: customer.accountCode, name: customer.name, priceBand: customer.priceBand, onStop: customer.onStop },
    depot: { code: depot.code, name: depot.name },
    customerRef: order.customerRef,
    channel: order.channel,
    notes: order.notes,
    totals: { netPence: order.netPence, vatPence: order.vatPence, grossPence: order.grossPence },
    lines: lines.map(({ line, part }) => ({
      id: line.id,
      lineNo: line.lineNo,
      make: part.make,
      partNumber: part.partNumber,
      requestedPartNumber: line.requestedPartNumber,
      description: part.description,
      uom: part.uom,
      qty: line.qty,
      qtyAllocated: line.qtyAllocated,
      qtyBackordered: line.qtyBackordered,
      qtyInvoiced: line.qtyInvoiced,
      unitListPence: line.unitListPence,
      unitNetPence: line.unitNetPence,
      lineNetPence: line.lineNetPence,
      vatRateBps: line.vatRateBps,
      pricing: line.priceExplanation,
      availability: availability?.[line.id],
    })),
    invoices: invs.map((i) => ({ number: i.number, grossPence: i.grossPence, issuedAt: i.issuedAt, dueDate: i.dueDate })),
    createdBy: order.createdBy,
    createdAt: order.createdAt,
    confirmedAt: order.confirmedAt,
    closedAt: order.closedAt,
  };
}

export type OrderView = Awaited<ReturnType<typeof getOrder>>;

/**
 * Commit a quote: allocate what's free at the depot, backorder the rest.
 * Backorders are picked up automatically when goods are received.
 */
export async function confirmOrder(ctx: ServiceContext, idOrNumber: string) {
  ctx.require('orders:write');
  return ctx.transaction(async (tx) => {
    const order = await loadOrder(tx, idOrNumber, true);
    if (order.status !== 'quote') throw invalidState(`Order ${order.number} is ${order.status}, not a quote`);
    const customer = await getCustomer(tx, order.customerId);
    if (customer.onStop) {
      throw new AppError('CUSTOMER_ON_STOP', `Account ${customer.accountCode} is on stop; credit control must release it first`);
    }
    const lines = await loadLines(tx, order.id);
    const backorders: { partId: string; qty: number }[] = [];
    // Lock stock rows in a stable order to avoid deadlocks between concurrent confirmations.
    for (const line of [...lines].sort((a, b) => a.partId.localeCompare(b.partId))) {
      const level = await lockStock(tx, line.partId, order.depotId);
      const free = Math.max(0, level.onHand - level.allocated);
      const alloc = Math.min(free, line.qty);
      const back = line.qty - alloc;
      if (alloc > 0) await adjustCommitments(tx, line.partId, order.depotId, { allocated: alloc });
      await tx.db.update(salesOrderLines).set({ qtyAllocated: alloc, qtyBackordered: back }).where(eq(salesOrderLines.id, line.id));
      if (back > 0) backorders.push({ partId: line.partId, qty: back });
    }
    await tx.db.update(salesOrders).set({ status: 'confirmed', confirmedAt: new Date() }).where(eq(salesOrders.id, order.id));
    await audit(tx, 'order.confirmed', 'sales_order', order.id, { number: order.number, backorders });
    await emitEvent(tx, 'order.confirmed', 'sales_order', order.id, {
      number: order.number,
      customer: customer.accountCode,
      backorderLines: backorders.length,
    });
    return getOrder(tx, order.id);
  });
}

/** Invoice everything currently allocated on the order. Backordered quantities stay open. */
export async function invoiceOrder(ctx: ServiceContext, idOrNumber: string) {
  ctx.require('invoices:write');
  return ctx.transaction(async (tx) => {
    const order = await loadOrder(tx, idOrNumber, true);
    if (order.status !== 'confirmed' && order.status !== 'part_invoiced') {
      throw invalidState(`Order ${order.number} is ${order.status}; only confirmed orders can be invoiced`);
    }
    const lines = await loadLines(tx, order.id);
    const toInvoice = lines.filter((l) => l.qtyAllocated > 0);
    if (toInvoice.length === 0) throw invalidState(`Nothing allocated on ${order.number} to invoice (all lines backordered)`);
    const customer = await getCustomer(tx, order.customerId);
    const [tenant] = await tx.db.select().from(tenants).where(eq(tenants.id, ctx.tenantId));
    const terms = tenant?.settings.defaultPaymentTermsDays ?? 30;

    const partRows = await tx.db.select().from(parts).where(inArray(parts.id, toInvoice.map((l) => l.partId)));
    const partById = new Map(partRows.map((p) => [p.id, p]));
    let net = 0;
    let vat = 0;
    const invLines = [];
    for (const line of toInvoice) {
      const q = line.qtyAllocated;
      await recordMovement(tx, {
        partId: line.partId,
        depotId: order.depotId,
        type: 'sale',
        qty: -q,
        allocatedDelta: -q,
        unitCostPence: line.unitCostPence,
        referenceType: 'sales_order',
        referenceId: order.number,
      });
      await tx.db
        .update(salesOrderLines)
        .set({ qtyInvoiced: line.qtyInvoiced + q, qtyAllocated: 0 })
        .where(eq(salesOrderLines.id, line.id));
      const lineNet = line.unitNetPence * q;
      const lineVat = applyBps(lineNet, line.vatRateBps);
      net += lineNet;
      vat += lineVat;
      const part = partById.get(line.partId)!;
      invLines.push({
        orderLineId: line.id,
        partId: line.partId,
        description: `${part.partNumber} ${part.description}`,
        qty: q,
        unitNetPence: line.unitNetPence,
        lineNetPence: lineNet,
        vatRateBps: line.vatRateBps,
        lineVatPence: lineVat,
      });
    }
    const number = await nextNumber(tx, 'invoice', 'INV');
    const due = new Date(Date.now() + terms * 86_400_000).toISOString().slice(0, 10);
    const [inv] = await tx.db
      .insert(invoices)
      .values({ tenantId: ctx.tenantId, number, orderId: order.id, customerId: customer.id, netPence: net, vatPence: vat, grossPence: net + vat, dueDate: due })
      .returning();
    await tx.db.insert(invoiceLines).values(invLines.map((l) => ({ ...l, tenantId: ctx.tenantId, invoiceId: inv!.id })));

    const stillOpen = lines.some((l) => l.qtyBackordered > 0);
    await tx.db
      .update(salesOrders)
      .set({ status: stillOpen ? 'part_invoiced' : 'invoiced', closedAt: stillOpen ? null : new Date() })
      .where(eq(salesOrders.id, order.id));

    await audit(tx, 'invoice.created', 'invoice', inv!.id, { number, order: order.number, grossPence: net + vat });
    // Payload carries everything an accounting connector needs, so consumers never call back.
    await emitEvent(tx, 'invoice.created', 'invoice', inv!.id, {
      invoiceNumber: number,
      orderNumber: order.number,
      customerRef: order.customerRef,
      customer: { accountCode: customer.accountCode, name: customer.name, email: customer.email, accountingRef: customer.accountingRef },
      issuedAt: inv!.issuedAt.toISOString(),
      dueDate: due,
      netPence: net,
      vatPence: vat,
      grossPence: net + vat,
      lines: invLines.map((l) => ({
        partNumber: partById.get(l.partId)!.partNumber,
        make: partById.get(l.partId)!.make,
        description: l.description,
        qty: l.qty,
        unitNetPence: l.unitNetPence,
        lineNetPence: l.lineNetPence,
        vatRateBps: l.vatRateBps,
        lineVatPence: l.lineVatPence,
      })),
    });
    return { invoice: { number, netPence: net, vatPence: vat, grossPence: net + vat, dueDate: due }, order: await getOrder(tx, order.id) };
  });
}

/** Cancel what's outstanding. Releases allocations; already-invoiced quantities stand. */
export async function cancelOrder(ctx: ServiceContext, idOrNumber: string, reason: string) {
  ctx.require('orders:write');
  return ctx.transaction(async (tx) => {
    const order = await loadOrder(tx, idOrNumber, true);
    if (order.status === 'invoiced' || order.status === 'cancelled') throw invalidState(`Order ${order.number} is already ${order.status}`);
    const lines = await loadLines(tx, order.id);
    let anyInvoiced = false;
    for (const line of lines) {
      if (line.qtyAllocated > 0) await adjustCommitments(tx, line.partId, order.depotId, { allocated: -line.qtyAllocated });
      if (line.qtyInvoiced > 0) anyInvoiced = true;
      await tx.db
        .update(salesOrderLines)
        .set(line.qtyInvoiced > 0 ? { qty: line.qtyInvoiced, qtyAllocated: 0, qtyBackordered: 0 } : { qtyAllocated: 0, qtyBackordered: 0 })
        .where(eq(salesOrderLines.id, line.id));
    }
    const status = anyInvoiced ? 'invoiced' : 'cancelled';
    await tx.db.update(salesOrders).set({ status, closedAt: new Date() }).where(eq(salesOrders.id, order.id));
    await audit(tx, 'order.cancelled', 'sales_order', order.id, { number: order.number, reason });
    await emitEvent(tx, 'order.cancelled', 'sales_order', order.id, { number: order.number, reason, finalStatus: status });
    return getOrder(tx, order.id);
  });
}

/**
 * After stock arrives, hand it to waiting customer orders, oldest first.
 * Emits backorder.allocated so the counter (or an agent) can ring the customer.
 * Must run inside the receiving transaction.
 */
export async function allocateBackorders(ctx: ServiceContext, partId: string, depotId: string) {
  const waiting = await ctx.db
    .select({ line: salesOrderLines, order: salesOrders })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
    .where(
      and(
        eq(salesOrderLines.tenantId, ctx.tenantId),
        eq(salesOrderLines.partId, partId),
        gt(salesOrderLines.qtyBackordered, 0),
        eq(salesOrders.depotId, depotId),
        or(eq(salesOrders.status, 'confirmed'), eq(salesOrders.status, 'part_invoiced')),
      ),
    )
    .orderBy(asc(salesOrders.confirmedAt), asc(salesOrderLines.lineNo));
  const allocated: { orderNumber: string; qty: number }[] = [];
  for (const { line, order } of waiting) {
    const level = await lockStock(ctx, partId, depotId);
    const free = level.onHand - level.allocated;
    if (free <= 0) break;
    const q = Math.min(free, line.qtyBackordered);
    await adjustCommitments(ctx, partId, depotId, { allocated: q });
    await ctx.db
      .update(salesOrderLines)
      .set({ qtyAllocated: line.qtyAllocated + q, qtyBackordered: line.qtyBackordered - q })
      .where(eq(salesOrderLines.id, line.id));
    const [cust] = await ctx.db.select({ accountCode: customers.accountCode, name: customers.name, phone: customers.phone }).from(customers).where(eq(customers.id, order.customerId));
    await emitEvent(ctx, 'backorder.allocated', 'sales_order', order.id, {
      orderNumber: order.number,
      customer: cust,
      partId,
      qty: q,
      fullyAllocated: q === line.qtyBackordered,
    });
    allocated.push({ orderNumber: order.number, qty: q });
  }
  return allocated;
}

export async function listOrders(
  ctx: ServiceContext,
  opts: { customerAccount?: string | undefined; status?: SalesOrder['status'] | undefined; limit?: number | undefined },
) {
  ctx.require('orders:read');
  const conds = [eq(salesOrders.tenantId, ctx.tenantId)];
  if (opts.customerAccount) conds.push(eq(salesOrders.customerId, (await getCustomerByAccount(ctx, opts.customerAccount)).id));
  if (opts.status) conds.push(eq(salesOrders.status, opts.status));
  return ctx.db
    .select({
      number: salesOrders.number,
      status: salesOrders.status,
      customer: customers.accountCode,
      depot: depots.code,
      grossPence: salesOrders.grossPence,
      createdAt: salesOrders.createdAt,
    })
    .from(salesOrders)
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .innerJoin(depots, eq(depots.id, salesOrders.depotId))
    .where(and(...conds))
    .orderBy(sql`${salesOrders.createdAt} DESC`)
    .limit(Math.min(opts.limit ?? 25, 200));
}
