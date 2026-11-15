import { and, asc, eq, gt, ilike, or, sql } from 'drizzle-orm';
import { customers, depots, parts, salesOrderLines, salesOrders } from '../db/schema.js';
import type { ServiceContext } from './context.js';
import { getCustomerByAccount, getDepotByCode } from './lookups.js';
import { listOrders } from './orders.js';

export async function searchCustomers(ctx: ServiceContext, query: string, limit = 10) {
  ctx.require('customers:read');
  const q = `%${query.trim().replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  return ctx.db
    .select({
      accountCode: customers.accountCode,
      name: customers.name,
      postcode: customers.postcode,
      phone: customers.phone,
      priceBand: customers.priceBand,
      onStop: customers.onStop,
    })
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), or(ilike(customers.accountCode, q), ilike(customers.name, q), ilike(customers.postcode, q), ilike(customers.phone, q))))
    .orderBy(asc(customers.name))
    .limit(Math.min(limit, 50));
}

export async function customerSummary(ctx: ServiceContext, accountCode: string) {
  ctx.require('customers:read');
  const c = await getCustomerByAccount(ctx, accountCode);
  return {
    accountCode: c.accountCode,
    name: c.name,
    phone: c.phone,
    email: c.email,
    postcode: c.postcode,
    priceBand: c.priceBand,
    onStop: c.onStop,
    recentOrders: ctx.can('orders:read') ? await listOrders(ctx, { customerAccount: c.accountCode, limit: 10 }) : undefined,
  };
}

/** Customer order lines waiting for stock: the "who do we need to ring when it lands" list. */
export async function listBackorders(ctx: ServiceContext, opts: { depotCode?: string | undefined } = {}) {
  ctx.require('orders:read');
  const depotId = opts.depotCode ? (await getDepotByCode(ctx, opts.depotCode)).id : undefined;
  const rows = await ctx.db
    .select({
      orderNumber: salesOrders.number,
      confirmedAt: salesOrders.confirmedAt,
      depot: depots.code,
      customer: customers.accountCode,
      customerName: customers.name,
      phone: customers.phone,
      make: parts.make,
      partNumber: parts.partNumber,
      description: parts.description,
      qtyBackordered: salesOrderLines.qtyBackordered,
      ageDays: sql<number>`floor(extract(epoch from now() - ${salesOrders.confirmedAt}) / 86400)::int`,
    })
    .from(salesOrderLines)
    .innerJoin(salesOrders, eq(salesOrders.id, salesOrderLines.orderId))
    .innerJoin(customers, eq(customers.id, salesOrders.customerId))
    .innerJoin(depots, eq(depots.id, salesOrders.depotId))
    .innerJoin(parts, eq(parts.id, salesOrderLines.partId))
    .where(
      and(
        eq(salesOrderLines.tenantId, ctx.tenantId),
        gt(salesOrderLines.qtyBackordered, 0),
        or(eq(salesOrders.status, 'confirmed'), eq(salesOrders.status, 'part_invoiced')),
        depotId ? eq(salesOrders.depotId, depotId) : undefined,
      ),
    )
    .orderBy(asc(salesOrders.confirmedAt));
  return rows;
}
