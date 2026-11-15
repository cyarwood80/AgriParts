import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { importPriceFile } from '../src/integrations/price-files/import.js';
import { importLegacyFile } from '../src/integrations/legacy-import/ibcos-bridge.js';
import { buildXeroInvoice, createLogAccountingAdapter, createXeroAdapter } from '../src/integrations/accounting/xero.js';
import type { InvoiceCreatedPayload } from '../src/integrations/accounting/types.js';
import { MAX_ATTEMPTS, runDispatcherOnce, verifySignature, newWebhookSecret, backoffMs } from '../src/integrations/webhooks/dispatcher.js';
import { integrationConnections, invoices, webhookSubscriptions } from '../src/db/schema.js';
import { confirmOrder, createQuote, invoiceOrder } from '../src/services/orders.js';
import { findPart, resolvePart, stockByDepot } from '../src/services/parts.js';
import { reconcileLedger } from '../src/services/stock.js';
import { parseCsv, toCsv } from '../src/lib/csv.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env.database.close());

const fixture = (p: string) => readFileSync(new URL(`../fixtures/${p}`, import.meta.url), 'utf8');

describe('csv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const rows = parseCsv('﻿a,b\r\n"x, y","he said ""hi"""\r\n"multi\nline",3\n');
    expect(rows).toEqual([['a', 'b'], ['x, y', 'he said "hi"'], ['multi\nline', '3']]);
    expect(parseCsv(toCsv(rows))).toEqual(rows);
  });
});

describe('price files (v1 behaviour preserved)', () => {
  const mapping = JSON.parse(fixture('mappings/demo-hedgecutters.json'));
  const content = fixture('price-files/demo-hedgecutters-2026.csv');

  it('dry run reports a diff and changes nothing', async () => {
    const r = await importPriceFile(env.ctx(), { mapping, content, sourceName: 'demo-hedgecutters-2026.csv', dryRun: true });
    expect(r.dryRun).toBe(true);
    expect(r.rows).toBe(7);
    expect(r.loaded).toBe(4);
    expect(r.created.map((c) => c.partNumber)).toEqual(['DH-10495']);
    await expect(findPart(env.ctx(), { partNumber: 'DH-10495' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('loads: bad rows become issues, supersessions recorded, re-load is a no-op', async () => {
    const r = await importPriceFile(env.ctx(), { mapping, content, sourceName: 'demo-hedgecutters-2026.csv' });
    expect(r.issues).toMatchObject({ error: 2, info: 1 }); // missing pn + 'TBC' price; DISCONTINUED skipped
    expect(r.issues.warn).toBeGreaterThanOrEqual(1); // net > list on the skid
    expect(r.supersessions).toEqual([{ from: 'DH-10402', to: 'DH-10471' }]);
    const skid = await findPart(env.ctx(), { partNumber: 'DH-10495' });
    expect(skid.priceBatchId).toBe(r.batchId); // provenance
    const old = await resolvePart(env.ctx(), { partNumber: 'DH-10402', make: 'DH' });
    expect(old.part.partNumber).toBe('DH-10471');
    const again = await importPriceFile(env.ctx(), { mapping, content, sourceName: 'demo-hedgecutters-2026.csv' });
    expect(again.skipped).toBe(true);
  });

  it('reads fixed-width files with prices in pence and reports price changes', async () => {
    const r = await importPriceFile(env.ctx(), {
      mapping: JSON.parse(fixture('mappings/demo-acme-fixed.json')),
      content: fixture('price-files/demo-acme-fixed.txt'),
      sourceName: 'acme.txt',
    });
    expect(r.priceChanges).toEqual([{ partNumber: 'ACM-10044', oldListPence: 2895, newListPence: 3195, changePct: 10.4 }]);
    expect(r.created).toEqual([{ partNumber: 'ACM-90001', listPence: 4450 }]);
  });

  it('rejects a mapping whose columns are not in the file', async () => {
    await expect(importPriceFile(env.ctx(), { mapping: { ...mapping, columns: { part_number: 'Nope' } }, content, sourceName: 'x.csv' })).rejects.toMatchObject({ code: 'VALIDATION' });
  });
});

describe('Ibcos Gold bridge', () => {
  it('imports customers with the placeholder mapping', async () => {
    const csv = 'Account,Name,Postcode,Telephone,Price Band,On Stop\nGREEN1,Greenacre Farms,HR9 9ZZ,01632 960099,Trade,N\nHILL01,Hilltop Farm Partnership (updated),,,Contract,N\n';
    const r = await importLegacyFile(env.ctx(), { options: { entity: 'customers' }, content: csv, sourceName: 'gold-customers.csv' });
    expect(r).toMatchObject({ summary: { created: 1, updated: 1 } });
  });

  it('syncs stock to Gold figures through auditable adjustments; dry run rolls back', async () => {
    const ctx = env.ctx();
    const part = await findPart(ctx, { partNumber: 'ACM-20310' });
    const before = (await stockByDepot(ctx, part.id)).find((d) => d.depotCode === 'NTH')!.onHand;
    const csv = `Depot,Franchise,Part Number,Free Stock,Bin\nNorth,ACM,ACM 20310,${before + 3},N-A1\nNorth,ACM,ACM-99999,2,\nNowhere,ACM,ACM-20310,1,\n`;
    const options = { entity: 'stock' as const, mode: 'sync' as const, depotMap: { North: 'NTH' } };
    const dry = await importLegacyFile(ctx, { options, content: csv, sourceName: 'gold-stock.csv', dryRun: true });
    expect(dry).toMatchObject({ dryRun: true });
    expect((await stockByDepot(ctx, part.id)).find((d) => d.depotCode === 'NTH')!.onHand).toBe(before);

    const r = await importLegacyFile(ctx, { options, content: csv, sourceName: 'gold-stock.csv' });
    expect(r).toMatchObject({ summary: { issues: { error: 1, warn: 1 } } }); // unknown depot; placeholder part
    const after = (await stockByDepot(ctx, part.id)).find((d) => d.depotCode === 'NTH')!;
    expect(after.onHand).toBe(before + 3);
    expect(after.bin).toBe('N-A1');
    expect(await reconcileLedger(ctx)).toEqual([]);
  });

  it('tells you exactly which columns are missing', async () => {
    await expect(importLegacyFile(env.ctx(), { options: { entity: 'stock' }, content: 'Foo,Bar\n1,2\n', sourceName: 'bad.csv' })).rejects.toThrow(/part_number \("Part Number"\)/);
  });
});

const sampleInvoice: InvoiceCreatedPayload = {
  invoiceNumber: 'INV-000042', orderNumber: 'SO-000101', customerRef: 'PO-77',
  customer: { accountCode: 'HILL01', name: 'Hilltop Farm Partnership', email: null, accountingRef: null },
  issuedAt: '2026-11-15T10:00:00.000Z', dueDate: '2026-12-15', netPence: 2316, vatPence: 463, grossPence: 2779,
  lines: [{ partNumber: 'ACM-10044', make: 'ACM', description: 'ACM-10044 Engine oil filter', qty: 1, unitNetPence: 2316, lineNetPence: 2316, vatRateBps: 2000, lineVatPence: 463 }],
};

describe('Xero connector', () => {
  it('maps an invoice to an ACCREC with UK tax types', () => {
    const x = buildXeroInvoice(sampleInvoice, { salesAccountCode: '4000' }).Invoices[0]!;
    expect(x).toMatchObject({ Type: 'ACCREC', InvoiceNumber: 'INV-000042', Reference: 'PO-77', LineAmountTypes: 'Exclusive', Status: 'DRAFT', Contact: { ContactNumber: 'HILL01' } });
    expect(x.LineItems[0]).toMatchObject({ UnitAmount: 23.16, TaxType: 'OUTPUT2', AccountCode: '4000' });
  });

  it('posts with tenant header and idempotency key; surfaces errors', async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const ok = createXeroAdapter({
      getToken: async () => 'tok',
      fetch: async (url, init) => { calls.push({ url, headers: init.headers }); return { ok: true, status: 200, text: async () => JSON.stringify({ Invoices: [{ InvoiceID: 'x-123' }] }) }; },
    });
    expect(await ok.pushInvoice(sampleInvoice, { xeroTenantId: 't-1' })).toEqual({ externalId: 'x-123' });
    expect(calls[0]!.headers).toMatchObject({ 'xero-tenant-id': 't-1', 'Idempotency-Key': 'agriparts-INV-000042', Authorization: 'Bearer tok' });
    const bad = createXeroAdapter({ getToken: async () => 'tok', fetch: async () => ({ ok: false, status: 400, text: async () => 'Validation' }) });
    await expect(bad.pushInvoice(sampleInvoice, { xeroTenantId: 't-1' })).rejects.toThrow(/Xero 400/);
  });
});

describe('outbox dispatcher', () => {
  it('delivers signed webhooks and posts invoices to accounting; retries failures', async () => {
    const { db } = env.database;
    const noop = { accounting: new Map(), fetch: async () => ({ ok: true, status: 200, text: async () => '' }) };
    await runDispatcherOnce(db, noop); // drain history before subscribing
    const secret = newWebhookSecret();
    await db.insert(webhookSubscriptions).values({ tenantId: env.tenantId, url: 'https://hooks.example/agri', secret, eventTypes: ['invoice.created', 'order.confirmed'] });
    await db.insert(integrationConnections).values({ tenantId: env.tenantId, kind: 'accounting', provider: 'log', eventTypes: ['invoice.created'] });
    const accounting = createLogAccountingAdapter();
    const received: { headers: Record<string, string>; body: string }[] = [];
    let failNext = 1;
    const deps = {
      accounting: new Map([['log', accounting]]),
      fetch: async (_url: string, init: { headers: Record<string, string>; body?: string }) => {
        if (failNext-- > 0) return { ok: false, status: 503, text: async () => 'busy' };
        received.push({ headers: init.headers, body: init.body! });
        return { ok: true, status: 200, text: async () => 'ok' };
      },
    };

    const ctx = env.ctx();
    const q = await createQuote(ctx, { customerAccount: 'OAK01', depotCode: 'HQ', lines: [{ partNumber: 'GEN-GR-400', qty: 1 }] });
    await confirmOrder(ctx, q.number);
    const { invoice } = await invoiceOrder(ctx, q.number);

    const first = await runDispatcherOnce(db, deps);
    expect(first.failed).toBe(1); // first webhook got a 503
    expect(accounting.posted.map((i) => i.invoiceNumber)).toEqual([invoice.number]);
    const [inv] = await db.select().from(invoices).where(eq(invoices.number, invoice.number));
    expect(inv!.accountingRef).toBe(`LOG-${invoice.number}`);

    // Retry after backoff.
    await runDispatcherOnce(db, { ...deps, now: () => new Date(Date.now() + backoffMs(1) + 1000) });
    const types = received.map((r) => JSON.parse(r.body).type).sort();
    expect(types).toEqual(['invoice.created', 'order.confirmed']);
    for (const r of received) expect(verifySignature(secret, r.body, r.headers['AgriParts-Signature']!)).toBe(true);
    expect(verifySignature('whsec_wrong', received[0]!.body, received[0]!.headers['AgriParts-Signature']!)).toBe(false);
    expect(MAX_ATTEMPTS).toBeGreaterThan(3);
  });
});
