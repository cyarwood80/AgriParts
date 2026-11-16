import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, contentLicences } from '../src/db/schema.js';
import { guidanceForPart, issueJobPack, machineDetail, packStatus, searchMachines } from '../src/services/guidance.js';
import { setupTestEnv, type TestEnv } from './helpers.js';

let env: TestEnv;
beforeAll(async () => {
  env = await setupTestEnv();
});
afterAll(async () => env.database.close());

describe('field guidance', () => {
  it('finds the manual from a superseded number (follows the chain)', async () => {
    const g = await guidanceForPart(env.ctx(), { partNumber: 'acm 10021', make: 'ACM' });
    expect(g.part.partNumber).toBe('ACM-10044');
    expect(g.superseded).toBe(true);
    expect(g.coverage).toBe('licensed');
    expect(g.procedures.map((p) => p.code)).toEqual(['SB-AT-2026-04', 'WM-AT-02-04']);
    const oil = g.procedures.find((p) => p.code === 'WM-AT-02-04')!;
    expect(oil.steps.length).toBeGreaterThan(3);
    expect(oil.steps.some((s) => s.specs.some((sp) => sp.value.includes('DEMO')))).toBe(true);
    expect(oil.source.docRef).toBe('ACM-WM-AT-EN');
  });

  it('carries the fitting-change warning and finds the revised-part procedure', async () => {
    const g = await guidanceForPart(env.ctx(), { partNumber: 'NFB2210', make: 'NFB', serial: 'NFB12-88213' });
    expect(g.straightSwap).toBe(false);
    expect(g.warning).toMatch(/fitting/i);
    expect(g.procedures[0]!.parts.map((p) => p.partNumber)).toEqual(expect.arrayContaining(['NFB-2215', 'NFB-2216']));
  });

  it('respects licence purpose: AI-barred content is withheld from agents', async () => {
    const g = await guidanceForPart(env.ctx(), { partNumber: 'NFB-2215', make: 'NFB', purpose: 'ai' });
    expect(g.procedures).toHaveLength(0);
    expect(g.coverage).toBe('withheld');
    expect(g.withheld[0]!.reason).toMatch(/AI/);
  });

  it('issues an audited offline pack that excludes online-only content and expires with the shortest window', async () => {
    const ctx = env.ctx();
    const pack = await issueJobPack(ctx, { serial: 'ACM165-K004417', parts: [{ partNumber: 'ACM-10044' }, { partNumber: 'ACM-41870' }], jobRef: 'T-1' });
    expect(pack.packRef).toMatch(/^GP-\d{6}$/);
    expect(pack.procedures.map((p) => p.code)).toEqual(['WM-AT-02-04', 'WM-AT-07-03']);
    expect(pack.onlineOnly.map((p) => p.code)).toEqual(['SB-AT-2026-04']);
    const days = (pack.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(13.9);
    expect(days).toBeLessThanOrEqual(14);
    const audits = await ctx.db.select().from(auditLog).where(eq(auditLog.action, 'guidance.pack_issued'));
    expect(audits.some((a) => a.data.packRef === pack.packRef)).toBe(true);
    expect((await packStatus(ctx, pack.packRef)).valid).toBe(true);
  });

  it('hides content once its licence has expired', async () => {
    const ctx = env.ctx();
    await ctx.db.update(contentLicences).set({ expiresOn: '2020-01-01' }).where(eq(contentLicences.reference, 'DEMO-DH-01'));
    const g = await guidanceForPart(ctx, { partNumber: 'DH-10442', make: 'DH' });
    expect(g.procedures).toHaveLength(0);
    expect(g.withheld[0]!.reason).toMatch(/expired/);
    const m = await machineDetail(ctx, 'FM55-20219');
    expect(m.fittedParts.every((p) => !p.hasGuidance)).toBe(true);
  });

  it('needs the guidance scope', async () => {
    await expect(searchMachines(env.ctx(['parts:read']), 'hill')).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await searchMachines(env.ctx(['guidance:read']), 'hill')).length).toBeGreaterThan(0);
  });
});
