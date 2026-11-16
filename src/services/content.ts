/**
 * Field-guide content pipeline (ADR-0004 §3, ADR-0005 §4-5):
 *
 *   register document -> store pages -> submit extraction -> deterministic
 *   check -> foreman review -> published
 *
 * Rules
 *  - No licence, no document. A manufacturer or OEM licence must carry a
 *    permission reference (the signed letter or consent email).
 *  - Specs must appear verbatim on the cited page (content-checks.ts). A
 *    procedure with check errors cannot be approved: fix the step instead.
 *  - Only `published` procedures reach engineers, packs and agents
 *    (enforced in guidance.ts). Editing a published procedure takes it back
 *    to review.
 *  - Every transition is audited; reviews are append-only.
 */
import { createHash } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  contentFlags, contentLicences, contentReviews, documentLinks, documentPages, extractionRuns, machineModels, parts,
  procedureParts, procedureSteps, procedures, serviceDocuments, type CheckReport,
} from '../db/schema.js';
import { blobStore, docKey } from '../lib/blob-store.js';
import { AppError, notFound } from '../lib/errors.js';
import { normalisePartNumber } from '../lib/part-number.js';
import { checkProcedure } from './content-checks.js';
import { audit, type ServiceContext } from './context.js';

const sha256 = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const today = () => new Date().toISOString().slice(0, 10);

// ---------------------------------------------------------------- extraction schema

/**
 * What an extractor (Claude, or a person keying a dealer's own sheet) hands us.
 * Every field is required (nullable where optional) so the same schema works
 * as a Claude structured-output format.
 */
export const ExtractedSpecSchema = z.object({
  label: z.string().describe('What the value is, e.g. "Drain plug torque"'),
  value: z.string().describe('The value EXACTLY as printed on the page, including its unit if printed together, e.g. "45 Nm"'),
  unit: z.string().nullable().describe('Unit if printed separately from the value, else null'),
});
export const ExtractedStepSchema = z.object({
  instruction: z.string().describe('The step, in the manual\'s own words where possible'),
  page: z.number().int().describe('PDF page number (1-based) the step is printed on'),
  specs: z.array(ExtractedSpecSchema),
  caution: z.string().nullable().describe('Any warning or caution printed with this step, verbatim'),
});
export const ExtractedProcedureSchema = z.object({
  code: z.string().nullable().describe('The manual\'s section or procedure number, if printed'),
  title: z.string(),
  summary: z.string().nullable(),
  model: z.string().nullable().describe('Machine model this procedure is specific to, or null if it covers every model in the document'),
  pageFrom: z.number().int(),
  pageTo: z.number().int(),
  skill: z.enum(['basic', 'competent', 'specialist']),
  estMinutes: z.number().int().nullable(),
  tools: z.array(z.string()),
  safety: z.array(z.string()).describe('Safety instructions printed for the whole procedure, verbatim'),
  steps: z.array(ExtractedStepSchema),
  parts: z.array(z.object({
    partNumber: z.string().describe('Part number exactly as printed'),
    role: z.enum(['replaced', 'consumable', 'may_need']),
    qty: z.number().int(),
  })),
});
export const ExtractedDocumentSchema = z.object({
  models: z.array(z.string()).describe('Machine models the document covers'),
  procedures: z.array(ExtractedProcedureSchema),
});
export type ExtractedDocument = z.infer<typeof ExtractedDocumentSchema>;

// ---------------------------------------------------------------- documents

export const RegisterDocumentSchema = z.object({
  licenceId: z.string().uuid(),
  make: z.string().min(1).max(20),
  kind: z.enum(['workshop_manual', 'operator_manual', 'parts_book', 'service_bulletin', 'dealer_procedure']),
  title: z.string().min(1).max(300),
  docRef: z.string().min(1).max(100),
  revision: z.string().max(50).optional(),
  publishedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sourceUrl: z.string().url().optional(),
  language: z.string().min(2).max(10).default('en'),
});
export type RegisterDocumentInput = z.input<typeof RegisterDocumentSchema>;

export interface PageInput {
  page: number;
  text: string;
  label?: string | null | undefined;
}

async function loadLicence(ctx: ServiceContext, licenceId: string) {
  const [l] = await ctx.db.select().from(contentLicences).where(and(eq(contentLicences.tenantId, ctx.tenantId), eq(contentLicences.id, licenceId)));
  if (!l) throw notFound('Licence', licenceId);
  return l;
}

async function loadDocument(ctx: ServiceContext, documentId: string) {
  const [row] = await ctx.db
    .select({ document: serviceDocuments, licence: contentLicences })
    .from(serviceDocuments)
    .innerJoin(contentLicences, eq(contentLicences.id, serviceDocuments.licenceId))
    .where(and(eq(serviceDocuments.tenantId, ctx.tenantId), eq(serviceDocuments.id, documentId)));
  if (!row) throw notFound('Document', documentId);
  return row;
}

/**
 * Register a licensed document and store its PDF. Re-registering the same
 * file (same sha256) returns the existing document. Pages may be supplied
 * (e.g. by the CLI, which extracts them) or stored later with storePages().
 */
export async function registerDocument(
  ctx: ServiceContext,
  input: { meta: RegisterDocumentInput; pdf?: Uint8Array | undefined; pages?: PageInput[] | undefined },
) {
  ctx.require('content:write');
  const meta = RegisterDocumentSchema.parse(input.meta);
  const licence = await loadLicence(ctx, meta.licenceId);
  if (licence.kind !== 'dealer_owned' && !licence.permissionRef) {
    throw new AppError('VALIDATION', `Licence "${licence.title}" has no permission reference. Record where the signed licence or consent lives before adding documents under it.`);
  }
  if (licence.kind === 'link_only') throw new AppError('VALIDATION', 'A link-only licence cannot hold documents. Add a portal link instead.');
  if (licence.expiresOn && licence.expiresOn < today()) throw new AppError('VALIDATION', `Licence "${licence.title}" expired ${licence.expiresOn}`);

  const fileSha = input.pdf ? sha256(input.pdf) : null;
  if (fileSha) {
    const [dup] = await ctx.db.select().from(serviceDocuments).where(and(eq(serviceDocuments.tenantId, ctx.tenantId), eq(serviceDocuments.fileSha256, fileSha)));
    if (dup) return { document: dup, duplicate: true, pages: dup.pageCount ?? 0 };
  }

  const [doc] = await ctx.db
    .insert(serviceDocuments)
    .values({
      tenantId: ctx.tenantId, licenceId: licence.id, make: meta.make.toUpperCase(), kind: meta.kind, title: meta.title, docRef: meta.docRef,
      revision: meta.revision ?? null, publishedOn: meta.publishedOn ?? null, sourceUrl: meta.sourceUrl ?? null, language: meta.language,
      fileSha256: fileSha, status: 'uploaded',
    })
    .returning();
  // Outside any transaction: blob writes are network calls in production.
  if (input.pdf) {
    const key = docKey(ctx.tenantId, doc!.id);
    await blobStore().put(key, input.pdf, 'application/pdf');
    await ctx.db.update(serviceDocuments).set({ fileKey: key }).where(eq(serviceDocuments.id, doc!.id));
    doc!.fileKey = key;
  }
  await audit(ctx, 'content.document_registered', 'service_document', doc!.id, { docRef: meta.docRef, licence: licence.reference, sha256: fileSha });
  let pageCount = 0;
  if (input.pages?.length) pageCount = (await storePages(ctx, doc!.id, input.pages)).pages;
  return { document: { ...doc!, pageCount }, duplicate: false, pages: pageCount };
}

/** Replace a document's page text. Pages are the ground truth for the verbatim check. */
export async function storePages(ctx: ServiceContext, documentId: string, pages: PageInput[]) {
  ctx.require('content:write');
  await loadDocument(ctx, documentId);
  const seen = new Set<number>();
  for (const p of pages) {
    if (!Number.isInteger(p.page) || p.page < 1) throw new AppError('VALIDATION', `Bad page number ${p.page}`);
    if (seen.has(p.page)) throw new AppError('VALIDATION', `Page ${p.page} supplied twice`);
    seen.add(p.page);
  }
  const blank = pages.filter((p) => !p.text.trim()).length;
  return ctx.transaction(async (tx) => {
    await tx.db.delete(documentPages).where(eq(documentPages.documentId, documentId));
    for (let i = 0; i < pages.length; i += 200) {
      await tx.db.insert(documentPages).values(
        pages.slice(i, i + 200).map((p) => ({ tenantId: tx.tenantId, documentId, page: p.page, label: p.label ?? null, text: p.text, textSha256: sha256(p.text) })),
      );
    }
    await tx.db.update(serviceDocuments).set({ pageCount: pages.length, status: 'paged' }).where(eq(serviceDocuments.id, documentId));
    await audit(tx, 'content.pages_stored', 'service_document', documentId, { pages: pages.length, blank });
    return { pages: pages.length, blank, warning: blank ? `${blank} page(s) have no text layer (scanned?). Specs on those pages can't pass the verbatim check without OCR.` : null };
  });
}

async function pageMap(ctx: ServiceContext, documentId: string) {
  const rows = await ctx.db.select({ page: documentPages.page, text: documentPages.text }).from(documentPages).where(eq(documentPages.documentId, documentId));
  return new Map(rows.map((r) => [r.page, r.text]));
}

async function knownParts(ctx: ServiceContext, keys: { make: string; partNumber: string }[]) {
  const norms = [...new Set(keys.map((k) => normalisePartNumber(k.partNumber)).filter(Boolean))];
  if (!norms.length) return new Set<string>();
  const rows = await ctx.db.select({ make: parts.make, norm: parts.partNumberNorm }).from(parts).where(and(eq(parts.tenantId, ctx.tenantId), inArray(parts.partNumberNorm, norms)));
  return new Set(rows.map((r) => `${r.make}|${r.norm}`));
}

// ---------------------------------------------------------------- extraction

export interface ExtractionRunInfo {
  model: string;
  mode: 'sync' | 'batch' | 'import';
  pageFrom?: number | null | undefined;
  pageTo?: number | null | undefined;
  inputTokens?: number | null | undefined;
  outputTokens?: number | null | undefined;
  cacheReadTokens?: number | null | undefined;
}

/**
 * Turn an extraction into draft procedures, each with its deterministic check
 * report. Passing procedures go to `in_review`; failing ones stay `draft`.
 * A procedure code already published for this document is left alone (withdraw
 * or edit it instead) so re-extraction can never silently replace live content.
 */
export async function submitExtraction(
  ctx: ServiceContext,
  input: { documentId: string; extraction: ExtractedDocument; run?: ExtractionRunInfo | undefined },
) {
  ctx.require('content:write');
  const extraction = ExtractedDocumentSchema.parse(input.extraction);
  const { document } = await loadDocument(ctx, input.documentId);
  const pages = await pageMap(ctx, document.id);
  const allParts = extraction.procedures.flatMap((p) => p.parts.map((x) => ({ make: document.make, partNumber: x.partNumber })));
  const known = await knownParts(ctx, allParts);
  const models = await ctx.db.select().from(machineModels).where(and(eq(machineModels.tenantId, ctx.tenantId), eq(machineModels.make, document.make)));
  const modelByName = new Map(models.map((m) => [m.model.toUpperCase().replace(/\s+/g, ''), m]));
  const run = input.run ?? { model: 'external', mode: 'import' as const };

  return ctx.transaction(async (tx) => {
    const [runRow] = await tx.db
      .insert(extractionRuns)
      .values({
        tenantId: tx.tenantId, documentId: document.id, model: run.model, mode: run.mode, pageFrom: run.pageFrom ?? null, pageTo: run.pageTo ?? null,
        status: 'succeeded', inputTokens: run.inputTokens ?? null, outputTokens: run.outputTokens ?? null, cacheReadTokens: run.cacheReadTokens ?? null,
        output: extraction, actor: tx.actorLabel, finishedAt: new Date(),
      })
      .returning();
    const existing = await tx.db.select().from(procedures).where(eq(procedures.documentId, document.id));
    const byCode = new Map(existing.map((p) => [p.code, p]));
    const results: { code: string; title: string; status: string; check: CheckReport; note?: string }[] = [];

    for (const [i, p] of extraction.procedures.entries()) {
      const code = (p.code?.trim() || `${document.docRef}-P${String(i + 1).padStart(3, '0')}`).slice(0, 60);
      const steps = p.steps.map((s, j) => ({ seq: j + 1, instruction: s.instruction, page: s.page, specs: s.specs.map((x) => ({ label: x.label, value: x.value, ...(x.unit ? { unit: x.unit } : {}) })), caution: s.caution }));
      const partRows = dedupeParts(p.parts.map((x) => ({ make: document.make, partNumber: x.partNumber, role: x.role, qty: Math.max(1, x.qty) })));
      const check = checkProcedure({ pageFrom: p.pageFrom, pageTo: p.pageTo, steps, parts: partRows }, pages, known);
      const model = p.model ? modelByName.get(p.model.toUpperCase().replace(/\s+/g, '')) : undefined;
      if (p.model && !model) check.issues.push({ severity: 'warn', code: 'MODEL_UNKNOWN', message: `Model "${p.model}" isn't in the machine register for ${document.make}; procedure will apply to all models in the document until set` });
      const status = check.ok ? 'in_review' : 'draft';
      const prior = byCode.get(code);
      if (prior?.status === 'published') {
        results.push({ code, title: p.title, status: 'skipped', check, note: 'Already published: withdraw or edit the live procedure instead' });
        continue;
      }
      const values = {
        machineModelId: model?.id ?? null, title: p.title, summary: p.summary, estMinutes: p.estMinutes, skill: p.skill,
        pageFrom: p.pageFrom, pageTo: p.pageTo, tools: p.tools, safety: p.safety, status, origin: 'extracted',
        extractionRunId: runRow!.id, checkReport: check, verifiedBy: null, verifiedAt: null, updatedAt: new Date(),
      };
      let procId: string;
      if (prior) {
        await tx.db.update(procedures).set({ ...values, version: prior.version + 1 }).where(eq(procedures.id, prior.id));
        await tx.db.delete(procedureSteps).where(eq(procedureSteps.procedureId, prior.id));
        await tx.db.delete(procedureParts).where(eq(procedureParts.procedureId, prior.id));
        procId = prior.id;
      } else {
        const [row] = await tx.db.insert(procedures).values({ ...values, tenantId: tx.tenantId, documentId: document.id, code }).returning();
        procId = row!.id;
      }
      if (steps.length) await tx.db.insert(procedureSteps).values(steps.map((s) => ({ ...s, tenantId: tx.tenantId, procedureId: procId })));
      if (partRows.length) {
        await tx.db.insert(procedureParts).values(partRows.map((x) => ({ tenantId: tx.tenantId, procedureId: procId, make: x.make, partNumberNorm: normalisePartNumber(x.partNumber), role: x.role, qty: x.qty })));
      }
      results.push({ code, title: p.title, status, check });
    }

    await tx.db.update(serviceDocuments).set({ status: document.status === 'live' ? 'live' : 'in_review' }).where(eq(serviceDocuments.id, document.id));
    const summary = {
      procedures: results.length,
      inReview: results.filter((r) => r.status === 'in_review').length,
      draft: results.filter((r) => r.status === 'draft').length,
      skipped: results.filter((r) => r.status === 'skipped').length,
    };
    await audit(tx, 'content.extraction_submitted', 'extraction_run', runRow!.id, { documentId: document.id, model: run.model, ...summary });
    return { extractionRunId: runRow!.id, ...summary, results };
  });
}

function dedupeParts<T extends { make: string; partNumber: string; qty: number }>(rows: T[]): T[] {
  const m = new Map<string, T>();
  for (const r of rows) {
    const k = `${r.make}|${normalisePartNumber(r.partNumber)}`;
    const prev = m.get(k);
    if (prev) prev.qty += r.qty;
    else m.set(k, { ...r });
  }
  return [...m.values()];
}

// ---------------------------------------------------------------- review

async function loadProcedure(ctx: ServiceContext, procedureId: string) {
  const [p] = await ctx.db.select().from(procedures).where(and(eq(procedures.tenantId, ctx.tenantId), eq(procedures.id, procedureId)));
  if (!p) throw notFound('Procedure', procedureId);
  return p;
}

/** Re-run the deterministic checks from what's stored now. */
export async function recheckProcedure(ctx: ServiceContext, procedureId: string): Promise<CheckReport> {
  const p = await loadProcedure(ctx, procedureId);
  const doc = await loadDocument(ctx, p.documentId);
  const steps = await ctx.db.select().from(procedureSteps).where(eq(procedureSteps.procedureId, p.id)).orderBy(asc(procedureSteps.seq));
  const pp = await ctx.db.select().from(procedureParts).where(eq(procedureParts.procedureId, p.id));
  const partRefs = pp.map((x) => ({ make: x.make, partNumber: x.partNumberNorm }));
  const report = checkProcedure({ pageFrom: p.pageFrom, pageTo: p.pageTo, steps, parts: partRefs }, await pageMap(ctx, doc.document.id), await knownParts(ctx, partRefs));
  await ctx.db.update(procedures).set({ checkReport: report }).where(eq(procedures.id, p.id));
  return report;
}

/** What the foreman needs to look at: drafts, procedures awaiting review, and live ones with open flags. */
export async function reviewQueue(ctx: ServiceContext, limit = 50) {
  ctx.require('content:write');
  const flags = await ctx.db
    .select({ procedureId: contentFlags.procedureId, open: count() })
    .from(contentFlags)
    .where(and(eq(contentFlags.tenantId, ctx.tenantId), eq(contentFlags.status, 'open')))
    .groupBy(contentFlags.procedureId);
  const flagged = new Map(flags.map((f) => [f.procedureId, Number(f.open)]));
  const rows = await ctx.db
    .select({ p: procedures, docRef: serviceDocuments.docRef, docTitle: serviceDocuments.title, make: serviceDocuments.make })
    .from(procedures)
    .innerJoin(serviceDocuments, eq(serviceDocuments.id, procedures.documentId))
    .where(and(eq(procedures.tenantId, ctx.tenantId), sql`(${procedures.status} IN ('draft', 'in_review') OR ${procedures.id} IN ${flagged.size ? [...flagged.keys()] : ['00000000-0000-0000-0000-000000000000']})`))
    .orderBy(desc(procedures.status), asc(procedures.updatedAt))
    .limit(Math.min(limit, 200));
  return rows.map(({ p, docRef, docTitle, make }) => ({
    id: p.id, code: p.code, title: p.title, status: p.status, version: p.version, make, docRef, document: docTitle,
    pages: p.pageFrom ? `${p.pageFrom}${p.pageTo && p.pageTo !== p.pageFrom ? `-${p.pageTo}` : ''}` : null,
    checkOk: p.checkReport?.ok ?? null,
    errors: p.checkReport?.issues.filter((i) => i.severity === 'error').length ?? 0,
    warnings: p.checkReport?.issues.filter((i) => i.severity === 'warn').length ?? 0,
    openFlags: flagged.get(p.id) ?? 0,
  }));
}

/**
 * Everything the foreman needs on one screen: the steps, the check report,
 * the text of every cited page (to read side by side), open flags and the
 * review history.
 */
export async function reviewDetail(ctx: ServiceContext, procedureId: string) {
  ctx.require('content:write');
  const p = await loadProcedure(ctx, procedureId);
  const { document, licence } = await loadDocument(ctx, p.documentId);
  const steps = await ctx.db.select().from(procedureSteps).where(eq(procedureSteps.procedureId, p.id)).orderBy(asc(procedureSteps.seq));
  const pp = await ctx.db.select().from(procedureParts).where(eq(procedureParts.procedureId, p.id));
  const cited = new Set<number>();
  for (const s of steps) if (s.page != null) cited.add(s.page);
  if (p.pageFrom != null) for (let n = p.pageFrom; n <= (p.pageTo ?? p.pageFrom) && n - p.pageFrom < 50; n++) cited.add(n);
  const pages = cited.size
    ? await ctx.db
        .select({ page: documentPages.page, label: documentPages.label, text: documentPages.text })
        .from(documentPages)
        .where(and(eq(documentPages.documentId, document.id), inArray(documentPages.page, [...cited])))
        .orderBy(asc(documentPages.page))
    : [];
  const flags = await ctx.db.select().from(contentFlags).where(eq(contentFlags.procedureId, p.id)).orderBy(desc(contentFlags.createdAt)).limit(50);
  const history = await ctx.db.select().from(contentReviews).where(eq(contentReviews.procedureId, p.id)).orderBy(desc(contentReviews.at)).limit(50);
  return {
    id: p.id, code: p.code, title: p.title, summary: p.summary, status: p.status, origin: p.origin, version: p.version,
    pageFrom: p.pageFrom, pageTo: p.pageTo, tools: p.tools, safety: p.safety,
    verifiedBy: p.verifiedBy, verifiedAt: p.verifiedAt, updatedAt: p.updatedAt,
    check: p.checkReport,
    document: { id: document.id, make: document.make, title: document.title, docRef: document.docRef, revision: document.revision, pageCount: document.pageCount, hasFile: Boolean(document.fileKey) },
    licence: { title: licence.title, publisher: licence.publisher, kind: licence.kind, reference: licence.reference, expiresOn: licence.expiresOn },
    steps: steps.map((s) => ({ seq: s.seq, instruction: s.instruction, page: s.page, specs: s.specs, caution: s.caution })),
    parts: pp.map((x) => ({ make: x.make, partNumber: x.partNumberNorm, role: x.role, qty: x.qty })),
    pages,
    flags: flags.map((f) => ({ id: f.id, stepSeq: f.stepSeq, flaggedBy: f.flaggedBy, message: f.message, status: f.status, resolution: f.resolution, createdAt: f.createdAt, resolvedAt: f.resolvedAt })),
    history: history.map((h) => ({ version: h.version, reviewer: h.reviewer, decision: h.decision, notes: h.notes, at: h.at })),
  };
}

export const StepEditSchema = z.object({
  instruction: z.string().min(1).optional(),
  page: z.number().int().min(1).optional(),
  specs: z.array(z.object({ label: z.string().min(1), value: z.string().min(1), unit: z.string().optional() })).optional(),
  caution: z.string().nullable().optional(),
});

/** Fix one step (usually after a check failure). Bumps the version and sends the procedure back to review. */
export async function editStep(ctx: ServiceContext, procedureId: string, seq: number, edit: z.input<typeof StepEditSchema>, notes?: string) {
  ctx.require('content:write');
  const e = StepEditSchema.parse(edit);
  const p = await loadProcedure(ctx, procedureId);
  if (p.status === 'withdrawn') throw new AppError('CONFLICT', 'Procedure is withdrawn');
  const [step] = await ctx.db.select().from(procedureSteps).where(and(eq(procedureSteps.procedureId, p.id), eq(procedureSteps.seq, seq)));
  if (!step) throw notFound('Step', `${p.code} #${seq}`);
  const set: Partial<typeof procedureSteps.$inferInsert> = {};
  if (e.instruction !== undefined) set.instruction = e.instruction;
  if (e.page !== undefined) set.page = e.page;
  if (e.specs !== undefined) set.specs = e.specs;
  if (e.caution !== undefined) set.caution = e.caution;
  await ctx.db.update(procedureSteps).set(set).where(and(eq(procedureSteps.procedureId, p.id), eq(procedureSteps.seq, seq)));
  const report = await recheckProcedure(ctx, p.id);
  const version = p.version + 1;
  const status = report.ok ? 'in_review' : 'draft';
  await ctx.db.update(procedures).set({ version, status, verifiedBy: null, verifiedAt: null, updatedAt: new Date() }).where(eq(procedures.id, p.id));
  await ctx.db.insert(contentReviews).values({ tenantId: ctx.tenantId, procedureId: p.id, version, reviewer: ctx.actorLabel, decision: 'edit', notes: notes ?? `step ${seq} edited` });
  await audit(ctx, 'content.step_edited', 'procedure', p.id, { seq, before: { instruction: step.instruction, page: step.page, specs: step.specs }, after: set, wasPublished: p.status === 'published' });
  return { id: p.id, code: p.code, version, status, check: report };
}

/**
 * The foreman's decision. Approval re-runs the checks and refuses if any
 * error remains; it also resolves the procedure's open flags (re-verified).
 */
export async function reviewProcedure(ctx: ServiceContext, procedureId: string, input: { decision: 'approve' | 'reject' | 'withdraw'; notes?: string | undefined }) {
  ctx.require('content:review');
  const p = await loadProcedure(ctx, procedureId);
  if (input.decision === 'approve') {
    if (p.status === 'withdrawn') throw new AppError('CONFLICT', 'Withdrawn procedures must be re-extracted or edited before approval');
    const report = await recheckProcedure(ctx, p.id);
    if (!report.ok) {
      throw new AppError('VALIDATION', `Can't approve ${p.code}: ${report.issues.filter((i) => i.severity === 'error').length} check error(s). Fix the steps first.`, { issues: report.issues });
    }
    const { licence } = await loadDocument(ctx, p.documentId);
    if (licence.expiresOn && licence.expiresOn < today()) throw new AppError('VALIDATION', `Licence "${licence.title}" has expired`);
  }
  if ((input.decision === 'reject' || input.decision === 'withdraw') && !input.notes?.trim()) {
    throw new AppError('VALIDATION', 'Say why: rejection and withdrawal need a note');
  }
  const status = { approve: 'published', reject: 'rejected', withdraw: 'withdrawn' }[input.decision];
  return ctx.transaction(async (tx) => {
    await tx.db
      .update(procedures)
      .set({ status, updatedAt: new Date(), ...(input.decision === 'approve' ? { verifiedBy: tx.actorLabel, verifiedAt: new Date() } : {}) })
      .where(eq(procedures.id, p.id));
    await tx.db.insert(contentReviews).values({ tenantId: tx.tenantId, procedureId: p.id, version: p.version, reviewer: tx.actorLabel, decision: input.decision, notes: input.notes ?? null });
    let resolvedFlags = 0;
    if (input.decision === 'approve') {
      const r = await tx.db
        .update(contentFlags)
        .set({ status: 'resolved', resolution: input.notes ?? `re-verified v${p.version}`, resolvedAt: new Date() })
        .where(and(eq(contentFlags.procedureId, p.id), eq(contentFlags.status, 'open')))
        .returning({ id: contentFlags.id });
      resolvedFlags = r.length;
      await tx.db.update(serviceDocuments).set({ status: 'live' }).where(eq(serviceDocuments.id, p.documentId));
    }
    await audit(tx, `content.procedure_${status}`, 'procedure', p.id, { code: p.code, version: p.version, notes: input.notes, resolvedFlags });
    return { id: p.id, code: p.code, version: p.version, status, resolvedFlags };
  });
}

/** An engineer flags a step from the field. The procedure stays live but joins the review queue. */
export async function flagStep(ctx: ServiceContext, procedureId: string, input: { stepSeq?: number | undefined; message: string }) {
  ctx.require('guidance:read');
  const p = await loadProcedure(ctx, procedureId);
  if (p.status !== 'published') throw new AppError('CONFLICT', 'Only published procedures can be flagged');
  const msg = input.message.trim();
  if (msg.length < 5) throw new AppError('VALIDATION', 'Tell the workshop what\'s wrong (at least a few words)');
  const [f] = await ctx.db
    .insert(contentFlags)
    .values({ tenantId: ctx.tenantId, procedureId: p.id, stepSeq: input.stepSeq ?? null, flaggedBy: ctx.actorLabel, message: msg.slice(0, 2000) })
    .returning();
  await audit(ctx, 'content.step_flagged', 'procedure', p.id, { flagId: f!.id, stepSeq: input.stepSeq, message: msg.slice(0, 200) });
  return { flagId: f!.id, procedure: p.code, status: 'open' };
}

// ---------------------------------------------------------------- pages & files

/** One page of a licensed document: text layer and label. Licence must be live. */
export async function getPage(ctx: ServiceContext, documentId: string, page: number) {
  ctx.require('guidance:read');
  const { document, licence } = await loadDocument(ctx, documentId);
  if (licence.expiresOn && licence.expiresOn < today()) throw new AppError('FORBIDDEN', `Licence "${licence.title}" expired ${licence.expiresOn}`);
  if (document.status === 'withdrawn') throw new AppError('FORBIDDEN', 'Document withdrawn');
  const [row] = await ctx.db.select().from(documentPages).where(and(eq(documentPages.documentId, document.id), eq(documentPages.page, page)));
  if (!row) throw notFound('Page', `${document.docRef} p${page}`);
  return { docRef: document.docRef, title: document.title, revision: document.revision, page: row.page, label: row.label, text: row.text, pageCount: document.pageCount, hasFile: Boolean(document.fileKey) };
}

/** The source PDF, for the "show me the original" viewer. Licence must be live. */
export async function getDocumentFile(ctx: ServiceContext, documentId: string) {
  ctx.require('guidance:read');
  const { document, licence } = await loadDocument(ctx, documentId);
  if (licence.expiresOn && licence.expiresOn < today()) throw new AppError('FORBIDDEN', `Licence "${licence.title}" expired ${licence.expiresOn}`);
  if (!document.fileKey) throw notFound('File for document', document.docRef);
  const data = await blobStore().get(document.fileKey);
  if (!data) throw notFound('File for document', document.docRef);
  await audit(ctx, 'content.file_viewed', 'service_document', document.id, { docRef: document.docRef });
  return { data, filename: `${document.docRef.replace(/[^A-Za-z0-9._-]/g, '_')}.pdf` };
}

export async function listDocuments(ctx: ServiceContext) {
  ctx.require('guidance:read');
  const counts = await ctx.db
    .select({ documentId: procedures.documentId, status: procedures.status, n: count() })
    .from(procedures)
    .where(eq(procedures.tenantId, ctx.tenantId))
    .groupBy(procedures.documentId, procedures.status);
  const byDoc = new Map<string, Record<string, number>>();
  for (const c of counts) byDoc.set(c.documentId, { ...(byDoc.get(c.documentId) ?? {}), [c.status]: Number(c.n) });
  const docs = await ctx.db
    .select({ d: serviceDocuments, publisher: contentLicences.publisher, licenceKind: contentLicences.kind, expiresOn: contentLicences.expiresOn })
    .from(serviceDocuments)
    .innerJoin(contentLicences, eq(contentLicences.id, serviceDocuments.licenceId))
    .where(eq(serviceDocuments.tenantId, ctx.tenantId))
    .orderBy(asc(serviceDocuments.make), asc(serviceDocuments.docRef));
  return docs.map(({ d, publisher, licenceKind, expiresOn }) => ({
    id: d.id, make: d.make, kind: d.kind, title: d.title, docRef: d.docRef, revision: d.revision, status: d.status, pageCount: d.pageCount,
    hasFile: Boolean(d.fileKey), publisher, licenceKind, licenceExpires: expiresOn, procedures: byDoc.get(d.id) ?? {},
  }));
}

// ---------------------------------------------------------------- portal links

export const DocumentLinkSchema = z.object({
  make: z.string().min(1).max(20),
  model: z.string().optional(),
  partNumber: z.string().optional(),
  label: z.string().min(1).max(200),
  urlTemplate: z.string().url().refine((u) => u.startsWith('https://'), 'Portal links must be https'),
  portal: z.string().min(1).max(100),
});

export async function addDocumentLink(ctx: ServiceContext, input: z.input<typeof DocumentLinkSchema>) {
  ctx.require('content:write');
  const l = DocumentLinkSchema.parse(input);
  const make = l.make.toUpperCase();
  let machineModelId: string | null = null;
  if (l.model) {
    const [m] = await ctx.db.select().from(machineModels).where(and(eq(machineModels.tenantId, ctx.tenantId), eq(machineModels.make, make), eq(machineModels.model, l.model)));
    if (!m) throw notFound('Machine model', `${make} ${l.model}`);
    machineModelId = m.id;
  }
  const [row] = await ctx.db
    .insert(documentLinks)
    .values({ tenantId: ctx.tenantId, make, machineModelId, partNumberNorm: l.partNumber ? normalisePartNumber(l.partNumber) : null, label: l.label, urlTemplate: l.urlTemplate, portal: l.portal })
    .returning();
  await audit(ctx, 'content.link_added', 'document_link', row!.id, { make, portal: l.portal });
  return row!;
}

/** Portal deep links for a make, optionally narrowed by model and part, with placeholders filled. */
export async function linksFor(ctx: ServiceContext, q: { make: string; machineModelId?: string | undefined; partNumber?: string | undefined; serial?: string | undefined }) {
  ctx.require('guidance:read');
  const make = q.make.toUpperCase();
  const rows = await ctx.db.select().from(documentLinks).where(and(eq(documentLinks.tenantId, ctx.tenantId), eq(documentLinks.make, make)));
  const norm = q.partNumber ? normalisePartNumber(q.partNumber) : undefined;
  return rows
    .filter((r) => (!r.machineModelId || r.machineModelId === q.machineModelId) && (!r.partNumberNorm || r.partNumberNorm === norm))
    .map((r) => ({
      label: r.label,
      portal: r.portal,
      url: r.urlTemplate
        .replaceAll('{serial}', encodeURIComponent(q.serial ?? ''))
        .replaceAll('{partNumber}', encodeURIComponent(q.partNumber ?? '')),
    }));
}
