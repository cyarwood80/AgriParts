/**
 * Demo field-guidance content. EVERYTHING here is invented: makes, models,
 * document references, procedures and every spec value. It exists to show the
 * shape of the feature and must never be used on a real machine.
 *
 * Three licences show the rules at work:
 *  - Acme workshop content: offline + AI allowed, 14-day offline window
 *  - Northfield service literature: offline allowed, AI not allowed
 *  - Acme service bulletins: view online only (not packed offline)
 */
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { DB } from './client.js';
import {
  contentFlags, contentLicences, customers, documentPages, machineModels, machines, partFitment, parts, procedureParts, procedureSteps,
  procedures, serviceDocuments, type ProcedureSpec,
} from './schema.js';
import { normalisePartNumber } from '../lib/part-number.js';
import { checkProcedure } from '../services/content-checks.js';

type Step = [instruction: string, page: number, specs?: ProcedureSpec[], caution?: string];
interface ProcSeed {
  doc: string;
  model?: string;
  code: string;
  title: string;
  summary: string;
  estMinutes: number;
  skill: 'basic' | 'competent' | 'specialist';
  pages: [number, number];
  tools: string[];
  safety: string[];
  parts: [make: string, pn: string, role: 'replaced' | 'consumable' | 'may_need', qty: number][];
  steps: Step[];
}

const DEMO = 'DEMO VALUE';
const DEMO_HEADER = 'DEMO PAGE: invented text, not a real manual.';

const PROCS: ProcSeed[] = [
  {
    doc: 'ACM-WM', code: 'WM-AT-02-04', title: 'Engine oil and filter change',
    summary: 'Drain engine oil, replace the spin-on oil filter, refill and check for leaks.',
    estMinutes: 45, skill: 'basic', pages: [214, 216],
    tools: ['Filter strap wrench', '19 mm socket', 'Torque wrench (20-100 N·m)', 'Drain tray (20 L)'],
    safety: ['Engine off, key removed, parking brake on.', 'Oil may be hot: allow at least 15 minutes to cool.', 'Dispose of used oil and filters as hazardous waste.'],
    parts: [['ACM', 'ACM-10044', 'replaced', 1], ['GEN', 'GEN-15W40-20', 'consumable', 1]],
    steps: [
      ['Park on level ground. Run the engine for 2 minutes to warm the oil, then stop and remove the key.', 214],
      ['Place the drain tray under the sump and remove the drain plug. Allow to drain fully.', 214, [], 'Hot oil. Wear gloves.'],
      ['Fit a new sealing washer and refit the drain plug.', 214, [{ label: 'Drain plug torque', value: `45 (${DEMO})`, unit: 'N·m' }]],
      ['Unscrew the old filter with the strap wrench. Check the old seal has come away with it.', 215],
      ['Smear clean oil on the new filter seal. Screw on until the seal touches, then tighten by hand.', 215, [{ label: 'Filter tightening', value: `Seal contact + 3/4 turn (${DEMO})` }], 'Do not use the strap wrench to tighten.'],
      ['Refill through the rocker cover filler.', 216, [{ label: 'Oil capacity with filter', value: `14.5 (${DEMO})`, unit: 'L' }, { label: 'Grade', value: `15W-40 (${DEMO})` }]],
      ['Run for 1 minute, stop, wait 5 minutes and check the dipstick. Check the filter and drain plug for leaks.', 216],
    ],
  },
  {
    doc: 'ACM-WM', code: 'WM-AT-03-02', title: 'Fuel filters: replace and bleed',
    summary: 'Replace primary and secondary fuel filter elements and bleed the low-pressure system.',
    estMinutes: 40, skill: 'competent', pages: [308, 310],
    tools: ['Filter bowl wrench', 'Clean fuel container', 'Lint-free cloths'],
    safety: ['No naked flames or smoking.', 'Never loosen high-pressure injector pipes with the engine running.'],
    parts: [['ACM', 'ACM-20310', 'replaced', 1], ['ACM', 'ACM-20311', 'replaced', 1]],
    steps: [
      ['Close the fuel tap. Clean around both filter heads.', 308],
      ['Drain water from the primary filter bowl, then unscrew the bowl and remove the element.', 308],
      ['Fit the new primary element and new bowl O-ring. Tighten the bowl by hand.', 309, [{ label: 'Bowl torque', value: `Hand tight, max 10 (${DEMO})`, unit: 'N·m' }]],
      ['Replace the secondary element the same way.', 309],
      ['Open the fuel tap. Operate the hand primer until firm resistance (about 60 strokes).', 310, [{ label: 'Primer strokes', value: `approx. 60 (${DEMO})` }]],
      ['Start the engine. If it falters, stop and repeat priming. Check for leaks.', 310, [], 'Do not crank for more than 20 seconds at a time.'],
    ],
  },
  {
    doc: 'ACM-WM', code: 'WM-AT-04-01', title: 'Air filter elements: service and replace',
    summary: 'Replace the outer element; replace the inner safety element every third outer change.',
    estMinutes: 20, skill: 'basic', pages: [402, 403],
    tools: ['Torch', 'Clean cloth'],
    safety: ['Never run the engine with the air filter housing open.', 'Do not blow out elements with compressed air.'],
    parts: [['ACM', 'ACM-30552', 'replaced', 1], ['ACM', 'ACM-30553', 'may_need', 1]],
    steps: [
      ['Release the three housing clips and remove the end cover. Empty the dust valve.', 402],
      ['Withdraw the outer element. Inspect the inner element without removing it.', 402],
      ['If due (every 3rd outer change) or damaged, replace the inner safety element.', 403, [{ label: 'Inner element interval', value: `Every 3rd outer change or 1000 h (${DEMO})` }]],
      ['Wipe the housing with a damp cloth. Fit the new outer element and refit the cover with the dust valve pointing down.', 403],
      ['Reset the restriction indicator on the dash.', 403],
    ],
  },
  {
    doc: 'ACM-WM', code: 'WM-AT-07-03', title: 'Hydraulic return filter replacement',
    summary: 'Replace the transmission/hydraulic return filter and top up with UTTO.',
    estMinutes: 35, skill: 'competent', pages: [721, 722],
    tools: ['24 mm socket', 'Torque wrench', 'Drain tray'],
    safety: ['Lower all implements to the ground and relieve hydraulic pressure before starting.', 'Hydraulic oil under pressure can penetrate skin. Seek medical help immediately if injured.'],
    parts: [['ACM', 'ACM-41870', 'replaced', 1], ['GEN', 'GEN-UTTO-20', 'may_need', 1]],
    steps: [
      ['Lower the linkage and any loader to the ground. Stop the engine and cycle the spool levers to release pressure.', 721, [], 'Stored pressure: never skip this step.'],
      ['Unscrew the filter cover on the right-hand side of the transmission housing. Remove the element.', 721],
      ['Fit the new element with a new cover O-ring.', 722, [{ label: 'Cover torque', value: `60 (${DEMO})`, unit: 'N·m' }]],
      ['Start the engine, operate the linkage through its full range three times, then check the sight glass. Top up with UTTO if needed.', 722, [{ label: 'Oil', value: `UTTO (${DEMO})` }]],
    ],
  },
  {
    doc: 'NFB-SM', code: 'SM-SB12-05-02', title: 'Knotter bill hook replacement (revised type)',
    summary: 'The revised bill hook NFB-2215 replaces NFB-2210 and needs the revised mounting bracket NFB-2216. Fit both together, then retime the knotter.',
    estMinutes: 90, skill: 'specialist', pages: [510, 514],
    tools: ['Knotter timing gauge', '13 mm and 17 mm spanners', 'Torque wrench', 'Soft-faced mallet'],
    safety: ['Disconnect the PTO shaft and remove it from the tractor before working on the knotter.', 'Lock the flywheel with the flywheel brake pin.', 'Knotter parts are sharp: wear cut-resistant gloves.'],
    parts: [['NFB', 'NFB-2215', 'replaced', 1], ['NFB', 'NFB-2216', 'replaced', 1], ['NFB', 'NFB-5120', 'may_need', 1]],
    steps: [
      ['Disconnect the PTO, engage the flywheel brake pin, and open the knotter guard.', 510, [], 'The old bracket will not hold the revised bill hook. Do not refit it.'],
      ['Remove the bill hook pinion nut and withdraw the old bill hook and bracket as one assembly.', 511],
      ['Fit the revised bracket NFB-2216 to the knotter frame.', 512, [{ label: 'Bracket bolt torque', value: `35 (${DEMO})`, unit: 'N·m' }]],
      ['Fit the revised bill hook NFB-2215 through the bracket and refit the pinion nut.', 512, [{ label: 'Pinion nut torque', value: `50 (${DEMO})`, unit: 'N·m' }]],
      ['Rotate the knotter by hand to the timing mark and check the bill hook position with the timing gauge.', 513, [{ label: 'Bill hook timing', value: `Tongue opens 2.5 mm before knife pass (${DEMO})` }]],
      ['Check the twine knife clearance; replace the knife if chipped.', 514, [{ label: 'Knife to bill hook clearance', value: `0.5-1.0 (${DEMO})`, unit: 'mm' }]],
      ['Remove the brake pin, close the guard, and tie 10 test bales before releasing the machine.', 514],
    ],
  },
  {
    doc: 'NFB-SM', code: 'SM-SB12-02-06', title: 'Pick-up tine replacement',
    summary: 'Replace broken or bent pick-up tines. Replace in sets per bar where more than three are missing.',
    estMinutes: 30, skill: 'basic', pages: [230, 231],
    tools: ['10 mm socket', 'Tine bar puller'],
    safety: ['PTO disconnected and pick-up lowered onto blocks.'],
    parts: [['NFB', 'NFB-3400', 'replaced', 10]],
    steps: [
      ['Lower the pick-up onto blocks. Remove the side shield.', 230],
      ['Remove the tine retaining bolts on the affected bar and slide out the broken tines.', 230],
      ['Fit new tines with the coil to the rear.', 231, [{ label: 'Tine bolt torque', value: `12 (${DEMO})`, unit: 'N·m' }]],
      ['Turn the pick-up by hand to check tines clear the strippers.', 231],
    ],
  },
  {
    doc: 'DH-OM', code: 'OM-FM55-06-01', title: 'Flail hammer replacement',
    summary: 'Replace worn flail hammers. Always replace diametrically opposite pairs to keep the rotor in balance.',
    estMinutes: 60, skill: 'competent', pages: [604, 607],
    tools: ['24 mm socket and breaker bar', 'Torque wrench (to 200 N·m)', 'Wire brush'],
    safety: ['Head lowered to the ground, PTO disconnected, tractor key removed.', 'Wait for the rotor to stop completely: it runs on for over a minute.', 'Never replace a single hammer. Out-of-balance rotors can throw hammers.'],
    parts: [['DH', 'DH-10442', 'replaced', 4], ['DH', 'DH-10460', 'may_need', 4]],
    steps: [
      ['Lower the head and tilt the rotor to give access from beneath.', 604, [], 'Never work under a raised head without the transport locks fitted.'],
      ['Remove the hammer bolt and nut. Discard both: they are single-use.', 605],
      ['Clean the lug with the wire brush and check for cracks. Replace the lug assembly if cracked.', 605],
      ['Fit the new hammer with new bolt and nut, and replace the diametrically opposite hammer at the same time.', 606, [{ label: 'Hammer bolt torque', value: `170 (${DEMO})`, unit: 'N·m' }]],
      ['Rotate the rotor by hand and check every hammer swings freely.', 607],
      ['Run at low PTO speed for 1 minute and check for vibration before work.', 607, [], 'Vibration means imbalance. Stop and check pairs.'],
    ],
  },
  {
    doc: 'DH-OM', code: 'OM-FM55-06-04', title: 'Rotor bearing replacement',
    summary: 'Replace a worn 2-bolt flange rotor bearing on the drive or non-drive end.',
    estMinutes: 120, skill: 'specialist', pages: [612, 615],
    tools: ['Bearing puller', 'Grub screw key', 'Torque wrench', 'Grease gun'],
    safety: ['Support the rotor on stands before releasing either bearing.'],
    parts: [['DH', 'DH-10471', 'replaced', 1], ['GEN', 'GEN-GR-400', 'consumable', 1]],
    steps: [
      ['Support the rotor on stands. Loosen the bearing grub screws.', 612],
      ['Remove the flange bolts and draw the bearing off the shaft with the puller.', 613],
      ['Clean the shaft. Fit the new bearing and flange bolts.', 614, [{ label: 'Flange bolt torque', value: `80 (${DEMO})`, unit: 'N·m' }]],
      ['Tighten the grub screws and grease until fresh grease appears at the seal.', 615, [{ label: 'Grub screw torque', value: `15 (${DEMO})`, unit: 'N·m' }]],
    ],
  },
  {
    doc: 'ACM-SB', code: 'SB-AT-2026-04', title: 'Service bulletin: oil filter head seal update',
    summary: 'On early AT-series engines, check the filter head seal at the next oil change and fit the updated filter ACM-10044.',
    estMinutes: 10, skill: 'basic', pages: [1, 2],
    tools: [], safety: ['Engine off.'],
    parts: [['ACM', 'ACM-10044', 'replaced', 1]],
    steps: [
      ['Inspect the filter head sealing face for scoring.', 1],
      ['Fit the updated filter ACM-10044. The older ACM-10021 and ACM-10021A must not be refitted.', 2],
    ],
  },
];

/**
 * Two "extracted" procedures waiting for the foreman, so the review screen has
 * something to show. One passes the checks; the other has a transcription
 * slip (the page says 12, the extraction says 15) that the verbatim check
 * catches. Their page text is in REVIEW_PAGES.
 */
const REVIEW_PROCS: (ProcSeed & { status: 'in_review' | 'draft' })[] = [
  {
    status: 'in_review', doc: 'DH-OM', code: 'OM-FM55-07-02', title: 'Rotor gearbox oil change',
    summary: 'Drain and refill the rotor drive gearbox.', estMinutes: 30, skill: 'basic', pages: [702, 703],
    tools: ['17 mm spanner', 'Drain tray'], safety: ['Head lowered, PTO disconnected, key removed.'],
    parts: [],
    steps: [
      ['Remove the drain plug and drain the gearbox while warm.', 702],
      ['Refit the drain plug with a new washer.', 702, [{ label: 'Drain plug torque', value: `30 (${DEMO})`, unit: 'N·m' }]],
      ['Fill to the level plug.', 703, [{ label: 'Gearbox oil capacity', value: `1.8 (${DEMO})`, unit: 'L' }]],
    ],
  },
  {
    status: 'draft', doc: 'DH-OM', code: 'OM-FM55-07-05', title: 'Drive belt tension',
    summary: 'Check and set rotor drive belt tension.', estMinutes: 20, skill: 'competent', pages: [705, 705],
    tools: ['Belt tension gauge'], safety: ['Guards must be refitted before the PTO is engaged.'],
    parts: [],
    steps: [
      ['Remove the belt guard.', 705],
      ['Measure belt deflection midway between the pulleys.', 705, [{ label: 'Belt deflection', value: `15 (${DEMO})`, unit: 'mm' }]],
      ['Adjust the tensioner, then refit the guard.', 705],
    ],
  },
];

const REVIEW_PAGES: Record<number, string> = {
  702: `Section 7 Rotor drive. 7.2 Gearbox oil. Remove the drain plug and drain the gearbox while warm. Refit the drain plug with a new washer. Drain plug torque: 30 (${DEMO}) N·m.`,
  703: `Fill to the level plug. Gearbox oil capacity: 1.8 (${DEMO}) L. Use only the oil grade listed in section 2.`,
  705: `7.5 Drive belt. Remove the belt guard. Measure belt deflection midway between the pulleys. Belt deflection: 12 (${DEMO}) mm. Adjust the tensioner, then refit the guard.`,
};

/** Invented page text for each seeded page: what the step cites, so the verbatim check passes and the page viewer has something to show. */
function demoPages(doc: string, procs: ProcSeed[]): Map<number, string> {
  const pages = new Map<number, string[]>();
  const add = (n: number, line: string) => pages.set(n, [...(pages.get(n) ?? []), line]);
  for (const p of procs.filter((x) => x.doc === doc)) {
    for (let n = p.pages[0]; n <= p.pages[1]; n++) add(n, `${p.code} ${p.title}.`);
    for (const [instruction, page, specs, caution] of p.steps) {
      add(page, instruction);
      if (caution) add(page, `CAUTION: ${caution}`);
      for (const sp of specs ?? []) add(page, `${sp.label}: ${sp.value}${sp.unit ? ` ${sp.unit}` : ''}.`);
    }
  }
  return new Map([...pages].map(([n, lines]) => [n, `${DEMO_HEADER}\n${lines.join('\n')}`]));
}

export async function seedGuidanceDemo(db: DB, tenantId: string) {
  const existing = await db.select({ id: machineModels.id }).from(machineModels).where(eq(machineModels.tenantId, tenantId)).limit(1);
  if (existing.length) return false;

  const lic = await db.insert(contentLicences).values([
    { tenantId, publisher: 'Acme Tractors UK (demo)', title: 'Acme dealer workshop content (demo)', reference: 'DEMO-ACM-LIC-01', kind: 'manufacturer_licence', permissionRef: 'demo://licences/ACM-LIC-01.pdf', allowOffline: true, allowAi: true, offlineDays: 14, validFrom: '2026-01-01', expiresOn: '2027-12-31' },
    { tenantId, publisher: 'Northfield Balers (demo)', title: 'Northfield service literature (demo)', reference: 'DEMO-NFB-LIC-07', kind: 'manufacturer_licence', permissionRef: 'demo://licences/NFB-LIC-07.pdf', allowOffline: true, allowAi: false, offlineDays: 7, validFrom: '2026-03-01', expiresOn: '2027-02-28' },
    { tenantId, publisher: 'Acme Tractors UK (demo)', title: 'Acme service bulletins, online only (demo)', reference: 'DEMO-ACM-SB', kind: 'oem_consent', permissionRef: 'demo://consent/ACM-area-manager-email.eml', allowOffline: false, allowAi: true, offlineDays: 0 },
    { tenantId, publisher: 'Demo Hedgecutters Ltd', title: 'Demo Hedgecutters operator manuals (demo)', reference: 'DEMO-DH-01', kind: 'manufacturer_licence', permissionRef: 'demo://licences/DH-01.pdf', allowOffline: true, allowAi: true, offlineDays: 30 },
  ]).returning();

  const docs = await db.insert(serviceDocuments).values([
    { tenantId, licenceId: lic[0]!.id, make: 'ACM', kind: 'workshop_manual', title: 'AT-series tractor workshop manual (demo)', docRef: 'ACM-WM-AT-EN', revision: 'Rev 6', publishedOn: '2026-02-10' },
    { tenantId, licenceId: lic[1]!.id, make: 'NFB', kind: 'workshop_manual', title: 'SB-1200 small square baler service manual (demo)', docRef: 'NFB-SM-SB12', revision: 'Issue C', publishedOn: '2026-04-01' },
    { tenantId, licenceId: lic[2]!.id, make: 'ACM', kind: 'service_bulletin', title: 'Service bulletin SB-AT-2026-04 (demo)', docRef: 'SB-AT-2026-04', revision: '1', publishedOn: '2026-09-15' },
    { tenantId, licenceId: lic[3]!.id, make: 'DH', kind: 'operator_manual', title: 'Flailmaster 5.5 operator and maintenance manual (demo)', docRef: 'DH-OM-FM55', revision: 'v3', publishedOn: '2025-06-01' },
  ]).returning();
  const docId: Record<string, string> = { 'ACM-WM': docs[0]!.id, 'NFB-SM': docs[1]!.id, 'ACM-SB': docs[2]!.id, 'DH-OM': docs[3]!.id };

  const models = await db.insert(machineModels).values([
    { tenantId, make: 'ACM', model: 'AT-140', series: 'AT', kind: 'Tractor', yearFrom: 2019 },
    { tenantId, make: 'ACM', model: 'AT-165', series: 'AT', kind: 'Tractor', yearFrom: 2021 },
    { tenantId, make: 'NFB', model: 'SB-1200', series: 'SB', kind: 'Small square baler', yearFrom: 2016 },
    { tenantId, make: 'DH', model: 'Flailmaster 5.5', series: 'FM', kind: 'Hedgecutter', yearFrom: 2018 },
  ]).returning();
  const modelId = Object.fromEntries(models.map((m) => [m.model, m.id]));

  const custRows = await db.select().from(customers).where(eq(customers.tenantId, tenantId));
  const cust = Object.fromEntries(custRows.map((c) => [c.accountCode, c.id]));
  await db.insert(machines).values([
    { tenantId, customerId: cust.HILL01, machineModelId: modelId['AT-165']!, serial: 'ACM165-K004417', regNo: 'DX71 HLT', year: 2021, engineHours: 3412, site: 'Hilltop Farm, main yard' },
    { tenantId, customerId: cust.HILL01, machineModelId: modelId['SB-1200']!, serial: 'NFB12-88213', year: 2017, site: 'Hilltop Farm, Dutch barn' },
    { tenantId, customerId: cust.BRK01, machineModelId: modelId['Flailmaster 5.5']!, serial: 'FM55-20219', year: 2020, site: 'Mounted on BRK01 tractor #3' },
    { tenantId, customerId: cust.BRK01, machineModelId: modelId['AT-140']!, serial: 'ACM140-J002198', regNo: 'WP69 BLC', year: 2019, engineHours: 6120, site: 'Brook Lane depot' },
    { tenantId, customerId: cust.OAK01, machineModelId: modelId['AT-140']!, serial: 'ACM140-J003051', regNo: 'SY20 OAK', year: 2020, engineHours: 2875, site: 'Oakfield Home Farm' },
    { tenantId, customerId: cust.MEAD01, machineModelId: modelId['AT-165']!, serial: 'ACM165-K005120', regNo: 'HR22 MDB', year: 2022, engineHours: 1904, site: 'Meadowbank parlour yard' },
  ]);

  const fit = (model: string, list: [string, string, string, number?][]) =>
    list.map(([make, pn, assembly, qty]) => ({ tenantId, machineModelId: modelId[model]!, make, partNumberNorm: normalisePartNumber(pn), assembly, qtyPerMachine: qty ?? 1, source: 'seed' }));
  const atParts: [string, string, string, number?][] = [
    ['ACM', 'ACM-10044', 'Engine: lubrication'], ['ACM', 'ACM-20310', 'Engine: fuel'], ['ACM', 'ACM-20311', 'Engine: fuel'],
    ['ACM', 'ACM-30552', 'Engine: air intake'], ['ACM', 'ACM-30553', 'Engine: air intake'], ['ACM', 'ACM-41870', 'Transmission: hydraulics'],
    ['ACM', 'ACM-55120', 'Cab'], ['ACM', 'ACM-60718', 'Linkage'], ['ACM', 'ACM-71002', 'Cab'],
  ];
  await db.insert(partFitment).values([
    ...fit('AT-140', atParts), ...fit('AT-165', atParts),
    ...fit('SB-1200', [['NFB', 'NFB-2215', 'Knotter', 2], ['NFB', 'NFB-2216', 'Knotter', 2], ['NFB', 'NFB-5120', 'Knotter', 2], ['NFB', 'NFB-3400', 'Pick-up', 64], ['NFB', 'NFB-3410', 'Drive: shear bolts']]),
    ...fit('Flailmaster 5.5', [['DH', 'DH-10442', 'Rotor', 36], ['DH', 'DH-10460', 'Rotor', 36], ['DH', 'DH-10471', 'Rotor', 2]]),
  ]);

  const procId: Record<string, string> = {};
  for (const p of PROCS) {
    const [row] = await db.insert(procedures).values({
      tenantId, documentId: docId[p.doc]!, machineModelId: p.model ? modelId[p.model] : null, code: p.code, title: p.title, summary: p.summary,
      estMinutes: p.estMinutes, skill: p.skill, pageFrom: p.pages[0], pageTo: p.pages[1], tools: p.tools, safety: p.safety,
      status: 'published', origin: 'seed', verifiedBy: 'demo seed', verifiedAt: new Date(),
    }).returning();
    await db.insert(procedureSteps).values(p.steps.map(([instruction, page, specs, caution], i) => ({
      tenantId, procedureId: row!.id, seq: i + 1, instruction, page, specs: specs ?? [], caution: caution ?? null,
    })));
    await db.insert(procedureParts).values(p.parts.map(([make, pn, role, qty]) => ({ tenantId, procedureId: row!.id, make, partNumberNorm: normalisePartNumber(pn), role, qty })));
    procId[p.code] = row!.id;
  }

  // Page text for every seeded page, so the page viewer and verbatim check work on the demo.
  const pageMaps: Record<string, Map<number, string>> = {};
  for (const doc of Object.keys(docId)) {
    const m = demoPages(doc, PROCS);
    if (doc === 'DH-OM') for (const [n, t] of Object.entries(REVIEW_PAGES)) m.set(Number(n), `${DEMO_HEADER}\n${t}`);
    pageMaps[doc] = m;
    if (!m.size) continue;
    await db.insert(documentPages).values([...m].map(([page, text]) => ({ tenantId, documentId: docId[doc]!, page, text, textSha256: createHash('sha256').update(text).digest('hex') })));
    await db.update(serviceDocuments).set({ pageCount: Math.max(...m.keys()) }).where(eq(serviceDocuments.id, docId[doc]!));
  }

  // Store check results for the live demo procedures too, as the pipeline would have.
  const known = new Set((await db.select({ make: parts.make, norm: parts.partNumberNorm }).from(parts).where(eq(parts.tenantId, tenantId))).map((x) => `${x.make}|${x.norm}`));
  for (const p of PROCS) {
    const steps = p.steps.map(([instruction, page, specs], i) => ({ seq: i + 1, instruction, page, specs: specs ?? [] }));
    const checkReport = checkProcedure({ pageFrom: p.pages[0], pageTo: p.pages[1], steps, parts: p.parts.map(([make, pn]) => ({ make, partNumber: normalisePartNumber(pn) })) }, pageMaps[p.doc]!, known);
    await db.update(procedures).set({ checkReport }).where(eq(procedures.id, procId[p.code]!));
  }

  // Waiting for the foreman: one passing extraction, one with a check error.
  for (const p of REVIEW_PROCS) {
    const steps = p.steps.map(([instruction, page, specs, caution], i) => ({ seq: i + 1, instruction, page, specs: specs ?? [], caution: caution ?? null }));
    const checkReport = checkProcedure({ pageFrom: p.pages[0], pageTo: p.pages[1], steps, parts: [] }, pageMaps[p.doc]!, new Set());
    const [row] = await db.insert(procedures).values({
      tenantId, documentId: docId[p.doc]!, code: p.code, title: p.title, summary: p.summary, estMinutes: p.estMinutes, skill: p.skill,
      pageFrom: p.pages[0], pageTo: p.pages[1], tools: p.tools, safety: p.safety, status: p.status, origin: 'extracted', checkReport,
    }).returning();
    await db.insert(procedureSteps).values(steps.map((st) => ({ tenantId, procedureId: row!.id, ...st })));
  }

  // An engineer's flag on a live procedure.
  await db.insert(contentFlags).values({
    tenantId, procedureId: procId['OM-FM55-06-01']!, stepSeq: 4, flaggedBy: 'Demo engineer (field)',
    message: 'Bolts on this machine take a 27 mm socket, not 24 mm as in the tools list.',
  });
  return true;
}
