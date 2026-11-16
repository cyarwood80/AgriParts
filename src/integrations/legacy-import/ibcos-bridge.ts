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
import { customers, depots, ingestBatches, ingestIssues, machineModels, machines, parts, partSalesHistory, stockLevels } from '../../db/schema.js';
import { parseCsv } from '../../lib/csv.js';
import { AppError } from '../../lib/errors.js';
import { parsePounds } from '../../lib/money.js';
import { normalisePartNumber } from '../../lib/part-number.js';
import { audit, emitEvent, type ServiceContext } from '../../services/context.js';
import { ensureDataSource, markLoaded } from '../../services/data-sources.js';
import { lockStock, recordMovement } from '../../services/stock.js';

export const IBCOS_PLACEHOLDER_MAPPINGS = {
  customers: { account_code: 'Account', name: 'Name', postcode: 'Postcode', phone: 'Telephone', email: 'Email', price_band: 'Price Band', on_stop: 'On Stop' },
  parts: { make: 'Franchise', part_number: 'Part Number', description: 'Description', list_price: 'Retail', cost_price: 'Cost', discount_code: 'Disc Code', bin: 'Bin' },
  stock: { depot: 'Depot', make: 'Franchise', part_number: 'Part Number', on_hand: 'Free Stock', bin: 'Bin', min_qty: 'Min', max_qty: 'Max' },
  /** Wholegoods register: the machines customers own. */
  machines: { serial: 'Serial No', make: 'Make', model: 'Model', account_code: 'Account', year: 'Year', hours: 'Hours', reg_no: 'Reg No', kind: 'Type' },
  /** Parts sales lines (invoice history). */
  sales_history: { invoice_ref: 'Invoice No', line_no: 'Line', invoiced_on: 'Invoice Date', account_code: 'Account', serial: 'Serial No', make: 'Franchise', part_number: 'Part Number', qty: 'Qty', net: 'Net Value' },
} as const;

export const LegacyImportSchema = z.object({
  entity: z.enum(['customers', 'parts', 'stock', 'machines', 'sales_history']),
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
  const required = {
    customers: ['account_code', 'name'], parts: ['part_number', 'description'], stock: ['part_number', 'on_hand', 'depot'],
    machines: ['serial', 'model'], sales_history: ['invoice_ref', 'invoiced_on', 'part_number', 'qty'],
  }[opts.entity];
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
    const source = await ensureDataSource(tx, { code: 'ibcos-gold', kind: 'dms_export', name: 'Ibcos Gold exports' });
    const [batch] = await tx.db
      .insert(ingestBatches)
      .values({
        tenantId: ctx.tenantId, kind, source: 'ibcos-gold', dataSourceId: source.id, sourceName: input.sourceName, checksum,
        mapping: { ...opts, columns } as Record<string, unknown>, rowCount: records.length, status: 'running', actor: ctx.actorLabel,
      })
      .returning();
    const batchId = batch!.id;
    const depotRows = await tx.db.select().from(depots).where(eq(depots.tenantId, ctx.tenantId));
    const depotByCode = new Map(depotRows.map((d) => [d.code, d]));
    const custByCode = new Map<string, string>();
    const modelByKey = new Map<string, string>();
    if (opts.entity === 'machines' || opts.entity === 'sales_history') {
      for (const c of await tx.db.select({ id: customers.id, code: customers.accountCode }).from(customers).where(eq(customers.tenantId, ctx.tenantId))) custByCode.set(c.code, c.id);
      for (const m of await tx.db.select().from(machineModels).where(eq(machineModels.tenantId, ctx.tenantId))) modelByKey.set(`${m.make}|${m.model.toUpperCase()}`, m.id);
    }

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

        if (opts.entity === 'machines') {
          stats[await upsertMachine(tx, r, opts.defaultMake, custByCode, modelByKey, issues)]++;
          continue;
        }
        if (opts.entity === 'sales_history') {
          stats[await insertSalesLine(tx, r, batchId, opts.defaultMake, custByCode, issues)]++;
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
    await markLoaded(tx, source.id);
    await audit(tx, `${kind}.loaded`, 'ingest_batch', batchId, summary);
    await emitEvent(tx, 'legacy_import.loaded', 'ingest_batch', batchId, { entity: opts.entity, mode: opts.mode, sourceName: input.sourceName, ...summary });
    return { batchId, dryRun: false, summary, issues };
  }).catch((e) => {
    if (e instanceof DryRunResult) return e.result;
    throw e;
  });
}

type Row = { rowNo: number; get: (f: string) => string | undefined; raw: Record<string, unknown> };
type Outcome = 'created' | 'updated' | 'unchanged' | 'skipped';

/** dd/mm/yyyy (UK DMS exports), dd-mm-yyyy or ISO yyyy-mm-dd -> ISO date, else null. */
export function parseUkDate(s: string): string | null {
  const t = s.trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(t);
  if (!m) return null;
  const [d, mo, yRaw] = [Number(m[1]), Number(m[2]), m[3]!];
  const y = yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const iso = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) === iso ? iso : null;
}

const intOrNull = (s: string | undefined) => {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ''));
  return Number.isInteger(n) ? n : null;
};

/** Wholegoods register line -> machine (model created on first sight; owner changes update the row). */
async function upsertMachine(
  tx: ServiceContext, r: Row, defaultMake: string | undefined,
  custByCode: Map<string, string>, modelByKey: Map<string, string>, issues: Issue[],
): Promise<Outcome> {
  const serial = r.get('serial')!.trim();
  const make = (r.get('make') ?? defaultMake ?? '').toUpperCase();
  const model = r.get('model')!.trim();
  if (!make) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'no make (set defaultMake)', raw: r.raw }); return 'skipped'; }
  const key = `${make}|${model.toUpperCase()}`;
  let modelId = modelByKey.get(key);
  if (!modelId) {
    const [m] = await tx.db.insert(machineModels).values({ tenantId: tx.tenantId, make, model, kind: r.get('kind') ?? null }).returning();
    modelId = m!.id;
    modelByKey.set(key, modelId);
    issues.push({ rowNo: r.rowNo, severity: 'info', message: `new machine model ${make} ${model}` });
  }
  const acct = r.get('account_code')?.toUpperCase();
  const customerId = acct ? custByCode.get(acct) ?? null : null;
  if (acct && !customerId) issues.push({ rowNo: r.rowNo, severity: 'warn', message: `customer ${acct} not found; machine loaded without owner (load customers first)`, raw: r.raw });
  const values = {
    machineModelId: modelId, customerId, regNo: r.get('reg_no') ?? null,
    year: intOrNull(r.get('year')), engineHours: intOrNull(r.get('hours')),
  };
  const [existing] = await tx.db.select().from(machines).where(and(eq(machines.tenantId, tx.tenantId), eq(machines.serial, serial)));
  if (!existing) {
    await tx.db.insert(machines).values({ ...values, tenantId: tx.tenantId, serial });
    return 'created';
  }
  // Hours only go up; a lower figure is usually a typo or a replaced clock. Keep ours and say so.
  if (existing.engineHours != null && values.engineHours != null && values.engineHours < existing.engineHours) {
    issues.push({ rowNo: r.rowNo, severity: 'warn', message: `${serial} hours went down (${existing.engineHours} -> ${values.engineHours}); kept ${existing.engineHours}` });
    values.engineHours = existing.engineHours;
  }
  // A blank in the export doesn't wipe what we know.
  if (values.engineHours == null) values.engineHours = existing.engineHours;
  if (values.year == null) values.year = existing.year;
  if (values.regNo == null) values.regNo = existing.regNo;
  const changed = existing.machineModelId !== values.machineModelId || existing.customerId !== values.customerId || existing.regNo !== values.regNo
    || existing.year !== values.year || existing.engineHours !== values.engineHours;
  if (!changed) return 'unchanged';
  if (existing.customerId && values.customerId && existing.customerId !== values.customerId) {
    issues.push({ rowNo: r.rowNo, severity: 'info', message: `${serial} changed owner` });
  }
  await tx.db.update(machines).set(values).where(eq(machines.id, existing.id));
  return 'updated';
}

/** Invoice line -> part_sales_history. Idempotent on (invoice, line). */
async function insertSalesLine(
  tx: ServiceContext, r: Row, batchId: string, defaultMake: string | undefined,
  custByCode: Map<string, string>, issues: Issue[],
): Promise<Outcome> {
  const pn = r.get('part_number')!;
  const make = (r.get('make') ?? defaultMake ?? '').toUpperCase();
  if (!make) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'no make/franchise (set defaultMake)', raw: r.raw }); return 'skipped'; }
  const invoicedOn = parseUkDate(r.get('invoiced_on')!);
  if (!invoicedOn) { issues.push({ rowNo: r.rowNo, severity: 'error', message: `unreadable date "${r.get('invoiced_on')}"`, raw: r.raw }); return 'skipped'; }
  const qty = intOrNull(r.get('qty'));
  if (qty == null) { issues.push({ rowNo: r.rowNo, severity: 'error', message: 'unreadable or fractional quantity', raw: r.raw }); return 'skipped'; }
  const net = r.get('net') ? parsePounds(r.get('net')!) : null;
  const acct = r.get('account_code')?.toUpperCase();
  const customerId = acct ? custByCode.get(acct) ?? null : null;
  if (acct && !customerId) issues.push({ rowNo: r.rowNo, severity: 'warn', message: `customer ${acct} not found; line kept without customer`, raw: r.raw });
  let machineId: string | null = null;
  const serial = r.get('serial');
  if (serial) {
    const [m] = await tx.db.select({ id: machines.id }).from(machines).where(and(eq(machines.tenantId, tx.tenantId), eq(machines.serial, serial.trim())));
    machineId = m?.id ?? null;
    if (!m) issues.push({ rowNo: r.rowNo, severity: 'warn', message: `machine ${serial} not in register; line kept without machine (load machines first)` });
  }
  const inserted = await tx.db
    .insert(partSalesHistory)
    .values({
      tenantId: tx.tenantId, invoiceRef: r.get('invoice_ref')!.trim(), lineNo: intOrNull(r.get('line_no')) ?? 1, invoicedOn,
      customerId, machineId, make, partNumber: pn, partNumberNorm: normalisePartNumber(pn), qty, netPence: net, batchId,
    })
    .onConflictDoNothing()
    .returning({ id: partSalesHistory.id });
  return inserted.length ? 'created' : 'unchanged';
}

class DryRunResult extends Error {
  constructor(readonly result: { batchId: null; dryRun: true; summary: Record<string, unknown>; issues: Issue[] }) {
    super('dry run');
  }
}
