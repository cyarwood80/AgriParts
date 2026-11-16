/**
 * Fitment ("what fits what") from licensed parts books: EPC exports, or CSVs
 * produced from a parts-book PDF by the content pipeline. Same provenance and
 * idempotency rules as the other importers (ADR-0005 §3):
 *
 *  - every line records its batch, and the parts-book page and figure callout
 *  - serial breaks are kept (serial_from / serial_to)
 *  - lines a person has verified are not overwritten by a different source
 *  - re-loading the same file is a no-op
 *
 * Also: inferFitmentFromSales() proposes low-confidence lines from what was
 * repeatedly sold against a model. Those are shown as unverified, always.
 */
import { createHash } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { ingestBatches, ingestIssues, machineModels, machines, partFitment, partSalesHistory, serviceDocuments } from '../../db/schema.js';
import { parseCsv } from '../../lib/csv.js';
import { AppError, notFound } from '../../lib/errors.js';
import { normalisePartNumber } from '../../lib/part-number.js';
import { audit, emitEvent, type ServiceContext } from '../../services/context.js';
import { ensureDataSource, markLoaded } from '../../services/data-sources.js';

export const FITMENT_DEFAULT_COLUMNS = {
  model: 'Model', make: 'Make', part_number: 'Part Number', assembly: 'Assembly', qty: 'Qty',
  figure: 'Figure', page: 'Page', serial_from: 'Serial From', serial_to: 'Serial To',
} as const;

export const FitmentImportSchema = z.object({
  /** Registered data-source code, e.g. "mcconnel-parts-books". Created if new. */
  sourceCode: z.string().regex(/^[a-z0-9][a-z0-9-]{1,60}$/),
  sourceKind: z.enum(['parts_book', 'oem_epc']).default('parts_book'),
  /** The licensed parts book these lines came from (page refs point into it). */
  documentId: z.string().uuid().optional(),
  columns: z.record(z.string(), z.string()).optional(),
  delimiter: z.string().length(1).default(','),
  defaultMake: z.string().optional(),
  /** Create machine models that aren't in the register yet (otherwise: error). */
  createModels: z.boolean().default(true),
});
export type FitmentImportOptions = z.input<typeof FitmentImportSchema>;

interface Issue { rowNo: number; severity: 'info' | 'warn' | 'error'; message: string; raw?: unknown }

export async function importFitment(ctx: ServiceContext, input: { options: FitmentImportOptions; content: string; sourceName: string; dryRun?: boolean | undefined }) {
  ctx.require('integrations:write');
  const opts = FitmentImportSchema.parse(input.options);
  const columns: Record<string, string> = opts.columns ?? { ...FITMENT_DEFAULT_COLUMNS };
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const checksum = `${sha(input.content)}:${sha(JSON.stringify({ ...opts, columns })).slice(0, 16)}`;
  const dryRun = Boolean(input.dryRun);

  if (opts.documentId) {
    const [d] = await ctx.db.select({ id: serviceDocuments.id }).from(serviceDocuments).where(and(eq(serviceDocuments.tenantId, ctx.tenantId), eq(serviceDocuments.id, opts.documentId)));
    if (!d) throw notFound('Document', opts.documentId);
  }
  if (!dryRun) {
    const [dup] = await ctx.db.select({ id: ingestBatches.id }).from(ingestBatches)
      .where(and(eq(ingestBatches.tenantId, ctx.tenantId), eq(ingestBatches.kind, 'fitment'), eq(ingestBatches.checksum, checksum), eq(ingestBatches.status, 'loaded')));
    if (dup) return { batchId: dup.id, skipped: true, reason: 'already loaded' };
  }

  const table = parseCsv(input.content, opts.delimiter);
  const header = (table[0] ?? []).map((h) => h.trim());
  const idx: Record<string, number> = {};
  for (const [field, col] of Object.entries(columns)) {
    const i = header.indexOf(col);
    if (i >= 0) idx[field] = i;
  }
  const missing = ['model', 'part_number'].filter((f) => idx[f] === undefined);
  if (missing.length) throw new AppError('VALIDATION', `Fitment file is missing columns: ${missing.map((f) => `${f} ("${columns[f]}")`).join(', ')}`, { header, expected: columns });
  const rows = table.slice(1).filter((c) => c.some((x) => x.trim())).map((cells, i) => ({
    rowNo: i + 2,
    get: (f: string) => (idx[f] === undefined ? undefined : cells[idx[f]!]?.trim() || undefined),
    raw: Object.fromEntries(header.map((h, j) => [h, cells[j]])),
  }));
  const issues: Issue[] = [];
  const stats = { rows: rows.length, created: 0, updated: 0, unchanged: 0, skipped: 0, modelsCreated: 0 };

  const run = ctx.transaction(async (tx) => {
    const source = await ensureDataSource(tx, { code: opts.sourceCode, kind: 'parts_book', name: `Parts books: ${opts.sourceCode}` });
    const [batch] = await tx.db.insert(ingestBatches).values({
      tenantId: tx.tenantId, kind: 'fitment', source: opts.sourceCode, dataSourceId: source.id, sourceName: input.sourceName, checksum,
      mapping: { ...opts, columns } as Record<string, unknown>, rowCount: rows.length, status: 'running', actor: tx.actorLabel,
    }).returning();
    const batchId = batch!.id;
    const models = await tx.db.select().from(machineModels).where(eq(machineModels.tenantId, tx.tenantId));
    const modelByKey = new Map(models.map((m) => [`${m.make}|${m.model.toUpperCase()}`, m.id]));

    for (const r of rows) {
      const make = (r.get('make') ?? opts.defaultMake ?? '').toUpperCase();
      const modelName = r.get('model')!;
      const pn = r.get('part_number');
      if (!make) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'no make (set defaultMake)', raw: r.raw }); stats.skipped++; continue; }
      if (!pn) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'missing part number', raw: r.raw }); stats.skipped++; continue; }
      const qty = r.get('qty') ? Number(r.get('qty')) : 1;
      if (!Number.isInteger(qty) || qty < 1) { issues.push({ rowNo: r.rowNo, severity: 'error', message: `bad quantity "${r.get('qty')}"`, raw: r.raw }); stats.skipped++; continue; }
      const page = r.get('page') ? Number(r.get('page')) : null;
      if (page !== null && (!Number.isInteger(page) || page < 1)) { issues.push({ rowNo: r.rowNo, severity: 'warn', message: `ignored bad page "${r.get('page')}"` }); }

      const mKey = `${make}|${modelName.toUpperCase()}`;
      let modelId = modelByKey.get(mKey);
      if (!modelId) {
        if (!opts.createModels) { issues.push({ rowNo: r.rowNo, severity: 'error', message: `unknown model ${make} ${modelName}`, raw: r.raw }); stats.skipped++; continue; }
        const [m] = await tx.db.insert(machineModels).values({ tenantId: tx.tenantId, make, model: modelName }).returning();
        modelId = m!.id;
        modelByKey.set(mKey, modelId);
        stats.modelsCreated++;
      }
      const norm = normalisePartNumber(pn);
      const values = {
        assembly: r.get('assembly') ?? null, qtyPerMachine: qty, source: opts.sourceKind, batchId, documentId: opts.documentId ?? null,
        page: page !== null && Number.isInteger(page) && page > 0 ? page : null, figureRef: r.get('figure') ?? null,
        serialFrom: r.get('serial_from') ?? null, serialTo: r.get('serial_to') ?? null, confidence: 100,
      };
      const [existing] = await tx.db.select().from(partFitment)
        .where(and(eq(partFitment.machineModelId, modelId), eq(partFitment.make, make), eq(partFitment.partNumberNorm, norm)));
      if (!existing) {
        await tx.db.insert(partFitment).values({ ...values, tenantId: tx.tenantId, machineModelId: modelId, make, partNumberNorm: norm });
        stats.created++;
        continue;
      }
      if (existing.verifiedBy && existing.source !== opts.sourceKind) {
        issues.push({ rowNo: r.rowNo, severity: 'info', message: `${make} ${pn} on ${modelName}: kept line verified by ${existing.verifiedBy}` });
        stats.unchanged++;
        continue;
      }
      // Same part twice on one model with different serial ranges: keep the widest range (ADR-0005 §3).
      if (existing.batchId === batchId) {
        const from = minSerial(existing.serialFrom, values.serialFrom);
        const to = maxSerial(existing.serialTo, values.serialTo);
        issues.push({ rowNo: r.rowNo, severity: 'warn', message: `${make} ${pn} appears twice for ${modelName}; merged serial range ${from ?? '*'}-${to ?? '*'}` });
        await tx.db.update(partFitment).set({ serialFrom: from, serialTo: to, qtyPerMachine: Math.max(existing.qtyPerMachine, qty) })
          .where(and(eq(partFitment.machineModelId, modelId), eq(partFitment.make, make), eq(partFitment.partNumberNorm, norm)));
        stats.updated++;
        continue;
      }
      await tx.db.update(partFitment).set({ ...values, verifiedBy: existing.source === opts.sourceKind ? existing.verifiedBy : null })
        .where(and(eq(partFitment.machineModelId, modelId), eq(partFitment.make, make), eq(partFitment.partNumberNorm, norm)));
      stats.updated++;
    }

    if (issues.length) await tx.db.insert(ingestIssues).values(issues.map((i) => ({ tenantId: tx.tenantId, batchId, rowNo: i.rowNo, severity: i.severity, message: i.message, raw: i.raw ?? null })));
    const summary = { ...stats, issues: { error: issues.filter((i) => i.severity === 'error').length, warn: issues.filter((i) => i.severity === 'warn').length, info: issues.filter((i) => i.severity === 'info').length } };
    if (dryRun) throw new DryRun({ batchId: null, dryRun: true, summary, issues });
    await tx.db.update(ingestBatches).set({ status: 'loaded', summary, finishedAt: new Date() }).where(eq(ingestBatches.id, batchId));
    await markLoaded(tx, source.id);
    await audit(tx, 'fitment.loaded', 'ingest_batch', batchId, summary);
    await emitEvent(tx, 'fitment.loaded', 'ingest_batch', batchId, { source: opts.sourceCode, sourceName: input.sourceName, ...summary });
    return { batchId, dryRun: false, summary, issues };
  });
  return run.catch((e) => {
    if (e instanceof DryRun) return e.result;
    throw e;
  });
}

// Serials are compared as strings with numeric awareness ("J002198" < "J010000").
const cmp = (a: string, b: string) => a.localeCompare(b, 'en', { numeric: true });
const minSerial = (a: string | null, b: string | null) => (a == null || b == null ? null : cmp(a, b) <= 0 ? a : b);
const maxSerial = (a: string | null, b: string | null) => (a == null || b == null ? null : cmp(a, b) >= 0 ? a : b);

class DryRun extends Error {
  constructor(readonly result: { batchId: null; dryRun: true; summary: Record<string, unknown>; issues: Issue[] }) { super('dry run'); }
}

/**
 * Propose fitment from sales history: a part sold against machines of the same
 * model on at least `minInvoices` separate invoices becomes a `sales_inferred`
 * line with confidence scaled by evidence (capped at 70: never as good as a
 * parts book). Existing lines from any source are left alone.
 */
export async function inferFitmentFromSales(ctx: ServiceContext, opts: { minInvoices?: number } = {}) {
  ctx.require('integrations:write');
  const minInvoices = Math.max(2, opts.minInvoices ?? 3);
  const candidates = await ctx.db
    .select({
      machineModelId: machines.machineModelId,
      make: partSalesHistory.make,
      norm: partSalesHistory.partNumberNorm,
      invoices: sql<number>`count(distinct ${partSalesHistory.invoiceRef})`.mapWith(Number),
      machinesSeen: sql<number>`count(distinct ${partSalesHistory.machineId})`.mapWith(Number),
    })
    .from(partSalesHistory)
    .innerJoin(machines, eq(machines.id, partSalesHistory.machineId))
    .where(eq(partSalesHistory.tenantId, ctx.tenantId))
    .groupBy(machines.machineModelId, partSalesHistory.make, partSalesHistory.partNumberNorm)
    .having(sql`count(distinct ${partSalesHistory.invoiceRef}) >= ${minInvoices}`);
  let created = 0;
  for (const c of candidates) {
    const confidence = Math.min(70, 30 + c.invoices * 5 + c.machinesSeen * 5);
    const r = await ctx.db.insert(partFitment)
      .values({ tenantId: ctx.tenantId, machineModelId: c.machineModelId, make: c.make, partNumberNorm: c.norm, source: 'sales_inferred', confidence, assembly: null })
      .onConflictDoNothing()
      .returning({ m: partFitment.machineModelId });
    created += r.length;
  }
  await audit(ctx, 'fitment.inferred', 'part_fitment', 'sales_history', { candidates: candidates.length, created, minInvoices });
  return { candidates: candidates.length, created, minInvoices };
}
