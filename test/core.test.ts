import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cancelOrder, confirmOrder, createQuote, getOrder, invoiceOrder } from '../src/services/orders.js';
import { partDetail, resolvePart, searchParts, stockByDepot, findPart } from '../src/services/parts.js';
import { adjustStock, reconcileLedger, transferStock } from '../src/services/stock.js';
import { createPurchaseOrder, receivePurchaseOrder, sendPurchaseOrder } from '../src/services/purchasing.js';
import { deadStock, rebalanceSuggestions, reorderSuggestions } from '../src/services/insights.js';
import { defaultOrderingRegistry } from '../src/integrations/ordering/adapters.js';
import { AppError } from '../src/lib/errors.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env.database.close());

const free = async (pn: string, depot: string) => {
  const ctx = env.ctx();
  const part = await findPart(ctx, { partNumber: pn });
  return (await stockByDepot(ctx, part.id)).find((d) => d.depotCode === depot)!;
};

describe('parts', () => {
  it('finds parts from sloppy numbers and from words, with typos', async () => {
    const ctx = env.ctx();
    expect((await searchParts(ctx, { query: 'dh10442' }))[0]!.partNumber).toBe('DH-10442');
    expect((await searchParts(ctx, { query: 'flail hammer' })).length).toBeGreaterThanOrEqual(2);
    expect((await searchParts(ctx, { query: 'flail hamer' }))[0]!.description).toMatch(/Flail hammer/);
  });

  it('follows a supersession chain to the current part', async () => {
    const r = await resolvePart(env.ctx(), { partNumber: 'acm 10021', make: 'ACM' });
    expect(r.part.partNumber).toBe('ACM-10044');
    expect(r.chain).toEqual(['ACM10021', 'ACM10021A', 'ACM10044']);
    expect(r.straightSwap).toBe(true);
  });

  it('flags supersessions that change fitting', async () => {
    const r = await resolvePart(env.ctx(), { partNumber: 'NFB-2210', make: 'NFB' });
    expect(r.part.partNumber).toBe('NFB-2215');
    expect(r.straightSwap).toBe(false);
    expect(r.warning).toMatch(/fitting/);
  });

  it('labels unverified equivalents', async () => {
    const d = await partDetail(env.ctx(), { partNumber: 'ACM-10044' });
    expect(d.equivalents).toContainEqual(expect.objectContaining({ partNumber: 'GEN-OF-118', verified: true }));
    const g = await partDetail(env.ctx(), { partNumber: 'ACM-41870' });
    expect(g.equivalents[0]!.label).toMatch(/UNVERIFIED/);
  });
});

describe('order lifecycle', () => {
  it('quote -> confirm -> invoice keeps the ledger exact', async () => {
    const ctx = env.ctx();
    const before = await free('GEN-GR-400', 'HQ');
    const q = await createQuote(ctx, { customerAccount: 'HILL01', depotCode: 'HQ', lines: [{ partNumber: 'GEN-GR-400', qty: 2 }, { partNumber: 'ACM-10021', make: 'ACM', qty: 1 }] });
    expect(q.status).toBe('quote');
    // Contract band, discount code C = 20% off 495p
    expect(q.lines[0]!.unitNetPence).toBe(396);
    expect(q.lines[1]!.partNumber).toBe('ACM-10044');
    expect(q.lines[1]!.requestedPartNumber).toBe('ACM-10021');
    expect(q.totals.vatPence).toBe(Math.round(396 * 2 * 0.2) + Math.round(q.lines[1]!.lineNetPence * 0.2));
    expect((await free('GEN-GR-400', 'HQ')).available).toBe(before.available); // quotes don't touch stock

    const c = await confirmOrder(ctx, q.number);
    expect(c.status).toBe('confirmed');
    expect((await free('GEN-GR-400', 'HQ')).allocated).toBe(before.allocated + 2);

    const { invoice, order } = await invoiceOrder(ctx, q.number);
    expect(order.status).toBe('invoiced');
    expect(invoice.grossPence).toBe(q.totals.grossPence);
    const after = await free('GEN-GR-400', 'HQ');
    expect(after.onHand).toBe(before.onHand - 2);
    expect(after.allocated).toBe(before.allocated);
    expect(await reconcileLedger(ctx)).toEqual([]);
  });

  it('special (contract) price beats the matrix', async () => {
    const q = await createQuote(env.ctx(), { customerAccount: 'HILL01', depotCode: 'HQ', lines: [{ partNumber: 'GEN-NET-3600', qty: 1 }] });
    expect(q.lines[0]!.unitNetPence).toBe(14250);
    expect((q.lines[0]!.pricing as { basis: string }).basis).toBe('special_price');
  });

  it('refuses to confirm for an account on stop', async () => {
    const q = await createQuote(env.ctx(), { customerAccount: 'LOW01', depotCode: 'HQ', lines: [{ partNumber: 'GEN-GR-400', qty: 1 }] });
    await expect(confirmOrder(env.ctx(), q.number)).rejects.toMatchObject({ code: 'CUSTOMER_ON_STOP' });
  });

  it('backorders shortfall, cancel releases allocation', async () => {
    const ctx = env.ctx();
    const s = await free('ACM-71002', 'HQ');
    const q = await createQuote(ctx, { customerAccount: 'MEAD01', depotCode: 'HQ', lines: [{ partNumber: 'ACM-71002', qty: s.available + 1 }] });
    const c = await confirmOrder(ctx, q.number);
    expect(c.lines[0]!.qtyAllocated).toBe(s.available);
    expect(c.lines[0]!.qtyBackordered).toBe(1);
    await cancelOrder(ctx, q.number, 'customer changed mind');
    expect((await free('ACM-71002', 'HQ')).allocated).toBe(s.allocated);
    expect((await getOrder(ctx, q.number)).status).toBe('cancelled');
  });

  it('concurrent confirmations never oversell the last units', async () => {
    const ctx = env.ctx();
    const s = await free('ACM-30553', 'NTH');
    const n = Math.max(1, s.available);
    if (s.available < 1) await adjustStock(ctx, { partNumber: 'ACM-30553', depotCode: 'NTH', delta: 1, reason: 'test setup' });
    const quotes = await Promise.all(
      Array.from({ length: n + 3 }, () => createQuote(ctx, { customerAccount: 'BRK01', depotCode: 'NTH', lines: [{ partNumber: 'ACM-30553', qty: 1 }] })),
    );
    const confirmed = await Promise.all(quotes.map((q) => confirmOrder(ctx, q.number)));
    const allocated = confirmed.reduce((t, o) => t + o.lines[0]!.qtyAllocated, 0);
    const backordered = confirmed.reduce((t, o) => t + o.lines[0]!.qtyBackordered, 0);
    expect(allocated).toBe(n);
    expect(backordered).toBe(3);
    const after = await free('ACM-30553', 'NTH');
    expect(after.available).toBe(0);
    for (const q of quotes) await cancelOrder(ctx, q.number, 'test cleanup');
  });

  it('enforces scopes', async () => {
    const ro = env.ctx(['parts:read', 'orders:read']);
    await expect(createQuote(ro, { customerAccount: 'HILL01', depotCode: 'HQ', lines: [{ partNumber: 'GEN-GR-400', qty: 1 }] })).rejects.toBeInstanceOf(AppError);
  });
});

describe('stock & purchasing', () => {
  it('transfers between depots and blocks overdraw', async () => {
    const ctx = env.ctx();
    const nth = await free('GEN-GR-400', 'NTH');
    await transferStock(ctx, { partNumber: 'GEN-GR-400', fromDepotCode: 'NTH', toDepotCode: 'STH', qty: 1 });
    expect((await free('GEN-GR-400', 'NTH')).onHand).toBe(nth.onHand - 1);
    await expect(transferStock(ctx, { partNumber: 'GEN-GR-400', fromDepotCode: 'NTH', toDepotCode: 'STH', qty: 99999 })).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
  });

  it('stock count adjustment sets on hand to the counted figure', async () => {
    const r = await adjustStock(env.ctx(), { partNumber: 'DH-10471', depotCode: 'HQ', countedQty: 7, reason: 'perpetual inventory count' });
    expect(r.level.onHand).toBe(7);
  });

  it('PO -> send via adapter -> receive allocates waiting backorders', async () => {
    const ctx = env.ctx();
    const registry = defaultOrderingRegistry();
    // Seed left BRK01 with 2 x ACM-41870 backordered at HQ.
    const po = await createPurchaseOrder(ctx, { supplierCode: 'ACMUK', depotCode: 'HQ', lines: [{ partNumber: 'ACM-41870', qty: 5 }] });
    const sent = await sendPurchaseOrder(ctx, po.number, registry);
    expect(sent.purchaseOrder.status).toBe('sent');
    expect(sent.purchaseOrder.externalRef).toMatch(/^OEM-/);
    expect((await free('ACM-41870', 'HQ')).onOrder).toBe(5);
    await expect(sendPurchaseOrder(ctx, po.number, registry)).rejects.toMatchObject({ code: 'INVALID_STATE' });

    const rec = await receivePurchaseOrder(ctx, po.number, { all: true });
    expect(rec.purchaseOrder.status).toBe('received');
    expect(rec.backorderAllocations[0]!.orders[0]!.qty).toBe(2);
    const s = await free('ACM-41870', 'HQ');
    expect(s.onOrder).toBe(0);
    expect(await reconcileLedger(ctx)).toEqual([]);
  });

  it('csv-export adapter returns an order document', async () => {
    const ctx = env.ctx();
    const po = await createPurchaseOrder(ctx, { supplierCode: 'NFBUK', depotCode: 'NTH', orderType: 'vor', lines: [{ partNumber: 'NFB-5120', qty: 2 }] });
    const sent = await sendPurchaseOrder(ctx, po.number, defaultOrderingRegistry());
    expect(sent.document!.body).toContain('VOR');
    expect(sent.document!.body).toContain('NFB-5120');
  });
});

describe('insights', () => {
  it('produces explainable reorder suggestions rounded to pack size', async () => {
    const s = await reorderSuggestions(env.ctx());
    expect(s.length).toBeGreaterThan(0);
    for (const r of s) {
      expect(r.reason).toMatch(/reorder point/);
      expect(r.suggestedQty).toBeGreaterThan(0);
    }
    const tines = s.find((r) => r.partNumber === 'NFB-3400');
    if (tines) expect(tines.suggestedQty % 10).toBe(0);
  });
  it('finds dead stock and values it', async () => {
    const d = await deadStock(env.ctx(), { days: 365 });
    expect(d.items.length).toBeGreaterThan(0);
    expect(d.totalValuePence).toBeGreaterThan(0);
  });
  it('rebalance suggestions never move stock to the same depot', async () => {
    for (const r of await rebalanceSuggestions(env.ctx())) expect(r.fromDepot).not.toBe(r.toDepot);
  });
});
