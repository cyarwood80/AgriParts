import { and, eq, ilike, inArray, or, sql } from 'drizzle-orm';
import { depots, partCrossrefs, partSupersessions, parts, stockLevels } from '../db/schema.js';
import { AppError, notFound } from '../lib/errors.js';
import { looksLikePartNumber, normalisePartNumber } from '../lib/part-number.js';
import type { ServiceContext } from './context.js';

export type Part = typeof parts.$inferSelect;

export interface PartRef {
  partNumber: string;
  make?: string | undefined;
}

/**
 * Counter search: any brand's number format, a barcode, or words. Uses pg_trgm
 * so typos still hit ("flail hamer"). Exact number hits always rank first.
 */
export async function searchParts(
  ctx: ServiceContext,
  opts: { query: string; make?: string | undefined; limit?: number | undefined },
) {
  ctx.require('parts:read');
  const q = opts.query.trim();
  if (q.length < 2) return [];
  const norm = normalisePartNumber(q);
  const byNumber = looksLikePartNumber(q);
  const limit = Math.min(opts.limit ?? 20, 100);
  const conds = [eq(parts.tenantId, ctx.tenantId), eq(parts.isActive, true)];
  if (opts.make) conds.push(eq(parts.make, opts.make.toUpperCase()));
  const pnSim = sql`similarity(${parts.partNumberNorm}, ${norm})`;
  const descSim = sql`word_similarity(${q}, ${parts.description})`;
  const rows = await ctx.db
    .select({
      id: parts.id,
      make: parts.make,
      partNumber: parts.partNumber,
      description: parts.description,
      listPricePence: parts.listPricePence,
      uom: parts.uom,
      score: sql<number>`greatest(${pnSim}, ${descSim})`.mapWith(Number),
    })
    .from(parts)
    .where(
      and(
        ...conds,
        or(
          sql`${parts.partNumberNorm} LIKE ${escapeLike(norm) + '%'}`,
          sql`${parts.partNumberNorm} % ${norm}`,
          eq(parts.barcode, q),
          ilike(parts.description, `%${escapeLike(q)}%`),
          sql`${q} <% ${parts.description}`,
        ),
      ),
    )
    .orderBy(sql`(${parts.partNumberNorm} = ${norm}) DESC`, byNumber ? sql`${pnSim} DESC` : sql`${descSim} DESC`, parts.partNumberNorm)
    .limit(limit);
  return rows;
}

function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => `\\${m}`);
}

/**
 * Find a part by number. If `make` is omitted and the number exists under
 * several makes, throw AMBIGUOUS listing them; callers (and LLMs) can retry.
 */
export async function findPart(ctx: ServiceContext, ref: PartRef): Promise<Part> {
  ctx.require('parts:read');
  const norm = normalisePartNumber(ref.partNumber);
  const conds = [eq(parts.tenantId, ctx.tenantId), eq(parts.partNumberNorm, norm)];
  if (ref.make) conds.push(eq(parts.make, ref.make.toUpperCase()));
  const rows = await ctx.db.select().from(parts).where(and(...conds));
  if (rows.length === 0) throw notFound('Part', ref.make ? `${ref.make}/${ref.partNumber}` : ref.partNumber);
  if (rows.length > 1) {
    throw new AppError('AMBIGUOUS', `Part number ${ref.partNumber} exists under several makes; specify make`, {
      makes: rows.map((r) => r.make),
    });
  }
  return rows[0]!;
}

export async function getPartById(ctx: ServiceContext, id: string): Promise<Part> {
  const [p] = await ctx.db.select().from(parts).where(and(eq(parts.tenantId, ctx.tenantId), eq(parts.id, id)));
  if (!p) throw notFound('Part', id);
  return p;
}

export interface SupersessionStep {
  partNumberNorm: string;
  qtyRatio: number;
  /** Is the hop *into* this step a straight swap? Always true for the start. */
  interchangeable: boolean;
  note?: string | null;
}

/**
 * Follow the supersession chain from a part number to the current one.
 * Returns the chain including the start. Guards against cycles and absurd
 * depth (bad OEM data happens).
 */
export async function supersessionChain(ctx: ServiceContext, make: string, partNumber: string): Promise<SupersessionStep[]> {
  const rows = await ctx.db
    .select()
    .from(partSupersessions)
    .where(and(eq(partSupersessions.tenantId, ctx.tenantId), eq(partSupersessions.make, make)));
  const next = new Map(rows.map((r) => [r.fromPartNumberNorm, r]));
  const chain: SupersessionStep[] = [{ partNumberNorm: normalisePartNumber(partNumber), qtyRatio: 1, interchangeable: true }];
  const seen = new Set(chain.map((c) => c.partNumberNorm));
  let cursor = chain[0]!.partNumberNorm;
  for (let depth = 0; depth < 50; depth++) {
    const link = next.get(cursor);
    if (!link) return chain;
    if (seen.has(link.toPartNumberNorm)) {
      throw new AppError('CONFLICT', `Supersession cycle detected for ${make}/${partNumber}`, {
        chain: [...chain.map((c) => c.partNumberNorm), link.toPartNumberNorm],
      });
    }
    chain.push({ partNumberNorm: link.toPartNumberNorm, qtyRatio: link.qtyRatio, interchangeable: link.interchangeable, note: link.note });
    seen.add(link.toPartNumberNorm);
    cursor = link.toPartNumberNorm;
  }
  throw new AppError('CONFLICT', `Supersession chain too deep for ${make}/${partNumber}`);
}

export interface ResolvedPart {
  requested: string;
  part: Part;
  superseded: boolean;
  chain: string[];
  /** Multiply requested qty by this to get qty of the resolved part. */
  qtyMultiplier: number;
  /** False if any hop between requested and supplied changes fitting. */
  straightSwap: boolean;
  warning: string | null;
}

/**
 * Resolve what we'll actually supply for a requested part number: follow
 * supersessions to the latest number that exists, is active, in our master.
 */
export async function resolvePart(ctx: ServiceContext, ref: PartRef): Promise<ResolvedPart> {
  let start: Part | undefined;
  let make = ref.make?.toUpperCase();
  try {
    start = await findPart(ctx, ref);
    make = start.make;
  } catch (e) {
    // The old number may not be in our master at all (only in the supersession
    // table). That's fine if we know the make.
    if (!(e instanceof AppError && e.code === 'NOT_FOUND' && make)) throw e;
  }
  const chain = await supersessionChain(ctx, make!, ref.partNumber);
  const norms = chain.map((c) => c.partNumberNorm);
  const candidates = await ctx.db
    .select()
    .from(parts)
    .where(and(eq(parts.tenantId, ctx.tenantId), eq(parts.make, make!), inArray(parts.partNumberNorm, norms)));
  const byNorm = new Map(candidates.map((p) => [p.partNumberNorm, p]));
  // Latest active link in the chain that we hold in the master wins.
  let multiplier = 1;
  let swap = true;
  let chosen: { part: Part; idx: number; mult: number; swap: boolean } | undefined;
  chain.forEach((step, idx) => {
    multiplier *= step.qtyRatio;
    swap = swap && step.interchangeable;
    const p = byNorm.get(step.partNumberNorm);
    if (p && p.isActive) chosen = { part: p, idx, mult: multiplier, swap };
  });
  if (!chosen) {
    throw notFound('Active part (after supersession)', `${make}/${ref.partNumber} -> ${norms.at(-1)}`);
  }
  return {
    requested: ref.partNumber,
    part: chosen.part,
    superseded: chosen.idx > 0,
    chain: norms,
    qtyMultiplier: chosen.mult,
    straightSwap: chosen.swap,
    warning: chosen.swap
      ? null
      : 'Supersession changes fitting. Check the fitting instructions before supplying.',
  };
}

/** Cross-brand equivalents for a part. Unverified (machine-suggested) ones are labelled as such. */
export async function equivalents(ctx: ServiceContext, partId: string) {
  const rows = await ctx.db
    .select({
      partId: partCrossrefs.partId,
      refPartId: partCrossrefs.refPartId,
      kind: partCrossrefs.kind,
      confidence: partCrossrefs.confidence,
      verifiedBy: partCrossrefs.verifiedBy,
    })
    .from(partCrossrefs)
    .where(and(eq(partCrossrefs.tenantId, ctx.tenantId), or(eq(partCrossrefs.partId, partId), eq(partCrossrefs.refPartId, partId))));
  if (rows.length === 0) return [];
  const otherIds = rows.map((r) => (r.partId === partId ? r.refPartId : r.partId));
  const others = await ctx.db.select().from(parts).where(and(eq(parts.tenantId, ctx.tenantId), inArray(parts.id, otherIds)));
  const byId = new Map(others.map((p) => [p.id, p]));
  return rows.map((r) => {
    const other = byId.get(r.partId === partId ? r.refPartId : r.partId)!;
    return {
      partId: other.id,
      make: other.make,
      partNumber: other.partNumber,
      description: other.description,
      kind: r.kind,
      confidence: r.confidence,
      verified: r.verifiedBy !== null,
      label: r.verifiedBy ? undefined : 'UNVERIFIED: machine-suggested equivalent, confirm before supplying',
    };
  });
}

export async function stockByDepot(ctx: ServiceContext, partId: string) {
  ctx.require('stock:read');
  const rows = await ctx.db
    .select({
      depotId: depots.id,
      depotCode: depots.code,
      depotName: depots.name,
      onHand: sql<number>`coalesce(${stockLevels.onHand}, 0)`.mapWith(Number),
      allocated: sql<number>`coalesce(${stockLevels.allocated}, 0)`.mapWith(Number),
      onOrder: sql<number>`coalesce(${stockLevels.onOrder}, 0)`.mapWith(Number),
      bin: stockLevels.bin,
    })
    .from(depots)
    .leftJoin(stockLevels, and(eq(stockLevels.depotId, depots.id), eq(stockLevels.partId, partId)))
    .where(and(eq(depots.tenantId, ctx.tenantId), eq(depots.isActive, true)))
    .orderBy(depots.code);
  return rows.map((r) => ({ ...r, available: r.onHand - r.allocated }));
}

/** The full picture for one part: master data, current supersession, stock everywhere. */
export async function partDetail(ctx: ServiceContext, ref: PartRef) {
  const resolved = await resolvePart(ctx, ref);
  const stock = ctx.can('stock:read') ? await stockByDepot(ctx, resolved.part.id) : undefined;
  return {
    part: resolved.part,
    requested: resolved.requested,
    superseded: resolved.superseded,
    supersessionChain: resolved.chain,
    qtyMultiplier: resolved.qtyMultiplier,
    straightSwap: resolved.straightSwap,
    warning: resolved.warning,
    equivalents: await equivalents(ctx, resolved.part.id),
    stock,
    totalAvailable: stock?.reduce((s, r) => s + r.available, 0),
  };
}
