/**
 * Demo dataset. All makes, part numbers, prices, customers and farms are
 * invented. "Demo Hedgecutters" is carried over from AgriParts v1's demo data.
 */
import { sql } from 'drizzle-orm';
import type { DB } from './client.js';
import {
  customerSpecialPrices, customers, depots, discountMatrix, partCrossrefs, partSupersessions, parts,
  stockLevels, stockMovements, suppliers, tenants,
} from './schema.js';
import { normalisePartNumber } from '../lib/part-number.js';
import { createApiKey } from '../services/auth.js';
import { READ_ONLY_SCOPES, SCOPES, ServiceContext } from '../services/context.js';
import { confirmOrder, createQuote } from '../services/orders.js';
import { seedEnquiriesDemo } from './seed-enquiries.js';
import { seedGuidanceDemo } from './seed-guidance.js';

function mulberry32(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type PartSeed = [make: string, pn: string, desc: string, listPence: number, costPence: number, disc: string, supplier: string, demandPerDay: number, pack?: number];

const PARTS: PartSeed[] = [
  ['ACM', 'ACM-10044', 'Engine oil filter, AT-series', 2895, 1620, 'A', 'ACMUK', 0.35],
  ['ACM', 'ACM-10021A', 'Engine oil filter (superseded)', 2750, 1540, 'A', 'ACMUK', 0],
  ['ACM', 'ACM-20310', 'Fuel filter element, primary', 4120, 2310, 'A', 'ACMUK', 0.22],
  ['ACM', 'ACM-20311', 'Fuel filter element, secondary', 3680, 2060, 'A', 'ACMUK', 0.2],
  ['ACM', 'ACM-30552', 'Air filter element, outer', 8950, 5010, 'A', 'ACMUK', 0.12],
  ['ACM', 'ACM-30553', 'Air filter element, inner safety', 5240, 2930, 'A', 'ACMUK', 0.08],
  ['ACM', 'ACM-41870', 'Hydraulic return filter', 7615, 4260, 'A', 'ACMUK', 0.1],
  ['ACM', 'ACM-55120', 'Front wiper blade 600mm', 1890, 940, 'B', 'ACMUK', 0.05],
  ['ACM', 'ACM-60718', 'Top link assembly cat 2', 18450, 11070, 'B', 'ACMUK', 0.02],
  ['ACM', 'ACM-71002', 'Driver seat suspension unit', 64900, 41540, 'N', 'ACMUK', 0],
  ['NFB', 'NFB-2215', 'Knotter bill hook assembly', 14800, 8880, 'B', 'NFBUK', 0.06],
  ['NFB', 'NFB-2216', 'Knotter bill mounting bracket', 3600, 2160, 'B', 'NFBUK', 0.03],
  ['NFB', 'NFB-3400', 'Pick-up tine, 6mm', 420, 210, 'B', 'NFBUK', 1.6, 10],
  ['NFB', 'NFB-3410', 'Shear bolt M10 x 60 (pack 10)', 1250, 520, 'B', 'NFBUK', 0.4],
  ['NFB', 'NFB-5120', 'Twine knife', 2650, 1590, 'B', 'NFBUK', 0.1],
  ['DH', 'DH-10442', 'Flail hammer, 80mm, heavy duty', 1540, 924, 'B', 'DHC', 1.2, 4],
  ['DH', 'DH-10460', 'Flail hammer 100mm', 1795, 1077, 'B', 'DHC', 0.6, 4],
  ['DH', 'DH-10471', 'Rotor bearing 2-bolt flange', 6400, 3840, 'B', 'DHC', 0.05],
  ['GEN', 'GEN-OF-118', 'Pattern oil filter (fits ACM AT-series)', 1695, 710, 'C', 'AMX', 0.25],
  ['GEN', 'GEN-GR-400', 'EP2 grease cartridge 400g', 495, 230, 'C', 'AMX', 2.2, 12],
  ['GEN', 'GEN-UTTO-20', 'UTTO transmission oil 20L', 8995, 5400, 'C', 'AMX', 0.3],
  ['GEN', 'GEN-15W40-20', 'Engine oil 15W-40 20L', 7495, 4500, 'C', 'AMX', 0.35],
  ['GEN', 'GEN-NET-3600', 'Bale net wrap 1.23m x 3600m', 15900, 12720, 'N', 'AMX', 0.5],
  ['GEN', 'GEN-TW-130', 'Baler twine 130m/kg (2 spools)', 3895, 2930, 'N', 'AMX', 0.4],
  ['GEN', 'GEN-LED-WL', 'LED work light 4000lm', 6950, 3200, 'C', 'AMX', 0.03],
  ['GEN', 'GEN-PTO-6', 'PTO shaft guard cone 6-spline', 2450, 1180, 'C', 'AMX', 0],
];

export async function seedDemo(db: DB, opts: { log?: (s: string) => void } = {}) {
  const log = opts.log ?? (() => {});
  const rand = mulberry32(20261115);
  const [tenant] = await db.insert(tenants).values({ name: 'Demo Agri Machinery Ltd', settings: { defaultPaymentTermsDays: 30 } }).returning();
  const tenantId = tenant!.id;

  const depotRows = await db.insert(depots).values([
    { tenantId, code: 'HQ', name: 'Head Office Depot' },
    { tenantId, code: 'NTH', name: 'North Depot' },
    { tenantId, code: 'STH', name: 'South Depot' },
  ]).returning();
  const depotWeights: Record<string, number> = { HQ: 1, NTH: 0.6, STH: 0.35 };

  const supplierRows = await db.insert(suppliers).values([
    { tenantId, code: 'ACMUK', name: 'Acme Tractors UK (demo OEM)', orderingAdapter: 'mock-oem', leadTimeDays: 2, accountRef: 'D-48213' },
    { tenantId, code: 'NFBUK', name: 'Northfield Balers (demo)', orderingAdapter: 'csv-export', leadTimeDays: 10, accountRef: 'NF-0771' },
    { tenantId, code: 'DHC', name: 'Demo Hedgecutters Ltd', orderingAdapter: 'manual', leadTimeDays: 5 },
    { tenantId, code: 'AMX', name: 'Allmakes Express (demo)', orderingAdapter: 'mock-oem', leadTimeDays: 1, accountRef: 'AMX-99812' },
  ]).returning();
  const supplierId = Object.fromEntries(supplierRows.map((s) => [s.code, s.id]));

  const partRows = await db.insert(parts).values(
    PARTS.map(([make, pn, desc, list, cost, disc, sup, , pack]) => ({
      tenantId, make, partNumber: pn, partNumberNorm: normalisePartNumber(pn), description: desc,
      listPricePence: list, costPricePence: cost, discountCode: disc, supplierId: supplierId[sup],
      packQty: pack ?? 1, isActive: pn !== 'ACM-10021A',
      vatCode: 'S',
    })),
  ).returning();
  const partByPn = new Map(partRows.map((p) => [p.partNumber, p]));

  await db.insert(partSupersessions).values([
    { tenantId, make: 'ACM', fromPartNumberNorm: 'ACM10021', toPartNumberNorm: 'ACM10021A', source: 'demo' },
    { tenantId, make: 'ACM', fromPartNumberNorm: 'ACM10021A', toPartNumberNorm: 'ACM10044', source: 'demo', note: 'Improved filter media' },
    {
      tenantId, make: 'NFB', fromPartNumberNorm: 'NFB2210', toPartNumberNorm: 'NFB2215', source: 'demo', interchangeable: false,
      note: 'New bill hook needs revised mounting bracket NFB-2216',
    },
  ]);
  await db.insert(partCrossrefs).values([
    { tenantId, partId: partByPn.get('GEN-OF-118')!.id, refPartId: partByPn.get('ACM-10044')!.id, kind: 'pattern_for', confidence: 95, verifiedBy: 'parts.manager@demo' },
    { tenantId, partId: partByPn.get('GEN-GR-400')!.id, refPartId: partByPn.get('ACM-41870')!.id, kind: 'pattern_for', confidence: 40 },
  ]);

  await db.insert(discountMatrix).values([
    ...(['A', 'B', 'C'] as const).flatMap((code) => [
      { tenantId, priceBand: 'TRADE', discountCode: code, discountBps: { A: 1500, B: 1000, C: 1250 }[code] },
      { tenantId, priceBand: 'CONTRACT', discountCode: code, discountBps: { A: 2500, B: 1750, C: 2000 }[code] },
    ]),
  ]);

  const custRows = await db.insert(customers).values([
    { tenantId, accountCode: 'HILL01', name: 'Hilltop Farm Partnership', priceBand: 'CONTRACT', phone: '01632 960001', email: 'office@hilltop.example', postcode: 'HR1 1AA', accountingRef: 'HILL01' },
    { tenantId, accountCode: 'BRK01', name: 'Brook Lane Contracting Ltd', priceBand: 'TRADE', phone: '01632 960002', email: 'accounts@brooklane.example', postcode: 'HR2 2BB' },
    { tenantId, accountCode: 'OAK01', name: 'Oakfield Estates', priceBand: 'CONTRACT', phone: '01632 960003', postcode: 'SY8 3CC' },
    { tenantId, accountCode: 'MEAD01', name: 'Meadowbank Dairy', priceBand: 'RETAIL', phone: '01632 960004', postcode: 'HR6 4DD' },
    { tenantId, accountCode: 'CASH', name: 'Cash Sales', priceBand: 'RETAIL' },
    { tenantId, accountCode: 'LOW01', name: 'Lowfield Agri', priceBand: 'TRADE', onStop: true, phone: '01632 960006' },
  ]).returning();
  const custByCode = new Map(custRows.map((c) => [c.accountCode, c]));
  await db.insert(customerSpecialPrices).values({
    tenantId, customerId: custByCode.get('HILL01')!.id, partId: partByPn.get('GEN-NET-3600')!.id, pricePence: 14250,
  });

  // History: opening balances, then ~120 days of counter sales and a few receipts.
  const now = Date.now();
  const day = 86_400_000;
  const levels: (typeof stockLevels.$inferInsert)[] = [];
  const moves: (typeof stockMovements.$inferInsert)[] = [];
  for (const [, pn, , , cost, , , demand] of PARTS) {
    const part = partByPn.get(pn)!;
    for (const d of depotRows) {
      const rate = demand * depotWeights[d.code]!;
      // Some parts sit dead at outlying depots; the seat lives only at HQ.
      const dead = rate === 0 || (d.code === 'STH' && rand() < 0.15);
      let onHand = dead ? (rand() < 0.5 && part.isActive ? Math.ceil(rand() * 4) : 0) : Math.round(rate * 120 * (0.55 + rand() * 0.9));
      if (pn === 'ACM-71002' && d.code === 'HQ') onHand = 1;
      if (onHand === 0 && dead) continue;
      moves.push({ tenantId, partId: part.id, depotId: d.id, type: 'opening', qty: onHand, unitCostPence: cost, actor: 'system:seed', note: 'Opening balance (demo)', createdAt: new Date(now - (dead ? 500 : 130) * day) });
      if (!dead) {
        for (let t = 120; t >= 1; t--) {
          if (rand() > Math.min(0.95, rate)) continue;
          const q = Math.max(1, Math.round(rate > 1 ? rate * (0.5 + rand()) : 1));
          if (q > onHand) {
            // Stock ran out: a receipt arrives, as it would in real life.
            const r = Math.max(part.packQty, Math.ceil(rate * 30));
            onHand += r;
            moves.push({ tenantId, partId: part.id, depotId: d.id, type: 'receipt', qty: r, unitCostPence: cost, actor: 'system:seed', referenceType: 'purchase_order', referenceId: 'PO-HIST', createdAt: new Date(now - t * day - 3_600_000) });
          }
          onHand -= q;
          moves.push({ tenantId, partId: part.id, depotId: d.id, type: 'sale', qty: -q, unitCostPence: cost, actor: 'system:seed', referenceType: 'sales_order', referenceId: 'SO-HIST', createdAt: new Date(now - t * day) });
        }
      }
      levels.push({ tenantId, partId: part.id, depotId: d.id, onHand, bin: `${d.code}-${String.fromCharCode(65 + Math.floor(rand() * 8))}${Math.ceil(rand() * 20)}` });
    }
  }
  await db.insert(stockLevels).values(levels);
  for (let i = 0; i < moves.length; i += 500) await db.insert(stockMovements).values(moves.slice(i, i + 500));

  // Min/max on a couple of lines so both reorder methods show up.
  await db.execute(sql`UPDATE stock_levels SET min_qty = 2, max_qty = 6 WHERE part_id = ${partByPn.get('ACM-30552')!.id} AND depot_id = ${depotRows[0]!.id}`);

  // An order that backorders, so "what's waiting for stock" has an answer.
  const ctx = ServiceContext.system(db, tenantId);
  const hq = await db.select().from(stockLevels).where(sql`part_id = ${partByPn.get('ACM-41870')!.id} AND depot_id = ${depotRows[0]!.id}`);
  const q = await createQuote(ctx, {
    customerAccount: 'BRK01', depotCode: 'HQ', customerRef: 'BL-PO-5521',
    lines: [{ partNumber: 'ACM-41870', qty: (hq[0]?.onHand ?? 0) + 2 }, { partNumber: 'GEN-GR-400', qty: 12 }],
  });
  await confirmOrder(ctx, q.number);

  await seedGuidanceDemo(db, tenantId);
  await seedEnquiriesDemo(db, tenantId);

  const admin = await createApiKey(db, tenantId, 'Demo admin', [...SCOPES]);
  const counter = await createApiKey(db, tenantId, 'Counter assistant (MCP)', [
    ...READ_ONLY_SCOPES, 'orders:write', 'stock:write', 'purchasing:write', 'enquiries:write',
  ]);
  const readonly = await createApiKey(db, tenantId, 'Read-only analyst', READ_ONLY_SCOPES);
  log(`Seeded tenant ${tenant!.name} (${tenantId}): ${partRows.length} parts, ${moves.length} movements`);
  return { tenantId, keys: { admin: admin.key, counter: counter.key, readonly: readonly.key } };
}
