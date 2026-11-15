import { and, eq } from 'drizzle-orm';
import { customers, depots, suppliers } from '../db/schema.js';
import { notFound } from '../lib/errors.js';
import type { ServiceContext } from './context.js';

export async function listDepots(ctx: ServiceContext) {
  return ctx.db.select().from(depots).where(eq(depots.tenantId, ctx.tenantId)).orderBy(depots.code);
}

export async function getDepotByCode(ctx: ServiceContext, code: string) {
  const [d] = await ctx.db
    .select()
    .from(depots)
    .where(and(eq(depots.tenantId, ctx.tenantId), eq(depots.code, code.toUpperCase())));
  if (!d) throw notFound('Depot', code);
  return d;
}

export async function getDepot(ctx: ServiceContext, id: string) {
  const [d] = await ctx.db.select().from(depots).where(and(eq(depots.tenantId, ctx.tenantId), eq(depots.id, id)));
  if (!d) throw notFound('Depot', id);
  return d;
}

export async function getSupplierByCode(ctx: ServiceContext, code: string) {
  const [s] = await ctx.db
    .select()
    .from(suppliers)
    .where(and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.code, code.toUpperCase())));
  if (!s) throw notFound('Supplier', code);
  return s;
}

export async function getSupplier(ctx: ServiceContext, id: string) {
  const [s] = await ctx.db.select().from(suppliers).where(and(eq(suppliers.tenantId, ctx.tenantId), eq(suppliers.id, id)));
  if (!s) throw notFound('Supplier', id);
  return s;
}

export async function getCustomer(ctx: ServiceContext, id: string) {
  const [c] = await ctx.db.select().from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.id, id)));
  if (!c) throw notFound('Customer', id);
  return c;
}

export async function getCustomerByAccount(ctx: ServiceContext, accountCode: string) {
  const [c] = await ctx.db
    .select()
    .from(customers)
    .where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.accountCode, accountCode.toUpperCase())));
  if (!c) throw notFound('Customer account', accountCode);
  return c;
}
