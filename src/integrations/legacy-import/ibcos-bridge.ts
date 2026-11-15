/**
 * Ibcos Gold bridge: run AgriParts alongside Gold, then migrate off it.
 *
 * Ibcos has no public API; data leaves Gold as report/export files. This
 * module imports those files (customers, parts, stock) through a column
 * mapping, with the same provenance and idempotency rules as price files.
 *
 * Two modes for stock:
 *  - "opening": first load. Posts opening-balance movements so the ledger
 *    starts consistent.
 *  - "sync":    coexistence. Gold is still the system of record for stock;
 *    a nightly export resets our on-hand to Gold's figure via adjustment
 *    movements (so every difference is visible and auditable).
 *
 * IMPORTANT: the default column names below are PLACEHOLDERS. We have not yet
 * seen a real Gold export. Replace them once the reseller/partner dealer
 * provides sample files (see docs/INTEGRATIONS.md, "Ibcos Gold").
 */
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { customers, depots, ingestBatches, ingestIssues, parts, stockLevels } from '../../db/schema.js';
import { parseCsv } from '../../lib/csv.js';
import { AppError } from '../../lib/errors.js';
import { parsePounds } from '../../lib/money.js';
import { normalisePartNumber } from '../../lib/part-number.js';
import { audit, emitEvent, type ServiceContext } from '../../services/context.js';
import { lockStock, recordMovement } from '../../services/stock.js';

export const IBCOS_PLACEHOLDER_MAPPINGS = {
  customers: { account_code: 'Account', name: 'Name', postcode: 'Postcode', phone: 'Telephone', email: 'Email', price_band: 'Price Band', on_stop: 'On Stop' },
  parts: { make: 'Franchise', part_number: 'Part Number', description: 'Description', list_price: 'Retail', cost_price: 'Cost', discount_code: 'Disc Code', bin: 'Bin' },
  stock: { depot: 'Depot', make: 'Franchise', part_number: 'Part Number', on_hand: 'Free Stock', bin: 'Bin', min_qty: 'Min', max_qty: 'Max' },
} as const;

export const LegacyImportSchema = z.object({
  entity: z.enum(['customers', 'parts', 'stock']),
  mode: z.enum(['opening', 'sync']).default('sync'),
  /** Field -> column header. Defaults to the (unconfirmed) Ibcos placeholders. */
  columns: z.record(z.string(), z.string()).optional(),
  delimiter: z.string().length(1).default(','),
  /** Map legacy depot names/codes to AgriParts depot codes. */
  depotMap: z.record(z.string(), z.string()).default({}),
  /** Make to use when the file has no franchise column. */
  defaultMake: z.string().optional(),
});
export type LegacyImportOptions = z.input<typeof LegacyImportSchema>;

interface Issue {
  rowNo: number;
  severity: 'info' | 'warn' | 'error';
  message: string;
  raw?: unknown;
}

export async function importLegacyFile(
  ctx: ServiceContext,
  input: { options: LegacyImportOptions; content: string; sourceName: string; dryRun?: boolean | undefined },
) {
  ctx.require('integrations:write');
  const opts = LegacyImportSchema.parse(input.options);
  const columns: Record<string, string> = opts.columns ?? { ...IBCOS_PLACEHOLDER_MAPPINGS[opts.entity] };
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const checksum = `${sha(input.content)}:${sha(JSON.stringify({ ...opts, columns })).slice(0, 16)}`;
  const kind = `legacy_${opts.entity}`;
  const dryRun = Boolean(input.dryRun);

  if (!dryRun) {
    const [dup] = await ctx.db
      .select({ id: ingestBatches.id })
      .from(ingestBatches)
      .where(and(eq(ingestBatches.tenantId, ctx.tenantId), eq(ingestBatches.kind, kind), eq(ingestBatches.checksum, checksum), eq(ingestBatches.status, 'loaded')));
    if (dup) return { batchId: dup.id, skipped: true, reason: 'already loaded' };
  }

  const table = parseCsv(input.content, opts.delimiter);
  const header = (table[0] ?? []).map((h) => h.trim());
  const idx: Record<string, number> = {};
  for (const [field, col] of Object.entries(columns)) {
    const i = header.indexOf(col);
    if (i >= 0) idx[field] = i;
  }
  const required = { customers: ['account_code', 'name'], parts: ['part_number', 'description'], stock: ['part_number', 'on_hand', 'depot'] }[opts.entity];
  const missing = required.filter((f) => idx[f] === undefined);
  if (missing.length) {
    throw new AppError('VALIDATION', `File is missing required columns for ${opts.entity}: ${missing.map((f) => `${f} ("${columns[f]}")`).join(', ')}`, { header, expected: columns });
  }
  const records = table.slice(1).map((cells, i) => ({
    rowNo: i + 2,
    get: (f: string) => (idx[f] === undefined ? undefined : cells[idx[f]!]?.trim() || undefined),
    raw: Object.fromEntries(header.map((h, j) => [h, cells[j]])),
  }));

  const issues: Issue[] = [];
  const stats = { rows: records.length, created: 0, updated: 0, unchanged: 0, skipped: 0, stockDelta: 0 };

  return ctx.transaction(async (tx) => {
    const [batch] = await tx.db
      .insert(ingestBatches)
      .values({
        tenantId: ctx.tenantId, kind, source: 'ibcos-gold', sourceName: input.sourceName, checksum,
        mapping: { ...opts, columns } as Record<string, unknown>, rowCount: records.length, status: 'running', actor: ctx.actorLabel,
      })
      .returning();
    const batchId = batch!.id;
    const depotRows = await tx.db.select().from(depots).where(eq(depots.tenantId, ctx.tenantId));
    const depotByCode = new Map(depotRows.map((d) => [d.code, d]));

    for (const r of records) {
      try {
        if (opts.entity === 'customers') {
          const code = r.get('account_code')!.toUpperCase();
          const values = {
            name: r.get('name') ?? code,
            postcode: r.get('postcode') ?? null,
            phone: r.get('phone') ?? null,
            email: r.get('email') ?? null,
            priceBand: (r.get('price_band') ?? 'RETAIL').toUpperCase(),
            onStop: /^(y|yes|true|1)$/i.test(r.get('on_stop') ?? ''),
          };
          const [existing] = await tx.db.select().from(customers).where(and(eq(customers.tenantId, ctx.tenantId), eq(customers.accountCode, code)));
          if (existing) {
            await tx.db.update(customers).set(values).where(eq(customers.id, existing.id));
            stats.updated++;
          } else {
            await tx.db.insert(customers).values({ ...values, tenantId: ctx.tenantId, accountCode: code });
            stats.created++;
          }
          continue;
        }

        const make = (r.get('make') ?? opts.defaultMake ?? '').toUpperCase();
        const pn = r.get('part_number');
        if (!pn) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'missing part number', raw: r.raw }); stats.skipped++; continue; }
        if (!make) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'no make/franchise (set defaultMake)', raw: r.raw }); stats.skipped++; continue; }
        const norm = normalisePartNumber(pn);
        let [part] = await tx.db.select().from(parts).where(and(eq(parts.tenantId, ctx.tenantId), eq(parts.make, make), eq(parts.partNumberNorm, norm)));

        if (opts.entity === 'parts') {
          const list = r.get('list_price') ? parsePounds(r.get('list_price')!) : null;
          const cost = r.get('cost_price') ? parsePounds(r.get('cost_price')!) : null;
          if ((r.get('list_price') && list == null) || (r.get('cost_price') && cost == null)) {
            issues.push({ rowNo: r.rowNo, severity: 'error', message: 'unreadable price', raw: r.raw });
            stats.skipped++;
            continue;
          }
          const values = {
            description: r.get('description') ?? part?.description ?? '(no description)',
            listPricePence: list ?? part?.listPricePence ?? 0,
            costPricePence: cost ?? part?.costPricePence ?? 0,
            discountCode: r.get('discount_code') ?? part?.discountCode ?? null,
            priceBatchId: batchId,
            updatedAt: new Date(),
          };
          if (part) { await tx.db.update(parts).set(values).where(eq(parts.id, part.id)); stats.updated++; }
          else { await tx.db.insert(parts).values({ ...values, tenantId: ctx.tenantId, make, partNumber: pn, partNumberNorm: norm }); stats.created++; }
          continue;
        }

        // stock
        const legacyDepot = r.get('depot')!;
        const depotCode = (opts.depotMap[legacyDepot] ?? legacyDepot).toUpperCase();
        const depot = depotByCode.get(depotCode);
        if (!depot) { issues.push({ rowNo: r.rowNo, severity: 'error', message: `unknown depot "${legacyDepot}" (add to depotMap)`, raw: r.raw }); stats.skipped++; continue; }
        const qty = Number(r.get('on_hand'));
        if (!Number.isFinite(qty)) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'unreadable quantity', raw: r.raw }); stats.skipped++; continue; }
        if (!Number.isInteger(qty)) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'fractional quantity not yet supported (see ROADMAP: decimal UoM)', raw: r.raw }); stats.skipped++; continue; }
        if (!part) {
          issues.push({ rowNo: r.rowNo, severity: 'warn', message: `part ${make}/${pn} not in master; created as placeholder`, raw: r.raw });
          [part] = await tx.db.insert(parts).values({ tenantId: ctx.tenantId, make, partNumber: pn, partNumberNorm: norm, description: '(imported from Ibcos stock; no master record)' }).returning();
        }
        const level = await lockStock(tx, part!.id, depot.id);
        const delta = qty - level.onHand;
        if (delta !== 0) {
          await recordMovement(tx, {
            partId: part!.id, depotId: depot.id, type: opts.mode === 'opening' ? 'opening' : 'adjustment', qty: delta,
            unitCostPence: part!.costPricePence, referenceType: 'ingest_batch', referenceId: batchId,
            note: opts.mode === 'opening' ? 'Opening balance from Ibcos Gold' : 'Sync to Ibcos Gold stock figure',
          });
          stats.updated++;
          stats.stockDelta += delta;
          if (opts.mode === 'sync' && Math.abs(delta) > 0) issues.push({ rowNo: r.rowNo, severity: 'info', message: `${depot.code} ${pn}: ${level.onHand} -> ${qty}` });
        } else {
          stats.unchanged++;
        }
        const extra: Record<string, unknown> = {};
        if (r.get('bin')) extra.bin = r.get('bin');
        if (r.get('min_qty')) extra.minQty = Number(r.get('min_qty'));
        if (r.get('max_qty')) extra.maxQty = Number(r.get('max_qty'));
        if (Object.keys(extra).length) {
          await tx.db.update(stockLevels).set(extra).where(and(eq(stockLevels.partId, part!.id), eq(stockLevels.depotId, depot.id)));
        }
      } catch (e) {
        if (e instanceof AppError && e.code === 'INSUFFICIENT_STOCK') {
          issues.push({ rowNo: r.rowNo, severity: 'error', message: 'would drive stock negative', raw: r.raw });
          stats.skipped++;
        } else throw e;
      }
    }

    if (issues.length) {
      await tx.db.insert(ingestIssues).values(issues.map((i) => ({ tenantId: ctx.tenantId, batchId, rowNo: i.rowNo, severity: i.severity, message: i.message, raw: i.raw ?? null })));
    }
    const summary = { ...stats, issues: { error: issues.filter((i) => i.severity === 'error').length, warn: issues.filter((i) => i.severity === 'warn').length, info: issues.filter((i) => i.severity === 'info').length } };
    if (dryRun) {
      // Roll everything back but keep the answer: throw a sentinel, catch outside.
      throw new DryRunResult({ batchId: null, dryRun: true, summary, issues });
    }
    await tx.db.update(ingestBatches).set({ status: 'loaded', summary, finishedAt: new Date() }).where(eq(ingestBatches.id, batchId));
    await audit(tx, `${kind}.loaded`, 'ingest_batch', batchId, summary);
    await emitEvent(tx, 'legacy_import.loaded', 'ingest_batch', batchId, { entity: opts.entity, mode: opts.mode, sourceName: input.sourceName, ...summary });
    return { batchId, dryRun: false, summary, issues };
  }).catch((e) => {
    if (e instanceof DryRunResult) return e.result;
    throw e;
  });
}

class DryRunResult extends Error {
  constructor(readonly result: { batchId: null; dryRun: true; summary: Record<string, unknown>; issues: Issue[] }) {
    super('dry run');
  }
}
