import { sql } from 'drizzle-orm';
import { rows } from '../db/rows.js';
import type { ServiceContext } from './context.js';
import { getDepotByCode, getSupplierByCode } from './lookups.js';

/**
 * Decision support. Deterministic and explainable on purpose: every number
 * comes with the inputs and the rule that produced it, so an agent (or a
 * parts manager) can explain a suggestion and overrule it. ML forecasting can
 * replace the demand estimate later without changing the contract.
 */

export interface ReorderOptions {
  depotCode?: string | undefined;
  supplierCode?: string | undefined;
  /** Days of sales history used to estimate demand. */
  lookbackDays?: number | undefined;
  /** Days of demand to cover beyond the supplier lead time. */
  coverDays?: number | undefined;
  /** Safety stock as a fraction of lead-time demand. */
  safetyFactor?: number | undefined;
}

interface DemandRow {
  part_id: string;
  depot_id: string;
  depot_code: string;
  make: string;
  part_number: string;
  description: string;
  pack_qty: number;
  cost_price_pence: number;
  supplier_code: string | null;
  lead_time_days: number | null;
  on_hand: number;
  allocated: number;
  on_order: number;
  min_qty: number | null;
  max_qty: number | null;
  sold: number;
  backordered: number;
}

async function demandRows(ctx: ServiceContext, opts: ReorderOptions): Promise<DemandRow[]> {
  const lookback = opts.lookbackDays ?? 90;
  const depotId = opts.depotCode ? (await getDepotByCode(ctx, opts.depotCode)).id : null;
  const supplierId = opts.supplierCode ? (await getSupplierByCode(ctx, opts.supplierCode)).id : null;
  return rows<DemandRow>(ctx.db, sql`
    WITH sales AS (
      SELECT part_id, depot_id, -sum(qty)::int AS sold
        FROM stock_movements
       WHERE tenant_id = ${ctx.tenantId} AND type IN ('sale', 'workshop_issue')
         AND created_at >= now() - make_interval(days => ${lookback})
       GROUP BY part_id, depot_id
    ), backorders AS (
      SELECT l.part_id, o.depot_id, sum(l.qty_backordered)::int AS backordered
        FROM sales_order_lines l JOIN sales_orders o ON o.id = l.order_id
       WHERE l.tenant_id = ${ctx.tenantId} AND l.qty_backordered > 0 AND o.status IN ('confirmed', 'part_invoiced')
       GROUP BY l.part_id, o.depot_id
    )
    SELECT sl.part_id, sl.depot_id, d.code AS depot_code, p.make, p.part_number, p.description, p.pack_qty,
           p.cost_price_pence, s.code AS supplier_code, s.lead_time_days,
           sl.on_hand, sl.allocated, sl.on_order, sl.min_qty, sl.max_qty,
           coalesce(sa.sold, 0) AS sold, coalesce(b.backordered, 0) AS backordered
      FROM stock_levels sl
      JOIN parts p ON p.id = sl.part_id
      JOIN depots d ON d.id = sl.depot_id
 LEFT JOIN suppliers s ON s.id = p.supplier_id
 LEFT JOIN sales sa ON sa.part_id = sl.part_id AND sa.depot_id = sl.depot_id
 LEFT JOIN backorders b ON b.part_id = sl.part_id AND b.depot_id = sl.depot_id
     WHERE sl.tenant_id = ${ctx.tenantId} AND p.is_active
       AND (${depotId}::uuid IS NULL OR sl.depot_id = ${depotId}::uuid)
       AND (${supplierId}::uuid IS NULL OR p.supplier_id = ${supplierId}::uuid)`);
}

export interface ReorderSuggestion {
  depot: string;
  make: string;
  partNumber: string;
  description: string;
  supplier: string | null;
  suggestedQty: number;
  estCostPence: number;
  position: number;
  reorderPoint: number;
  target: number;
  dailyDemand: number;
  reason: string;
}

export async function reorderSuggestions(ctx: ServiceContext, opts: ReorderOptions = {}): Promise<ReorderSuggestion[]> {
  ctx.require('insights:read');
  const lookback = opts.lookbackDays ?? 90;
  const cover = opts.coverDays ?? 14;
  const safety = opts.safetyFactor ?? 0.5;
  const out: ReorderSuggestion[] = [];
  for (const r of await demandRows(ctx, opts)) {
    const lead = r.lead_time_days ?? 7;
    const daily = r.sold / lookback;
    // Stock position: what we'll have once everything on order lands and every commitment is met.
    const position = r.on_hand - r.allocated + r.on_order - r.backordered;
    let reorderPoint: number;
    let target: number;
    let basis: string;
    if (r.max_qty != null) {
      reorderPoint = r.min_qty ?? 0;
      target = r.max_qty;
      basis = `min/max ${reorderPoint}/${target}`;
    } else {
      const leadDemand = daily * lead;
      reorderPoint = Math.ceil(leadDemand + leadDemand * safety);
      target = reorderPoint + Math.ceil(daily * cover);
      basis = `${r.sold} sold in ${lookback}d (${daily.toFixed(2)}/day), lead ${lead}d, cover ${cover}d`;
    }
    const mustCoverBackorders = position < 0;
    if (!(position <= reorderPoint && (target > 0 || mustCoverBackorders))) continue;
    let qty = Math.max(target - position, mustCoverBackorders ? -position : 0);
    if (qty <= 0) continue;
    const pack = Math.max(1, r.pack_qty);
    qty = Math.ceil(qty / pack) * pack;
    out.push({
      depot: r.depot_code,
      make: r.make,
      partNumber: r.part_number,
      description: r.description,
      supplier: r.supplier_code,
      suggestedQty: qty,
      estCostPence: qty * r.cost_price_pence,
      position,
      reorderPoint,
      target,
      dailyDemand: Math.round(daily * 100) / 100,
      reason:
        `Position ${position} (on hand ${r.on_hand}, allocated ${r.allocated}, on order ${r.on_order}, backordered ${r.backordered}) ` +
        `at or below reorder point ${reorderPoint}; order up to ${target} [${basis}]${pack > 1 ? `, rounded to pack of ${pack}` : ''}`,
    });
  }
  return out.sort((a, b) => b.estCostPence - a.estCostPence);
}

export async function deadStock(ctx: ServiceContext, opts: { depotCode?: string | undefined; days?: number | undefined } = {}) {
  ctx.require('insights:read');
  const days = opts.days ?? 365;
  const depotId = opts.depotCode ? (await getDepotByCode(ctx, opts.depotCode)).id : null;
  const result = await rows<{
    depot_code: string; make: string; part_number: string; description: string; on_hand: number;
    value_pence: number; last_out: string | null;
  }>(ctx.db, sql`
    SELECT d.code AS depot_code, p.make, p.part_number, p.description, sl.on_hand,
           (sl.on_hand * p.cost_price_pence)::int AS value_pence,
           (SELECT max(created_at) FROM stock_movements m
             WHERE m.part_id = sl.part_id AND m.depot_id = sl.depot_id AND m.qty < 0
               AND m.type IN ('sale', 'workshop_issue', 'transfer_out'))::text AS last_out
      FROM stock_levels sl
      JOIN parts p ON p.id = sl.part_id
      JOIN depots d ON d.id = sl.depot_id
     WHERE sl.tenant_id = ${ctx.tenantId} AND sl.on_hand > 0
       AND (${depotId}::uuid IS NULL OR sl.depot_id = ${depotId}::uuid)
       AND NOT EXISTS (
         SELECT 1 FROM stock_movements m
          WHERE m.part_id = sl.part_id AND m.depot_id = sl.depot_id AND m.qty < 0
            AND m.type IN ('sale', 'workshop_issue', 'transfer_out')
            AND m.created_at >= now() - make_interval(days => ${days}))
  ORDER BY value_pence DESC`);
  return {
    days,
    lines: result.length,
    totalValuePence: result.reduce((s, r) => s + r.value_pence, 0),
    items: result.map((r) => ({ depot: r.depot_code, make: r.make, partNumber: r.part_number, description: r.description, onHand: r.on_hand, valuePence: r.value_pence, lastMovementOut: r.last_out })),
  };
}

/**
 * Before buying more, check whether another depot is sitting on it.
 * Pairs depots that need stock (reorder suggestions) with depots holding
 * free stock above their own target.
 */
export async function rebalanceSuggestions(ctx: ServiceContext, opts: ReorderOptions = {}) {
  ctx.require('insights:read');
  const needs = await reorderSuggestions(ctx, { ...opts, depotCode: undefined });
  const all = await demandRows(ctx, { ...opts, depotCode: undefined });
  const lookback = opts.lookbackDays ?? 90;
  const cover = opts.coverDays ?? 14;
  const surplus = new Map<string, { depot: string; spare: number }[]>();
  for (const r of all) {
    const daily = r.sold / lookback;
    const lead = r.lead_time_days ?? 7;
    const ownTarget = r.max_qty ?? Math.ceil(daily * (lead * 1.5 + cover));
    const spare = r.on_hand - r.allocated - r.backordered - ownTarget;
    if (spare > 0) {
      const key = `${r.make}|${r.part_number}`;
      surplus.set(key, [...(surplus.get(key) ?? []), { depot: r.depot_code, spare }]);
    }
  }
  const out = [];
  for (const need of needs) {
    const sources = (surplus.get(`${need.make}|${need.partNumber}`) ?? []).filter((s) => s.depot !== need.depot).sort((a, b) => b.spare - a.spare);
    let remaining = need.suggestedQty;
    for (const src of sources) {
      if (remaining <= 0) break;
      const qty = Math.min(src.spare, remaining);
      if (qty <= 0) continue;
      src.spare -= qty;
      remaining -= qty;
      out.push({
        make: need.make,
        partNumber: need.partNumber,
        description: need.description,
        fromDepot: src.depot,
        toDepot: need.depot,
        qty,
        avoidsPurchasePence: Math.round((need.estCostPence / need.suggestedQty) * qty),
        reason: `${need.depot} needs ${need.suggestedQty}; ${src.depot} holds ${qty + src.spare} above its own target`,
      });
    }
  }
  return out;
}
