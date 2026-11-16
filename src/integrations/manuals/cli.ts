/**
 * Pilot operations: ingest a licensed manual through the API.
 *
 *   AGRIPARTS_URL=http://localhost:3100 AGRIPARTS_KEY=ap_... \
 *   npm run manuals:ingest -- --pdf ./manual.pdf --licence <uuid> --make MCC \
 *     --kind operator_manual --title "PA-series hedgecutter operator manual" --doc-ref MCC-OM-PA \
 *     [--revision "Ed 4"] [--extract] [--pages 1-60] [--window 15]
 *
 * Page text is read locally (unpdf). With --extract, Claude runs locally too
 * (ANTHROPIC_API_KEY on the operator's machine) and each window's result is
 * submitted to the API, where the deterministic checks run and drafts land in
 * the foreman's review queue. Nothing is published by this script.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { extractWindow, pageWindows } from './extract.js';
import { pdfPageTexts } from './pdf-text.js';

const { values: a } = parseArgs({
  options: {
    pdf: { type: 'string' }, licence: { type: 'string' }, make: { type: 'string' }, kind: { type: 'string', default: 'workshop_manual' },
    title: { type: 'string' }, 'doc-ref': { type: 'string' }, revision: { type: 'string' }, 'source-url': { type: 'string' },
    extract: { type: 'boolean', default: false }, pages: { type: 'string' }, window: { type: 'string', default: '15' },
  },
});

const base = process.env.AGRIPARTS_URL ?? 'http://localhost:3100';
const key = process.env.AGRIPARTS_KEY;
function need(v: string | undefined, name: string): string {
  if (!v) { console.error(`Missing ${name}`); process.exit(2); }
  return v;
}
need(key, 'AGRIPARTS_KEY env var');
const pdfPath = need(a.pdf, '--pdf');

async function api<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(`${base}${url}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status}: ${JSON.stringify(json).slice(0, 500)}`);
  return json as T;
}

const pdf = new Uint8Array(await readFile(pdfPath));
console.log(`Reading text layer of ${path.basename(pdfPath)} (${(pdf.length / 1048576).toFixed(1)} MB)...`);
const pages = await pdfPageTexts(pdf);
const blank = pages.filter((p) => !p.text.trim()).length;
console.log(`  ${pages.length} pages${blank ? `, ${blank} without text (scanned? needs OCR)` : ''}`);

const reg = await api<{ document: { id: string; docRef: string }; duplicate: boolean; pages: number }>('POST', '/v1/documents', {
  meta: {
    licenceId: need(a.licence, '--licence'), make: need(a.make, '--make'), kind: a.kind, title: need(a.title, '--title'), docRef: need(a['doc-ref'], '--doc-ref'),
    ...(a.revision ? { revision: a.revision } : {}), ...(a['source-url'] ? { sourceUrl: a['source-url'] } : {}),
  },
  pdfBase64: Buffer.from(pdf).toString('base64'),
  pages,
});
console.log(`${reg.duplicate ? 'Already registered' : 'Registered'}: ${reg.document.docRef} (${reg.document.id})`);
if (reg.duplicate) {
  await api('PUT', `/v1/documents/${reg.document.id}/pages`, { pages });
  console.log('  page text refreshed');
}

if (a.extract) {
  let [from, to] = [1, pages.length];
  if (a.pages) {
    const m = /^(\d+)-(\d+)$/.exec(a.pages);
    if (!m) { console.error('--pages must look like 1-60'); process.exit(2); }
    [from, to] = [Number(m[1]), Math.min(pages.length, Number(m[2]))];
  }
  const windows = pageWindows(to - from + 1, Number(a.window)).map((w) => ({ from: w.from + from - 1, to: w.to + from - 1 }));
  let totals = { inReview: 0, draft: 0, skipped: 0, inTok: 0, outTok: 0, cacheTok: 0 };
  for (const w of windows) {
    process.stdout.write(`Extracting pages ${w.from}-${w.to}... `);
    try {
      const r = await extractWindow({ pdf, docTitle: a.title!, make: a.make!.toUpperCase(), pageFrom: w.from, pageTo: w.to });
      const s = await api<{ procedures: number; inReview: number; draft: number; skipped: number }>('POST', `/v1/documents/${reg.document.id}/extractions`, { extraction: r.extraction, run: r.run });
      console.log(`${s.procedures} procedure(s): ${s.inReview} ready for review, ${s.draft} need fixes, ${s.skipped} skipped`);
      totals = { inReview: totals.inReview + s.inReview, draft: totals.draft + s.draft, skipped: totals.skipped + s.skipped, inTok: totals.inTok + (r.run.inputTokens ?? 0), outTok: totals.outTok + (r.run.outputTokens ?? 0), cacheTok: totals.cacheTok + (r.run.cacheReadTokens ?? 0) };
    } catch (e) {
      console.log(`FAILED: ${(e as Error).message}`);
    }
  }
  // claude-opus-5-5 list prices: $4/M input, $20/M output, cache reads at 10% of input.
  const usd = (totals.inTok * 4 + totals.cacheTok * 0.4 + totals.outTok * 20) / 1e6;
  console.log(`\nDone. ${totals.inReview} ready for the foreman, ${totals.draft} need fixing first, ${totals.skipped} already live.`);
  console.log(`Tokens: ${totals.inTok} in, ${totals.cacheTok} cache-read, ${totals.outTok} out (~$${usd.toFixed(2)} at list price).`);
}
