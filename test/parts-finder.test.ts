import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { partFitment } from '../src/db/schema.js';
import { pickMachine, queryWords, splitQuestion } from '../src/integrations/parts-agent/rules.js';
import {
  addCustomerMessage, findPart, getEnquiry, listEnquiries, openEnquiry, partCard, requestCallback, resolveEnquiry, sendReply,
} from '../src/services/parts-finder.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  delete process.env.ANTHROPIC_API_KEY; // the offline matcher; the Claude engine needs a key and network
  env = await setupTestEnv();
});
afterAll(async () => env.database.close());

// All customers, machines and parts are the invented demo seed.
describe('parts agent (offline matcher)', () => {
  it('turns farm words into catalogue words', () => {
    expect(queryWords('Flail hammers keep flying off')).toEqual(expect.arrayContaining(['flail', 'hammer']));
    expect(splitQuestion(['Fuel filter element, primary', 'Fuel filter element, secondary'])).toBe('Primary or secondary?');
  });

  it('picks the machine from model words, kind words or the serial', () => {
    const ms = [
      { serial: 'ACM165-K004417', make: 'ACM', model: 'AT-165', kind: 'Tractor', year: 2021, engineHours: 1 },
      { serial: 'NFB12-88213', make: 'NFB', model: 'SB-1200', kind: 'Small square baler', year: 2017, engineHours: null },
    ];
    expect(pickMachine('oil filter for the 165', ms)?.serial).toBe('ACM165-K004417');
    expect(pickMachine('knotter keeps missing', ms)?.serial).toBe('NFB12-88213');
    expect(pickMachine('88213 needs tines', ms)?.serial).toBe('NFB12-88213');
    expect(pickMachine('a filter please', ms)).toBeNull();
  });
});

describe('enquiries', () => {
  it('seeds a queue with a stopped machine first', async () => {
    const q = await listEnquiries(env.ctx());
    expect(q[0]).toMatchObject({ priority: 'vor', account: 'BRK01' });
    expect(q.map((e) => e.account)).toEqual(expect.arrayContaining(['HILL01', 'OAK01', 'MEAD01']));
  });

  it('a described part with a known machine: confident, with evidence from our data', async () => {
    const q = await listEnquiries(env.ctx());
    const e = await getEnquiry(env.ctx(), q.find((x) => x.account === 'HILL01')!.id);
    expect(e.machine?.serial).toBe('ACM165-K004417');
    const best = e.result!.candidates.find((c) => c.role === 'best')!;
    expect(best.partNumber).toBe('ACM-10044');
    expect(e.result!.confidence).toBe('high');
    const kinds = best.evidence.map((x) => x.kind);
    expect(kinds).toEqual(expect.arrayContaining(['parts_book', 'supersession', 'history', 'described']));
    expect(best.evidence.find((x) => x.kind === 'history')!.text).toMatch(/3 times for this machine/);
    expect(best.evidence.find((x) => x.kind === 'supersession')!.text).toBe('Replaces ACM-10021 → ACM-10021A. Straight swap.');
    expect(best.guide?.code).toBe('WM-AT-02-04');
    expect(best.bulletins!.map((b) => b.code)).toContain('SB-AT-2026-04');
    expect(best.withIt!.map((w) => w.partNumber)).toContain('GEN-15W40-20');
    expect(e.result!.candidates.find((c) => c.role === 'alternative')?.partNumber).toBe('GEN-OF-118');
    expect(e.result!.reply).toMatch(/^It's ACM-10044/);
  });

  it('two parts fit: asks one question, then answers when the customer replies', async () => {
    const q = await listEnquiries(env.ctx());
    const id = q.find((x) => x.account === 'OAK01')!.id;
    const e = await getEnquiry(env.ctx(), id);
    expect(e.result!.question).toBe('Outer or inner?');
    expect(e.result!.candidates.filter((c) => c.role === 'option').map((c) => c.partNumber).sort()).toEqual(['ACM-30552', 'ACM-30553']);
    await sendReply(env.ctx(), id, e.result!.reply);
    expect((await getEnquiry(env.ctx(), id)).status).toBe('waiting_customer');
    const after = await addCustomerMessage(env.ctx(), id, 'The outer one');
    expect(after.result!.candidates.find((c) => c.role === 'best')?.partNumber).toBe('ACM-30552');
    expect(after.result!.question).toBeNull();
    expect(after.status).toBe('open');
  });

  it('safety-critical parts always go to a person, with a callback time', async () => {
    const q = await listEnquiries(env.ctx());
    const e = await getEnquiry(env.ctx(), q.find((x) => x.account === 'MEAD01')!.id);
    expect(e.status).toBe('callback');
    expect(e.result!.escalate?.reason).toMatch(/safety-critical/);
    expect(e.result!.reply).toMatch(/safety part/);
    const due = new Date(e.callbackDueAt!).getTime() - new Date(e.updatedAt).getTime();
    expect(due).toBeGreaterThan(55 * 60_000);
  });

  it('a stopped machine gets a 15-minute callback when handed over', async () => {
    const q = await listEnquiries(env.ctx());
    const vor = q.find((x) => x.priority === 'vor')!;
    const e = await requestCallback(env.ctx(), vor.id, { reason: 'Customer wants to talk it through', assignee: 'Dave' });
    expect(e.assignedTo).toBe('Dave');
    const mins = (new Date(e.callbackDueAt!).getTime() - Date.now()) / 60_000;
    expect(mins).toBeGreaterThan(13);
    expect(mins).toBeLessThanOrEqual(15);
  });

  it('a part number from the customer resolves through supersession', async () => {
    const e = await openEnquiry(env.ctx(), { channel: 'counter', customerAccount: 'HILL01', message: 'Have you got an acm 10021 for the 165?' });
    const best = e.result!.candidates.find((c) => c.role === 'best')!;
    expect(best.partNumber).toBe('ACM-10044');
    expect(best.evidence[0]!.kind).toBe('number');
    expect(e.result!.confidence).toBe('high');
  });

  it('resolving with the right part teaches fitment for that model', async () => {
    const e = await openEnquiry(env.ctx(), { channel: 'counter', customerAccount: 'HILL01', machineSerial: 'NFB12-88213', message: 'Need a work light for the baler' });
    const r = await resolveEnquiry(env.ctx(), e.id, { partNumber: 'GEN-LED-WL', notes: 'Fits the baler bracket' });
    expect(r.learnedFitment).toBe(true);
    expect(r.status).toBe('resolved');
    const rows = await env.database.db.select().from(partFitment).where(and(eq(partFitment.tenantId, env.tenantId), eq(partFitment.partNumberNorm, 'GENLEDWL')));
    expect(rows[0]).toMatchObject({ source: 'enquiry', confidence: 80 });
  });

  it('needs enquiries:write to work an enquiry', async () => {
    await expect(openEnquiry(env.ctx(['parts:read']), { message: 'oil filter' })).rejects.toThrow(/enquiries:write/);
  });
});

describe('guided find (nothing stored)', () => {
  it('machine + description gives the right part with evidence, price and the fitting guide', async () => {
    const r = await findPart(env.ctx(), { serial: 'ACM165-K004417', messages: ['oil filter'] });
    expect(r.machine?.model).toBe('AT-165');
    const best = r.candidates.find((c) => c.role === 'best')!;
    expect(best.partNumber).toBe('ACM-10044');
    expect(best.guide?.code).toBe('WM-AT-02-04');
    expect(best.stock?.length).toBeGreaterThan(0);
    expect(r.needsPerson).toBeNull();
  });

  it('two parts fit: asks one question, and the answer settles it', async () => {
    const q = await findPart(env.ctx(), { serial: 'FM55-20219', messages: ['flail hammers'] });
    expect(q.question).toBe('80mm or 100mm?');
    expect(q.candidates.filter((c) => c.role === 'option')).toHaveLength(2);
    const a = await findPart(env.ctx(), { serial: 'FM55-20219', messages: ['flail hammers', '80mm'] });
    expect(a.candidates.find((c) => c.role === 'best')?.partNumber).toBe('DH-10442');
  });

  it('takes a conversation with its own replies, and works without a machine', async () => {
    const r = await findPart(env.ctx(), { serial: 'FM55-20219', messages: [{ role: 'user', body: 'flail hammers' }, { role: 'assistant', body: '80mm or 100mm?' }, { role: 'user', body: '100mm' }] });
    expect(r.candidates.find((c) => c.role === 'best')?.partNumber).toBe('DH-10460');
    const open = await findPart(env.ctx(), { messages: ['oil filter for a Valtra T214'] });
    expect(open.machine).toBeNull();
    expect(open.engine).toBe('rules');
    expect(open.reply).toBeTruthy();
  });

  it('safety-critical parts are flagged for the parts desk', async () => {
    const r = await findPart(env.ctx(), { serial: 'ACM165-K004417', messages: ['top link'] });
    expect(r.needsPerson).toMatch(/safety-critical/);
  });

  it('part card says whether it fits the machine', async () => {
    const yes = await partCard(env.ctx(), { make: 'DH', partNumber: 'DH-10442', serial: 'FM55-20219' });
    expect(yes.fitsMachine).toBe(true);
    expect(yes.part.guide?.code).toBe('OM-FM55-06-01');
    const no = await partCard(env.ctx(), { make: 'DH', partNumber: 'DH-10442', serial: 'ACM165-K004417' });
    expect(no.fitsMachine).toBe(false);
  });
});
