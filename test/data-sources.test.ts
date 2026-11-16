import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { machines, partFitment, partSalesHistory } from '../src/db/schema.js';
import { importLegacyFile, parseUkDate } from '../src/integrations/legacy-import/ibcos-bridge.js';
import { importFitment, inferFitmentFromSales } from '../src/integrations/parts-books/fitment-import.js';
import { listDataSources } from '../src/services/data-sources.js';
import { machineDetail, serialInRange } from '../src/services/guidance.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env.database.close());

// All data below is invented (column headers are the unconfirmed Ibcos placeholders).
const MACHINES_CSV = [
  'Serial No,Make,Model,Account,Year,Hours,Reg No,Type',
  'ACM165-K004417,ACM,AT-165,HILL01,2021,3000,DX71 HLT,Tractor', // hours lower than ours (3412)
  'MW300-55102,MOW,Disc 300,BRK01,2023,,,Mower',
  'ACM140-J009999,ACM,AT-140,NOBODY,2024,120,,Tractor',
].join('\n');

const SALES_CSV = [
  'Invoice No,Line,Invoice Date,Account,Serial No,Franchise,Part Number,Qty,Net Value',
  'INV-9001,1,03/02/2026,HILL01,ACM165-K004417,ACM,acm 30552,1,24.50',
  'INV-9002,1,14/04/2026,HILL01,ACM165-K004417,ACM,ACM-30552,1,24.50',
  'INV-9003,1,2026-06-30,MEAD01,ACM165-K005120,ACM,ACM30552,2,49.00',
  'INV-9004,1,31/02/2026,HILL01,,ACM,ACM-30552,1,24.50',
  'INV-9005,1,01/07/2026,HILL01,MW300-55102,MOW,MOW-77,4,40.00',
  'INV-9006,1,02/07/2026,BRK01,MW300-55102,MOW,MOW-77,4,40.00',
  'INV-9007,1,03/07/2026,BRK01,MW300-55102,MOW,MOW-77,4,40.00',
].join('\n');

describe('Ibcos bridge: machines and sales history', () => {
  it('parses UK dates and rejects impossible ones', () => {
    expect(parseUkDate('03/02/2026')).toBe('2026-02-03');
    expect(parseUkDate('3/2/26')).toBe('2026-02-03');
    expect(parseUkDate('2026-06-30')).toBe('2026-06-30');
    expect(parseUkDate('31/02/2026')).toBeNull();
    expect(parseUkDate('02-30-2026')).toBeNull();
  });

  it('loads the wholegoods register: new models, owners, hours never go down', async () => {
    const r = await importLegacyFile(env.ctx(), { options: { entity: 'machines' }, content: MACHINES_CSV, sourceName: 'wholegoods.csv' });
    if (!('summary' in r)) throw new Error('expected a load');
    expect(r.summary).toMatchObject({ created: 2, updated: 0, unchanged: 1 });
    expect(r.issues.some((i) => /hours went down \(3412 -> 3000\)/.test(i.message))).toBe(true);
    const [m] = await env.database.db.select().from(machines).where(and(eq(machines.tenantId, env.tenantId), eq(machines.serial, 'ACM165-K004417')));
    expect(m!.engineHours).toBe(3412);
    expect(r.issues.some((i) => /NOBODY not found/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /new machine model MOW Disc 300/.test(i.message))).toBe(true);
  });

  it('loads sales history idempotently, linking customer and machine', async () => {
    const r = await importLegacyFile(env.ctx(), { options: { entity: 'sales_history' }, content: SALES_CSV, sourceName: 'sales-2026.csv' });
    if (!('summary' in r)) throw new Error('expected a load');
    expect(r.summary).toMatchObject({ created: 6, skipped: 1 });
    expect(r.issues.find((i) => i.severity === 'error')?.message).toMatch(/31\/02\/2026/);
    const again = await importLegacyFile(env.ctx(), { options: { entity: 'sales_history' }, content: SALES_CSV, sourceName: 'sales-2026.csv' });
    expect(again).toMatchObject({ skipped: true });
    const reordered = SALES_CSV.split('\n');
    const r2 = await importLegacyFile(env.ctx(), { options: { entity: 'sales_history' }, content: [reordered[0], ...reordered.slice(1).reverse()].join('\n'), sourceName: 'sales-2026-reexport.csv' });
    if (!('summary' in r2)) throw new Error('expected a load');
    expect(r2.summary).toMatchObject({ created: 0, unchanged: 6 });
    const lines = (await env.database.db.select().from(partSalesHistory).where(eq(partSalesHistory.tenantId, env.tenantId))).filter((l) => l.invoiceRef.startsWith('INV-'));
    expect(lines).toHaveLength(6);
    expect(lines.find((l) => l.invoiceRef === 'INV-9001')!.partNumberNorm).toBe('ACM30552');
    expect(lines.find((l) => l.invoiceRef === 'INV-9001')!.machineId).not.toBeNull();
  });

  it('infers unverified fitment from repeat sales against a model', async () => {
    const r = await inferFitmentFromSales(env.ctx(), { minInvoices: 3 });
    expect(r.created).toBe(1); // MOW-77 on Disc 300; ACM-30552 already fitted to AT-165 by the parts book
    const d = await machineDetail(env.ctx(), 'MW300-55102');
    const line = d.fittedParts.find((p) => p.partNumber === 'MOW77')!;
    expect(line.fitmentSource).toBe('sales_inferred');
    expect(line.verified).toBe(false);
    expect(line.confidence).toBeLessThanOrEqual(70);
  });

  it('registers ibcos-gold as a data source with its batches', async () => {
    const s = await listDataSources(env.ctx());
    const ibcos = s.find((x) => x.code === 'ibcos-gold')!;
    expect(ibcos.kind).toBe('dms_export');
    expect(ibcos.batches).toBe(3);
    expect(ibcos.lastLoadedAt).not.toBeNull();
  });
});

describe('parts-book fitment', () => {
  const FIT_CSV = [
    'Model,Make,Part Number,Assembly,Qty,Figure,Page,Serial From,Serial To',
    'AT-165,ACM,ACM-99001,Cab: early wiper motor,1,Fig 12 item 4,88,,K004999',
    'AT-165,ACM,ACM-99002,Cab: late wiper motor,1,Fig 12 item 5,88,K005000,',
    'Disc 300,MOW,MOW-77,Cutterbar,4,Fig 3 item 1,12,,',
  ].join('\n');

  it('loads lines with page, figure and serial breaks; parts book replaces inferred lines', async () => {
    const r = await importFitment(env.ctx(), { options: { sourceCode: 'demo-parts-books' }, content: FIT_CSV, sourceName: 'at165-cab.csv' });
    if (!('summary' in r)) throw new Error('expected a load');
    expect(r.summary).toMatchObject({ created: 2, updated: 1 });
    const [mow] = await env.database.db.select().from(partFitment).where(and(eq(partFitment.tenantId, env.tenantId), eq(partFitment.partNumberNorm, 'MOW77')));
    expect(mow!.source).toBe('parts_book');
    expect(mow!.confidence).toBe(100);
  });

  it('applies serial breaks to the machine view', async () => {
    const early = await machineDetail(env.ctx(), 'ACM165-K004417');
    const late = await machineDetail(env.ctx(), 'ACM165-K005120');
    const pns = (d: typeof early) => d.fittedParts.map((p) => p.partNumber);
    expect(pns(early)).toContain('ACM99001');
    expect(pns(early)).not.toContain('ACM99002');
    expect(pns(late)).toContain('ACM99002');
    expect(pns(late)).not.toContain('ACM99001');
    expect(early.fittedParts.find((p) => p.partNumber === 'ACM99001')!.reference).toBe('p88 Fig 12 item 4');
  });

  it('compares serials numerically within a prefix and keeps lines it cannot judge', () => {
    expect(serialInRange('ACM140-J002198', 'J002000', 'J010000')).toBe(true);
    expect(serialInRange('ACM140-J012198', null, 'J010000')).toBe(false);
    expect(serialInRange('ACM140-J002198', 'K000001', null)).toBe(true);
    expect(serialInRange('88213', '88000', '88999')).toBe(true);
  });
});
