/**
 * Supplier / manufacturer price-file import.
 *
 * Evolved from AgriParts v1's loader, keeping its rules:
 *  - a JSON mapping says which column is which (files are never the same twice)
 *  - bad rows become issues instead of stopping the load
 *  - the same file (by checksum) is never loaded twice for a supplier
 *  - every part/price/supersession records the batch it came from
 * and adding:
 *  - dry run with a full diff (new parts, price changes, big-move warnings) so a
 *    parts manager can review a price file before it changes the counter
 *  - delimited or fixed-width formats
 */
import { createHash } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';
import { ingestBatches, ingestIssues, partSupersessions, parts } from '../../db/schema.js';
import { parseCsv } from '../../lib/csv.js';
import { AppError } from '../../lib/errors.js';
import { normalisePartNumber } from '../../lib/part-number.js';
import { audit, emitEvent, type ServiceContext } from '../../services/context.js';
import { getSupplierByCode } from '../../services/lookups.js';

const FIELDS = ['part_number', 'description', 'list_price', 'net_price', 'supersedes', 'superseded_by', 'pack_qty', 'discount_code', 'barcode', 'uom'] as const;
type Field = (typeof FIELDS)[number];

export const PriceFileMappingSchema = z.object({
  /** Supplier code in AgriParts. */
  supplier: z.string(),
  /** Make (franchise/brand code) the parts belong to. */
  make: z.string(),
  format: z
    .object({
      delimiter: z.string().length(1).default(','),
      /** Fixed-width files: field -> [start (0-based), length]. Header row not expected. */
      fixedWidth: z.record(z.string(), z.tuple([z.number().int().min(0), z.number().int().positive()])).optional(),
      skipRows: z.number().int().min(0).default(0),
    })
    .default({ delimiter: ',', skipRows: 0 }),
  /** Field -> column header (delimited files). */
  columns: z.record(z.string(), z.string()).default({}),
  /** 100 if the file gives pence. */
  price_divisor: z.number().positive().default(1),
  skip_if_description_matches: z.string().optional(),
  /** Warn when a price moves by more than this percentage. */
  price_change_warn_pct: z.number().positive().default(25),
});
export type PriceFileMapping = z.infer<typeof PriceFileMappingSchema>;

export interface PriceFileIssue {
  rowNo: number;
  severity: 'info' | 'warn' | 'error';
  message: string;
  raw?: unknown;
}

interface ParsedRow {
  rowNo: number;
  partNumber: string;
  norm: string;
  description: string | null;
  listPence: number | null;
  netPence: number | null;
  supersedes: string | null;
  supersededBy: string | null;
  packQty: number | null;
  discountCode: string | null;
  barcode: string | null;
  uom: string | null;
}

function money(v: string | undefined, divisor: number): number | null | typeof NaN {
  if (v == null || v.trim() === '') return null;
  const n = Number(v.replace(/[£,\s]/g, ''));
  return Number.isFinite(n) ? Math.round((n / divisor) * 100) : NaN;
}

function extractRecords(content: string, mapping: PriceFileMapping): { records: { rowNo: number; get: (f: Field) => string | undefined; raw: unknown }[] } {
  const fmt = mapping.format;
  if (fmt.fixedWidth) {
    const lines = content.replace(/^﻿/, '').split(/\r?\n/);
    const records = [];
    for (let i = fmt.skipRows; i < lines.length; i++) {
      const line = lines[i]!;
      if (!line.trim()) continue;
      const get = (f: Field) => {
        const spec = fmt.fixedWidth![f];
        return spec ? line.slice(spec[0], spec[0] + spec[1]).trim() : undefined;
      };
      records.push({ rowNo: i + 1, get, raw: line });
    }
    return { records };
  }
  const table = parseCsv(content, fmt.delimiter).slice(fmt.skipRows);
  const header = (table[0] ?? []).map((h) => h.trim());
  const idx: Partial<Record<Field, number>> = {};
  for (const [field, col] of Object.entries(mapping.columns)) {
    if (!FIELDS.includes(field as Field)) throw new AppError('VALIDATION', `Unknown mapping field "${field}"`);
    const i = header.indexOf(col);
    if (i < 0) throw new AppError('VALIDATION', `Column "${col}" (for ${field}) not found in file header`, { header });
    idx[field as Field] = i;
  }
  if (idx.part_number === undefined) throw new AppError('VALIDATION', 'Mapping must include part_number');
  return {
    records: table.slice(1).map((cells, i) => ({
      rowNo: i + 2 + fmt.skipRows,
      get: (f: Field) => (idx[f] === undefined ? undefined : cells[idx[f]!]?.trim()),
      raw: Object.fromEntries(header.map((h, j) => [h, cells[j]])),
    })),
  };
}

export function parsePriceFile(content: string, mapping: PriceFileMapping) {
  const issues: PriceFileIssue[] = [];
  const rows = new Map<string, ParsedRow>();
  const { records } = extractRecords(content, mapping);
  const skip = mapping.skip_if_description_matches ? new RegExp(mapping.skip_if_description_matches, 'i') : null;
  for (const r of records) {
    const pn = r.get('part_number') ?? '';
    const desc = r.get('description') ?? null;
    if (!pn) {
      issues.push({ rowNo: r.rowNo, severity: 'error', message: 'missing part number', raw: r.raw });
      continue;
    }
    if (skip && desc && skip.test(desc)) {
      issues.push({ rowNo: r.rowNo, severity: 'info', message: 'skipped by mapping rule', raw: r.raw });
      continue;
    }
    const list = money(r.get('list_price'), mapping.price_divisor);
    const net = money(r.get('net_price'), mapping.price_divisor);
    if (Number.isNaN(list) || Number.isNaN(net)) {
      issues.push({ rowNo: r.rowNo, severity: 'error', message: 'unreadable price', raw: r.raw });
      continue;
    }
    if (list != null && net != null && net > list) issues.push({ rowNo: r.rowNo, severity: 'warn', message: 'net price above list price', raw: r.raw });
    const norm = normalisePartNumber(pn);
    if (rows.has(norm)) issues.push({ rowNo: r.rowNo, severity: 'warn', message: `duplicate part number in file (row ${rows.get(norm)!.rowNo}); later row wins`, raw: r.raw });
    const pack = r.get('pack_qty');
    rows.set(norm, {
      rowNo: r.rowNo,
      partNumber: pn,
      norm,
      description: desc || null,
      listPence: list,
      netPence: net,
      supersedes: r.get('supersedes') || null,
      supersededBy: r.get('superseded_by') || null,
      packQty: pack ? Math.max(1, Number.parseInt(pack, 10) || 1) : null,
      discountCode: r.get('discount_code') || null,
      barcode: r.get('barcode') || null,
      uom: r.get('uom') || null,
    });
  }
  return { rowCount: records.length, rows: [...rows.values()], issues };
}

export interface PriceFileResult {
  batchId: string | null;
  skipped?: boolean;
  reason?: string;
  dryRun: boolean;
  rows: number;
  loaded: number;
  created: { partNumber: string; listPence: number | null }[];
  priceChanges: { partNumber: string; oldListPence: number; newListPence: number; changePct: number }[];
  unchanged: number;
  supersessions: { from: string; to: string }[];
  issues: { error: number; warn: number; info: number };
  issueDetail: PriceFileIssue[];
}

export async function importPriceFile(
  ctx: ServiceContext,
  input: { mapping: unknown; content: string; sourceName: string; dryRun?: boolean | undefined },
): Promise<PriceFileResult> {
  ctx.require('integrations:write');
  const mapping = PriceFileMappingSchema.parse(input.mapping);
  const make = mapping.make.toUpperCase();
  const supplier = await getSupplierByCode(ctx, mapping.supplier);
  // Idempotency key: the file AND the mapping. Re-loading the same file with a
  // corrected mapping is a legitimate new load.
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');
  const checksum = `${sha(input.content)}:${sha(JSON.stringify(mapping)).slice(0, 16)}`;
  const dryRun = Boolean(input.dryRun);

  if (!dryRun) {
    const [dup] = await ctx.db
      .select({ id: ingestBatches.id })
      .from(ingestBatches)
      .where(and(eq(ingestBatches.tenantId, ctx.tenantId), eq(ingestBatches.kind, 'price_file'), eq(ingestBatches.source, supplier.code), eq(ingestBatches.checksum, checksum), eq(ingestBatches.status, 'loaded')));
    if (dup) {
      return { batchId: dup.id, skipped: true, reason: 'already loaded', dryRun, rows: 0, loaded: 0, created: [], priceChanges: [], unchanged: 0, supersessions: [], issues: { error: 0, warn: 0, info: 0 }, issueDetail: [] };
    }
  }

  const parsed = parsePriceFile(input.content, mapping);
  const issues = [...parsed.issues];
  const existing = parsed.rows.length
    ? await ctx.db.select().from(parts).where(and(eq(parts.tenantId, ctx.tenantId), eq(parts.make, make), inArray(parts.partNumberNorm, parsed.rows.map((r) => r.norm))))
    : [];
  const byNorm = new Map(existing.map((p) => [p.partNumberNorm, p]));

  const created: PriceFileResult['created'] = [];
  const priceChanges: PriceFileResult['priceChanges'] = [];
  const supersessions: PriceFileResult['supersessions'] = [];
  let unchanged = 0;
  for (const r of parsed.rows) {
    const old = byNorm.get(r.norm);
    if (!old) {
      created.push({ partNumber: r.partNumber, listPence: r.listPence });
      if (r.listPence == null) issues.push({ rowNo: r.rowNo, severity: 'warn', message: 'new part without list price' });
    } else if (r.listPence != null && r.listPence !== old.listPricePence) {
      const pct = old.listPricePence > 0 ? Math.round(((r.listPence - old.listPricePence) / old.listPricePence) * 1000) / 10 : 100;
      priceChanges.push({ partNumber: r.partNumber, oldListPence: old.listPricePence, newListPence: r.listPence, changePct: pct });
      if (Math.abs(pct) > mapping.price_change_warn_pct) issues.push({ rowNo: r.rowNo, severity: 'warn', message: `list price moves ${pct}%` });
    } else {
      unchanged++;
    }
    if (r.supersedes) supersessions.push({ from: r.supersedes, to: r.partNumber });
    if (r.supersededBy) supersessions.push({ from: r.partNumber, to: r.supersededBy });
  }
  const count = (s: PriceFileIssue['severity']) => issues.filter((i) => i.severity === s).length;
  const result: PriceFileResult = {
    batchId: null, dryRun, rows: parsed.rowCount, loaded: parsed.rows.length, created, priceChanges, unchanged, supersessions,
    issues: { error: count('error'), warn: count('warn'), info: count('info') }, issueDetail: issues,
  };

  return ctx.transaction(async (tx) => {
    const [batch] = await tx.db
      .insert(ingestBatches)
      .values({
        tenantId: ctx.tenantId, kind: 'price_file', source: supplier.code, sourceName: input.sourceName, checksum,
        mapping: mapping as unknown as Record<string, unknown>, rowCount: parsed.rowCount, status: dryRun ? 'dry_run' : 'running',
        summary: { created: created.length, priceChanges: priceChanges.length, unchanged, supersessions: supersessions.length, issues: result.issues },
        actor: ctx.actorLabel, finishedAt: dryRun ? new Date() : null,
      })
      .returning();
    result.batchId = batch!.id;
    if (issues.length) {
      await tx.db.insert(ingestIssues).values(issues.map((i) => ({ tenantId: ctx.tenantId, batchId: batch!.id, rowNo: i.rowNo, severity: i.severity, message: i.message, raw: i.raw ?? null })));
    }
    if (dryRun) return result;

    const now = new Date();
    for (let i = 0; i < parsed.rows.length; i += 500) {
      for (const r of parsed.rows.slice(i, i + 500)) {
        const old = byNorm.get(r.norm);
        const values = {
          description: r.description ?? old?.description ?? '(no description)',
          listPricePence: r.listPence ?? old?.listPricePence ?? 0,
          costPricePence: r.netPence ?? old?.costPricePence ?? 0,
          packQty: r.packQty ?? old?.packQty ?? 1,
          discountCode: r.discountCode ?? old?.discountCode ?? null,
          barcode: r.barcode ?? old?.barcode ?? null,
          uom: r.uom ?? old?.uom ?? 'EA',
          priceBatchId: batch!.id,
          updatedAt: now,
        };
        if (old) {
          await tx.db.update(parts).set(values).where(eq(parts.id, old.id));
        } else {
          await tx.db.insert(parts).values({ ...values, tenantId: ctx.tenantId, make, partNumber: r.partNumber, partNumberNorm: r.norm, supplierId: supplier.id });
        }
      }
    }
    for (const s of supersessions) {
      const from = normalisePartNumber(s.from);
      const to = normalisePartNumber(s.to);
      if (from === to) continue;
      await tx.db
        .insert(partSupersessions)
        .values({ tenantId: ctx.tenantId, make, fromPartNumberNorm: from, toPartNumberNorm: to, source: `price_file:${supplier.code}`, batchId: batch!.id })
        .onConflictDoUpdate({
          target: [partSupersessions.tenantId, partSupersessions.make, partSupersessions.fromPartNumberNorm],
          set: { toPartNumberNorm: to, batchId: batch!.id, source: `price_file:${supplier.code}` },
        });
    }
    await tx.db.update(ingestBatches).set({ status: 'loaded', finishedAt: new Date() }).where(eq(ingestBatches.id, batch!.id));
    await audit(tx, 'price_file.loaded', 'ingest_batch', batch!.id, { supplier: supplier.code, rows: parsed.rowCount });
    await emitEvent(tx, 'price_file.loaded', 'ingest_batch', batch!.id, {
      supplier: supplier.code, make, sourceName: input.sourceName, created: created.length, priceChanges: priceChanges.length, issues: result.issues,
    });
    return result;
  });
}
