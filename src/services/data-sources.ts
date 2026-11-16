/**
 * Data-source registry (ADR-0005 §1): every feed a dealer's data comes from,
 * with its precedence and when it last loaded. Importers call
 * ensureDataSource() so every batch points at a registered source.
 */
import { and, count, desc, eq, max } from 'drizzle-orm';
import { z } from 'zod';
import { dataSources, ingestBatches } from '../db/schema.js';
import type { ServiceContext } from './context.js';

export const DATA_SOURCE_KINDS = ['dms_export', 'supplier_price_file', 'parts_book', 'manual', 'dealer_upload', 'oem_portal'] as const;
export type DataSourceKind = (typeof DATA_SOURCE_KINDS)[number];

/** Lower wins when two sources disagree about the same fact. */
export const DEFAULT_PRECEDENCE: Record<DataSourceKind, number> = {
  dms_export: 10,
  dealer_upload: 20,
  supplier_price_file: 30,
  parts_book: 40,
  manual: 40,
  oem_portal: 60,
};

export const DataSourceSchema = z.object({
  code: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/, 'lower-case letters, digits and dashes'),
  kind: z.enum(DATA_SOURCE_KINDS),
  name: z.string().min(1).max(200),
  licenceId: z.string().uuid().optional(),
  precedence: z.number().int().min(0).max(100).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
});

/** Find-or-create by code. Safe inside a transaction. */
export async function ensureDataSource(ctx: ServiceContext, input: z.input<typeof DataSourceSchema>) {
  const s = DataSourceSchema.parse(input);
  const [existing] = await ctx.db.select().from(dataSources).where(and(eq(dataSources.tenantId, ctx.tenantId), eq(dataSources.code, s.code)));
  if (existing) return existing;
  const [row] = await ctx.db
    .insert(dataSources)
    .values({
      tenantId: ctx.tenantId, code: s.code, kind: s.kind, name: s.name, licenceId: s.licenceId ?? null,
      precedence: s.precedence ?? DEFAULT_PRECEDENCE[s.kind], config: s.config ?? {},
    })
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [again] = await ctx.db.select().from(dataSources).where(and(eq(dataSources.tenantId, ctx.tenantId), eq(dataSources.code, s.code)));
  return again!;
}

export async function markLoaded(ctx: ServiceContext, dataSourceId: string) {
  await ctx.db.update(dataSources).set({ lastLoadedAt: new Date() }).where(eq(dataSources.id, dataSourceId));
}

/** Every source with how many batches it has loaded and when it last did. */
export async function listDataSources(ctx: ServiceContext) {
  ctx.require('integrations:write');
  const stats = await ctx.db
    .select({ id: ingestBatches.dataSourceId, batches: count(), lastBatch: max(ingestBatches.startedAt) })
    .from(ingestBatches)
    .where(and(eq(ingestBatches.tenantId, ctx.tenantId), eq(ingestBatches.status, 'loaded')))
    .groupBy(ingestBatches.dataSourceId);
  const byId = new Map(stats.map((s) => [s.id, s]));
  const rows = await ctx.db.select().from(dataSources).where(eq(dataSources.tenantId, ctx.tenantId)).orderBy(dataSources.precedence, desc(dataSources.lastLoadedAt));
  return rows.map((r) => ({
    code: r.code, kind: r.kind, name: r.name, precedence: r.precedence, isActive: r.isActive, lastLoadedAt: r.lastLoadedAt,
    batches: Number(byId.get(r.id)?.batches ?? 0),
  }));
}
