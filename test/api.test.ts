import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp, type App } from '../src/api/app.js';
import { defaultOrderingRegistry } from '../src/integrations/ordering/adapters.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: App;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp({ db: env.database.db, ordering: defaultOrderingRegistry(), confirmSecret: 'test-secret' });
});
afterAll(async () => {
  await app.close();
  await env.database.close();
});

const auth = (key: string) => ({ authorization: `Bearer ${key}` });

describe('REST API', () => {
  it('rejects missing and bad keys', async () => {
    expect((await app.inject({ method: 'GET', url: '/v1/depots' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/v1/depots', headers: auth('ap_aaaaaaaaaaaa_nope') })).statusCode).toBe(401);
  });

  it('enforces scopes per key', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/sales-orders', headers: auth(env.keys.readonly), payload: { customerAccount: 'HILL01', depotCode: 'HQ', lines: [{ partNumber: 'GEN-GR-400', qty: 1 }] } });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('validates input with useful errors', async () => {
    const res = await app.inject({ method: 'POST', url: '/v1/sales-orders', headers: auth(env.keys.admin), payload: { customerAccount: 'HILL01', lines: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('VALIDATION');
  });

  it('runs a counter sale end to end over HTTP', async () => {
    const h = auth(env.keys.admin);
    const search = await app.inject({ method: 'GET', url: '/v1/parts?q=grease', headers: h });
    expect(search.json()[0].partNumber).toBe('GEN-GR-400');
    const quote = await app.inject({ method: 'POST', url: '/v1/sales-orders', headers: h, payload: { customerAccount: 'BRK01', depotCode: 'HQ', lines: [{ partNumber: 'gen gr 400', qty: 3 }] } });
    expect(quote.statusCode).toBe(201);
    const number = quote.json().number;
    expect((await app.inject({ method: 'POST', url: `/v1/sales-orders/${number}/confirm`, headers: h })).json().status).toBe('confirmed');
    const inv = await app.inject({ method: 'POST', url: `/v1/sales-orders/${number}/invoice`, headers: h });
    expect(inv.json().invoice.number).toMatch(/^INV-/);
    expect((await app.inject({ method: 'GET', url: '/v1/stock/reconcile', headers: h })).json()).toEqual([]);
  });

  it('replays POSTs with the same Idempotency-Key and refuses key reuse', async () => {
    const h = { ...auth(env.keys.admin), 'idempotency-key': 'till-7-txn-0001' };
    const payload = { customerAccount: 'CASH', depotCode: 'HQ', lines: [{ partNumber: 'GEN-GR-400', qty: 1 }] };
    const a = await app.inject({ method: 'POST', url: '/v1/sales-orders', headers: h, payload });
    const b = await app.inject({ method: 'POST', url: '/v1/sales-orders', headers: h, payload });
    expect(b.statusCode).toBe(201);
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(b.json().number).toBe(a.json().number);
    const c = await app.inject({ method: 'POST', url: '/v1/sales-orders', headers: h, payload: { ...payload, customerRef: 'different' } });
    expect(c.statusCode).toBe(422);
  });

  it('serves an OpenAPI document', async () => {
    const res = await app.inject({ method: 'GET', url: '/docs/json' });
    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.json().paths)).toContain('/v1/sales-orders/{order}/confirm');
  });

  it('price file import defaults to dry run', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/integrations/price-files', headers: auth(env.keys.admin),
      payload: { mapping: { supplier: 'DHC', make: 'DH', columns: { part_number: 'PN', list_price: 'RRP' } }, content: 'PN,RRP\nDH-77777,12.50\n', sourceName: 't.csv' },
    });
    expect(res.json()).toMatchObject({ dryRun: true, created: [{ partNumber: 'DH-77777', listPence: 1250 }] });
  });
});
