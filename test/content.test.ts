import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { auditLog, contentLicences } from '../src/db/schema.js';
import { MemoryBlobStore, setBlobStore } from '../src/lib/blob-store.js';
import {
  addDocumentLink, editStep, flagStep, getDocumentFile, getPage, linksFor, registerDocument, reviewProcedure, reviewQueue,
  submitExtraction, type ExtractedDocument,
} from '../src/services/content.js';
import { appearsVerbatim, checkProcedure } from '../src/services/content-checks.js';
import { guidanceForPart } from '../src/services/guidance.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
let acmLicenceId: string;
const blobs = new MemoryBlobStore();
const FAKE_PDF = new TextEncoder().encode('%PDF-1.4\n% demo bytes for tests, not a real manual\n');

// Invented page text (demo only, not from any real manual).
const PAGES = [
  { page: 1, text: 'AT-series cab (DEMO)\nContents' },
  { page: 2, text: 'Wiper blade replacement\n1. Lift the wiper arm away from the screen.\n2. Fit the new blade. Tighten the arm nut to 12 N‑m (DEMO VALUE).' },
  { page: 3, text: 'Top link service\nTorque the ball-end lock nut to 280 Nm (DEMO VALUE).' },
];

const extraction = (torque: string): ExtractedDocument => ({
  models: ['AT-165'],
  procedures: [
    {
      code: 'CAB-01', title: 'Replace front wiper blade', summary: null, model: 'AT-165', pageFrom: 2, pageTo: 2, skill: 'basic', estMinutes: 10,
      tools: ['13 mm spanner'], safety: [],
      steps: [
        { instruction: 'Lift the wiper arm away from the screen.', page: 2, specs: [], caution: null },
        { instruction: 'Fit the new blade and tighten the arm nut.', page: 2, specs: [{ label: 'Arm nut torque', value: '12 N-m', unit: null }], caution: null },
      ],
      parts: [{ partNumber: 'ACM-55120', role: 'replaced', qty: 1 }],
    },
    {
      code: 'LNK-01', title: 'Service top link', summary: null, model: null, pageFrom: 3, pageTo: 3, skill: 'competent', estMinutes: 30,
      tools: [], safety: ['Lower the implement to the ground first.'],
      steps: [{ instruction: 'Torque the ball-end lock nut.', page: 3, specs: [{ label: 'Lock nut torque', value: torque, unit: null }], caution: null }],
      parts: [{ partNumber: 'ACM-60718', role: 'replaced', qty: 1 }, { partNumber: 'ACM-NOT-REAL', role: 'may_need', qty: 1 }],
    },
  ],
});

beforeAll(async () => {
  setBlobStore(blobs);
  env = await setupTestEnv();
  const [l] = await env.database.db.select().from(contentLicences).where(and(eq(contentLicences.tenantId, env.tenantId), eq(contentLicences.reference, 'DEMO-ACM-LIC-01')));
  acmLicenceId = l!.id;
});
afterAll(async () => env.database.close());

describe('deterministic checks', () => {
  it('matches verbatim modulo whitespace and dash variants only', () => {
    expect(appearsVerbatim('12 N-m', 'tighten to 12 N‑m (DEMO)')).toBe(true);
    expect(appearsVerbatim('280 Nm', 'to 280Nm (DEMO)')).toBe(true);
    expect(appearsVerbatim('280 Nm', 'to\n  280   Nm')).toBe(true);
    expect(appearsVerbatim('28 Nm', 'to 280 Nm')).toBe(false);
    expect(appearsVerbatim('2.5 bar', 'set to 2,5 bar')).toBe(false);
    expect(appearsVerbatim('', 'anything')).toBe(false);
  });

  it('reports missing pages, unpaged steps and unknown parts', () => {
    const r = checkProcedure(
      { pageFrom: 1, pageTo: 9, steps: [{ seq: 1, instruction: 'x', page: null, specs: [] }, { seq: 2, instruction: 'y', page: 1, specs: [{ label: 'T', value: '5 Nm', unit: 'furlongs' }] }], parts: [{ make: 'ACM', partNumber: 'ZZZ-1' }] },
      new Map([[1, 'nothing here']]),
      new Set(),
    );
    expect(r.ok).toBe(false);
    expect(r.issues.map((i) => i.code).sort()).toEqual(['PAGE_MISSING', 'PART_UNKNOWN', 'SPEC_NOT_VERBATIM', 'STEP_NO_PAGE', 'UNIT_UNKNOWN']);
  });
});

describe('content pipeline', () => {
  let docId: string;

  it('refuses documents under a licence with no permission reference', async () => {
    const [l] = await env.database.db.insert(contentLicences).values({ tenantId: env.tenantId, publisher: 'Unsigned Ltd (demo)', title: 'Verbal OK only', kind: 'manufacturer_licence' }).returning();
    await expect(registerDocument(env.ctx(), { meta: { licenceId: l!.id, make: 'ACM', kind: 'operator_manual', title: 't', docRef: 'X' } })).rejects.toThrow(/permission reference/);
  });

  it('registers a document with its PDF and pages; same file twice is a duplicate', async () => {
    const meta = { licenceId: acmLicenceId, make: 'acm', kind: 'workshop_manual' as const, title: 'AT cab and linkage (demo)', docRef: 'ACM-DEMO-CAB' };
    const r = await registerDocument(env.ctx(), { meta, pdf: FAKE_PDF, pages: PAGES });
    expect(r.duplicate).toBe(false);
    expect(r.pages).toBe(3);
    expect(r.document.make).toBe('ACM');
    docId = r.document.id;
    expect([...blobs.items.keys()][0]).toBe(`tenant/${env.tenantId}/docs/${docId}/source.pdf`);
    const again = await registerDocument(env.ctx(), { meta, pdf: FAKE_PDF });
    expect(again.duplicate).toBe(true);
    expect(again.document.id).toBe(docId);
  });

  it('turns an extraction into drafts: passing checks go to review, failing ones stay draft', async () => {
    const s = await submitExtraction(env.ctx(), { documentId: docId, extraction: extraction('290 Nm'), run: { model: 'claude-opus-5-5', mode: 'sync', pageFrom: 1, pageTo: 3 } });
    expect(s.inReview).toBe(1);
    expect(s.draft).toBe(1);
    const lnk = s.results.find((r) => r.code === 'LNK-01')!;
    expect(lnk.check.issues.find((i) => i.code === 'SPEC_NOT_VERBATIM')?.message).toMatch(/290 Nm/);
    expect(lnk.check.issues.some((i) => i.code === 'PART_UNKNOWN' && i.severity === 'warn')).toBe(true);
  });

  it('never shows unpublished procedures to engineers', async () => {
    const g = await guidanceForPart(env.ctx(), { partNumber: 'ACM-55120', make: 'ACM' });
    expect(g.procedures.map((p) => p.code)).not.toContain('CAB-01');
  });

  it('blocks approval while checks fail; a fixed step goes back to review and can then be approved', async () => {
    const q = await reviewQueue(env.ctx());
    const lnk = q.find((p) => p.code === 'LNK-01')!;
    expect(lnk.status).toBe('draft');
    expect(lnk.errors).toBe(1);
    await expect(reviewProcedure(env.ctx(), lnk.id, { decision: 'approve' })).rejects.toThrow(/check error/);

    const fixed = await editStep(env.ctx(), lnk.id, 1, { specs: [{ label: 'Lock nut torque', value: '280 Nm' }] }, 'matched to page 3');
    expect(fixed.status).toBe('in_review');
    expect(fixed.version).toBe(2);
    const ok = await reviewProcedure(env.ctx(), lnk.id, { decision: 'approve', notes: 'checked against page 3' });
    expect(ok.status).toBe('published');
  });

  it('needs the content:review scope to approve', async () => {
    const cab = (await reviewQueue(env.ctx())).find((p) => p.code === 'CAB-01')!;
    await expect(reviewProcedure(env.ctx(['content:write', 'guidance:read']), cab.id, { decision: 'approve' })).rejects.toThrow(/content:review/);
    await reviewProcedure(env.ctx(['content:review', 'guidance:read']), cab.id, { decision: 'approve' });
    const g = await guidanceForPart(env.ctx(), { partNumber: 'ACM-55120', make: 'ACM' });
    const cabProc = g.procedures.find((p) => p.code === 'CAB-01')!;
    expect(cabProc.steps[1]!.specs[0]!.value).toBe('12 N-m');
  });

  it('re-extraction leaves published procedures alone', async () => {
    const s = await submitExtraction(env.ctx(), { documentId: docId, extraction: extraction('999 Nm') });
    expect(s.skipped).toBe(2);
  });

  it('engineer flags put a live procedure back in the queue; re-approval resolves them', async () => {
    const g = await guidanceForPart(env.ctx(), { partNumber: 'ACM-55120', make: 'ACM' });
    const id = g.procedures.find((p) => p.code === 'CAB-01')!.id;
    await flagStep(env.ctx(['guidance:read']), id, { stepSeq: 2, message: 'Nut is 17 mm on this tractor, not 13 mm' });
    const q = await reviewQueue(env.ctx());
    expect(q.find((p) => p.id === id)?.openFlags).toBe(1);
    const r = await reviewProcedure(env.ctx(), id, { decision: 'approve', notes: 'tool list corrected' });
    expect(r.resolvedFlags).toBe(1);
    expect((await reviewQueue(env.ctx())).find((p) => p.id === id)).toBeUndefined();
  });

  it('serves pages and the source file under a live licence, and audits file views', async () => {
    const p = await getPage(env.ctx(['guidance:read']), docId, 3);
    expect(p.text).toMatch(/280 Nm/);
    const f = await getDocumentFile(env.ctx(['guidance:read']), docId);
    expect(new TextDecoder().decode(f.data.subarray(0, 5))).toBe('%PDF-');
    const views = await env.database.db.select().from(auditLog).where(and(eq(auditLog.tenantId, env.tenantId), eq(auditLog.action, 'content.file_viewed')));
    expect(views.length).toBe(1);
  });

  it('stores portal deep links, not content, and fills placeholders', async () => {
    await addDocumentLink(env.ctx(), { make: 'ACM', label: 'Acme service portal: machine', urlTemplate: 'https://portal.example.com/acme/machine?serial={serial}', portal: 'Acme portal (demo)' });
    await expect(addDocumentLink(env.ctx(), { make: 'ACM', label: 'x', urlTemplate: 'http://insecure.example.com', portal: 'x' })).rejects.toThrow();
    const links = await linksFor(env.ctx(), { make: 'acm', serial: 'ACM165 K004417' });
    expect(links[0]!.url).toBe('https://portal.example.com/acme/machine?serial=ACM165%20K004417');
  });
});
