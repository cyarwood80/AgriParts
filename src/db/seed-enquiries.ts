/**
 * Demo parts-finder data. EVERYTHING is invented. A little sales history (so
 * "bought before" evidence shows) and four enquiries run through the real
 * agent, one of each kind the desk handles:
 *  - a stopped machine (VOR) that needs one question answered
 *  - a confident match with evidence
 *  - a question between two parts that both fit
 *  - a safety-critical part handed to a person
 */
import { and, eq } from 'drizzle-orm';
import type { DB } from './client.js';
import { customers, machines, partSalesHistory } from './schema.js';
import { normalisePartNumber } from '../lib/part-number.js';
import { ServiceContext } from '../services/context.js';
import { openEnquiry } from '../services/parts-finder.js';

const HISTORY: [invoice: string, on: string, account: string, serial: string, make: string, pn: string, qty: number, netPence: number][] = [
  ['DEMO-INV-7001', '2025-11-14', 'HILL01', 'ACM165-K004417', 'ACM', 'ACM-10021A', 1, 2475],
  ['DEMO-INV-7342', '2026-02-03', 'HILL01', 'ACM165-K004417', 'ACM', 'ACM-10044', 1, 2450],
  ['DEMO-INV-7618', '2026-04-14', 'HILL01', 'ACM165-K004417', 'ACM', 'ACM-10044', 1, 2450],
  ['DEMO-INV-7702', '2026-06-02', 'BRK01', 'FM55-20219', 'DH', 'DH-10442', 8, 11088],
  ['DEMO-INV-7810', '2026-03-10', 'OAK01', 'ACM140-J003051', 'ACM', 'ACM-30552', 1, 7605],
];

export async function seedEnquiriesDemo(db: DB, tenantId: string) {
  // Seed with the offline matcher: start-up must not wait on (or spend) a live model.
  const engineWas = process.env.PARTS_AGENT_ENGINE;
  process.env.PARTS_AGENT_ENGINE = 'rules';
  try {
    await seedEnquiries(db, tenantId);
  } finally {
    if (engineWas === undefined) delete process.env.PARTS_AGENT_ENGINE;
    else process.env.PARTS_AGENT_ENGINE = engineWas;
  }
}

async function seedEnquiries(db: DB, tenantId: string) {
  const custRows = await db.select().from(customers).where(eq(customers.tenantId, tenantId));
  const cust = Object.fromEntries(custRows.map((c) => [c.accountCode, c.id]));
  const machRows = await db.select().from(machines).where(and(eq(machines.tenantId, tenantId)));
  const mach = Object.fromEntries(machRows.map((m) => [m.serial, m.id]));
  await db.insert(partSalesHistory).values(
    HISTORY.map(([invoiceRef, invoicedOn, account, serial, make, pn, qty, netPence]) => ({
      tenantId, invoiceRef, invoicedOn, customerId: cust[account] ?? null, machineId: mach[serial] ?? null, make, partNumber: pn, partNumberNorm: normalisePartNumber(pn), qty, netPence,
    })),
  );

  const ctx = ServiceContext.system(db, tenantId);
  await openEnquiry(ctx, { channel: 'whatsapp', customerAccount: 'BRK01', contactName: 'Jess (Brook Lane)', priority: 'vor', message: "Flail hammers keep flying off the Flailmaster. Need a set today, machine's stopped." });
  await openEnquiry(ctx, { channel: 'phone', customerAccount: 'HILL01', contactName: 'Tom Hill', message: 'Need the oil filter for the 165, the one low down by the starter.' });
  await openEnquiry(ctx, { channel: 'email', customerAccount: 'OAK01', contactName: 'Oakfield farm office', message: 'Air filter for the AT-140 please, collecting Thursday.' });
  await openEnquiry(ctx, { channel: 'counter', customerAccount: 'MEAD01', contactName: 'Sam (Meadowbank)', message: 'Top link for the 165, the old one has bent.' });
}
