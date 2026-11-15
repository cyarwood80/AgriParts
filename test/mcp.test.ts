import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildApp, type App } from '../src/api/app.js';
import { defaultOrderingRegistry } from '../src/integrations/ordering/adapters.js';
import { toolCallLog } from '../src/db/schema.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let app: App;
let base: string;
beforeAll(async () => {
  env = await setupTestEnv();
  app = await buildApp({ db: env.database.db, ordering: defaultOrderingRegistry(), confirmSecret: 'test-secret' });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
afterAll(async () => {
  await app.close();
  await env.database.close();
});

async function connect(key: string) {
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${key}` } } }));
  return client;
}

async function call(client: Client, name: string, args: Record<string, unknown>) {
  const res = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(res.isError), body: JSON.parse(res.content[0]!.text) };
}

describe('MCP over Streamable HTTP', () => {
  it('filters tools by the key\'s scopes', async () => {
    const ro = await connect(env.keys.readonly);
    const roTools = (await ro.listTools()).tools.map((t) => t.name);
    expect(roTools).toContain('search_parts');
    expect(roTools).toContain('reorder_suggestions');
    expect(roTools).not.toContain('confirm_order');
    expect(roTools).not.toContain('create_quote');
    await ro.close();

    const counter = await connect(env.keys.counter);
    const tools = (await counter.listTools()).tools;
    expect(tools.map((t) => t.name)).toEqual(expect.arrayContaining(['create_quote', 'confirm_order', 'transfer_stock', 'raise_purchase_order']));
    expect(tools.find((t) => t.name === 'confirm_order')!.annotations?.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === 'search_parts')!.annotations?.readOnlyHint).toBe(true);
    await counter.close();
  });

  it('rejects unauthenticated MCP connections', async () => {
    await expect(connect('ap_aaaaaaaaaaaa_bad')).rejects.toThrow();
  });

  it('resolves, prices and quotes a superseded part; money comes back as £', async () => {
    const c = await connect(env.keys.counter);
    const resolved = await call(c, 'resolve_part_number', { part_number: 'acm/10021', make: 'ACM' });
    expect(resolved.body.part.partNumber).toBe('ACM-10044');
    expect(resolved.body.superseded).toBe(true);
    const price = await call(c, 'get_price', { part_number: 'ACM-10021', make: 'ACM', customer_account: 'HILL01' });
    expect(price.body.unitNet).toMatch(/^£\d+\.\d{2}$/);
    expect(price.body.explanation).toMatch(/25\.00% off list/);
    const ambiguous = await call(c, 'resolve_part_number', { part_number: 'NOPE-1' });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.error).toBe('NOT_FOUND');
    await c.close();
  });

  it('two-phase confirm: preview changes nothing, wrong code refused, right code commits', async () => {
    const c = await connect(env.keys.counter);
    const quote = await call(c, 'create_quote', { customer_account: 'OAK01', depot_code: 'HQ', lines: [{ part_number: 'GEN-GR-400', qty: 2 }] });
    const number = quote.body.number;

    const preview = await call(c, 'confirm_order', { order_number: number });
    expect(preview.body.status).toBe('PREVIEW_ONLY_NOTHING_CHANGED');
    expect(preview.body.preview.lines[0].willAllocate).toBe(2);
    expect((await call(c, 'get_order', { order_number: number })).body.status).toBe('quote');

    const wrong = await call(c, 'confirm_order', { order_number: number, confirmation_code: 'CONF-WRONGWRONG' });
    expect(wrong.isError).toBe(true);
    // A code for one order can't confirm another.
    const other = await call(c, 'create_quote', { customer_account: 'OAK01', depot_code: 'HQ', lines: [{ part_number: 'GEN-GR-400', qty: 2 }] });
    expect((await call(c, 'confirm_order', { order_number: other.body.number, confirmation_code: preview.body.confirmation_code })).isError).toBe(true);

    const done = await call(c, 'confirm_order', { order_number: number, confirmation_code: preview.body.confirmation_code });
    expect(done.body.status).toBe('DONE');
    expect(done.body.result.status).toBe('confirmed');
    await c.close();
  });

  it('a confirmation code dies when the underlying stock changes', async () => {
    const c = await connect(env.keys.counter);
    const args = { part_number: 'GEN-GR-400', from_depot: 'HQ', to_depot: 'STH', qty: 1, reason: 'cover STH order' };
    const preview = await call(c, 'transfer_stock', args);
    expect(preview.body.preview.blockers).toEqual([]);
    // Someone sells one at HQ meanwhile.
    const q = await call(c, 'create_quote', { customer_account: 'CASH', depot_code: 'HQ', lines: [{ part_number: 'GEN-GR-400', qty: 1 }] });
    const p2 = await call(c, 'confirm_order', { order_number: q.body.number });
    await call(c, 'confirm_order', { order_number: q.body.number, confirmation_code: p2.body.confirmation_code });
    const stale = await call(c, 'transfer_stock', { ...args, confirmation_code: preview.body.confirmation_code });
    expect(stale.isError).toBe(true);
    expect(stale.body.message).toMatch(/changed since the preview/);
    await c.close();
  });

  it('raises a draft PO from reorder suggestions, and logs every tool call', async () => {
    const c = await connect(env.keys.counter);
    const preview = await call(c, 'raise_purchase_order', { supplier_code: 'AMX', depot_code: 'HQ', from_suggestions: true });
    expect(preview.isError).toBe(false);
    expect(preview.body.preview.lines.length).toBeGreaterThan(0);
    const done = await call(c, 'raise_purchase_order', { supplier_code: 'AMX', depot_code: 'HQ', from_suggestions: true, confirmation_code: preview.body.confirmation_code });
    expect(done.body.result.status).toBe('draft');
    const logged = await env.database.db.select().from(toolCallLog);
    expect(logged.length).toBeGreaterThan(5);
    expect(logged.every((l) => l.principal.startsWith('api_key:'))).toBe(true);
    await c.close();
  });

  it('exposes prompts and resources', async () => {
    const c = await connect(env.keys.counter);
    expect((await c.listPrompts()).prompts.map((p) => p.name)).toEqual(expect.arrayContaining(['counter_assistant', 'morning_parts_review']));
    const res = await c.readResource({ uri: 'agriparts://parts/ACM/ACM-10044' });
    expect(JSON.parse((res.contents[0] as { text: string }).text).part.partNumber).toBe('ACM-10044');
    await c.close();
  });
});
