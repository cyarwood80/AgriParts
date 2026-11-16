import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { procedures } from '../src/db/schema.js';
import { recheckProcedure, reviewDetail, reviewQueue } from '../src/services/content.js';
import { guidanceForPart } from '../src/services/guidance.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env.database.close());

// Uses the invented demo seed: two extracted procedures waiting for review and one engineer flag.
describe('foreman review screen data', () => {
  it('queues the demo items: one ready, one blocked by a spec slip, one flagged from the field', async () => {
    const q = await reviewQueue(env.ctx());
    const ready = q.find((p) => p.code === 'OM-FM55-07-02')!;
    const blocked = q.find((p) => p.code === 'OM-FM55-07-05')!;
    const flagged = q.find((p) => p.code === 'OM-FM55-06-01')!;
    expect(ready).toMatchObject({ status: 'in_review', checkOk: true, errors: 0 });
    expect(blocked).toMatchObject({ status: 'draft', checkOk: false, errors: 1 });
    expect(flagged).toMatchObject({ status: 'published', openFlags: 1, checkOk: true, errors: 0 });
  });

  it('returns steps, the cited page text, issues per step, flags and history', async () => {
    const q = await reviewQueue(env.ctx());
    const d = await reviewDetail(env.ctx(), q.find((p) => p.code === 'OM-FM55-07-05')!.id);
    expect(d.steps).toHaveLength(3);
    expect(d.pages.map((p) => p.page)).toEqual([705]);
    expect(d.pages[0]!.text).toMatch(/Belt deflection: 12 \(DEMO VALUE\) mm/);
    const issue = d.check!.issues.find((i) => i.code === 'SPEC_NOT_VERBATIM')!;
    expect(issue.stepSeq).toBe(2);
    expect(d.document.docRef).toBe('DH-OM-FM55');
    expect(d.history).toEqual([]);

    const live = await reviewDetail(env.ctx(), q.find((p) => p.code === 'OM-FM55-06-01')!.id);
    expect(live.flags[0]).toMatchObject({ stepSeq: 4, status: 'open' });
  });

  it('needs content:write; engineers with guidance:read cannot open it', async () => {
    const q = await reviewQueue(env.ctx());
    await expect(reviewDetail(env.ctx(['guidance:read']), q[0]!.id)).rejects.toThrow(/content:write/);
  });

  it('every seeded live procedure passes the verbatim check against its demo pages', async () => {
    const live = await env.database.db.select({ id: procedures.id, code: procedures.code }).from(procedures).where(and(eq(procedures.tenantId, env.tenantId), eq(procedures.status, 'published')));
    expect(live.length).toBeGreaterThan(0);
    for (const p of live) {
      const r = await recheckProcedure(env.ctx(), p.id);
      expect({ code: p.code, errors: r.issues.filter((i) => i.severity === 'error') }).toEqual({ code: p.code, errors: [] });
    }
  });

  it('gives the field view the document id so engineers can open the cited page', async () => {
    const g = await guidanceForPart(env.ctx(), { partNumber: 'DH-10442', make: 'DH' });
    expect(g.procedures[0]!.source.documentId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
