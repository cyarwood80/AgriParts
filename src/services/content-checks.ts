/**
 * Deterministic checks on extracted procedures (ADR-0004 §3, ADR-0005 §5).
 * Code, not AI. Any `error` blocks publication; `warn` is shown to the
 * reviewer but doesn't block.
 *
 * The verbatim rule: a spec value must appear on its cited page's text layer
 * exactly as written. Only presentation noise is normalised (runs of
 * whitespace, dash and minus variants, non-breaking spaces, typographic quotes).
 * Case, digits, decimal separators and units are compared exactly.
 */
import type { CheckIssue, CheckReport, ProcedureSpec } from '../db/schema.js';
import { normalisePartNumber } from '../lib/part-number.js';

export const ALLOWED_UNITS = new Set([
  'Nm', 'N·m', 'N m', 'lbf ft', 'lbf·ft', 'lb ft', 'ft lb', 'ft-lb', 'lb-ft', 'kgf m', 'kgf·m', 'daNm',
  'bar', 'psi', 'kPa', 'MPa', 'kgf/cm²',
  'L', 'l', 'litre', 'litres', 'liter', 'liters', 'ml', 'mL', 'cc', 'gal', 'US gal', 'qt', 'pt',
  'mm', 'cm', 'm', 'in', 'µm', 'thou',
  '°C', '°F', 'rpm', 'r/min', 'kg', 'g', 'N', 'kN', 'V', 'A', 'Ω', 'ohm', 'W', 'kW', 'hp',
  '%', 'h', 'hours', 'min', 's', 'L/min', 'l/min', 'km/h', 'mph',
]);

export function normaliseForVerbatim(s: string): string {
  return s
    .replace(/[‐-―−﹣－]/g, '-')
    .replace(/[     ]/g, ' ')
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”‟]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** True when `value` appears on the page, verbatim modulo presentation noise. */
export function appearsVerbatim(value: string, pageText: string): boolean {
  const v = normaliseForVerbatim(value);
  if (!v) return false;
  const page = normaliseForVerbatim(pageText);
  if (page.includes(v)) return true;
  // PDF text layers often drop the space between number and unit ("120Nm").
  return page.replace(/ /g, '').includes(v.replace(/ /g, ''));
}

export interface CheckableStep {
  seq: number;
  instruction: string;
  page: number | null;
  specs: ProcedureSpec[];
}
export interface CheckableProcedure {
  pageFrom: number | null;
  pageTo: number | null;
  steps: CheckableStep[];
  parts: { make: string; partNumber: string }[];
}

/**
 * @param pages   page number -> text layer, for the whole document
 * @param known   "MAKE|NORM" keys present in the parts master (unknown = warning)
 */
export function checkProcedure(p: CheckableProcedure, pages: Map<number, string>, known: Set<string>): CheckReport {
  const issues: CheckIssue[] = [];
  const err = (code: string, message: string, stepSeq?: number) => issues.push({ severity: 'error', code, message, ...(stepSeq !== undefined ? { stepSeq } : {}) });
  const warn = (code: string, message: string, stepSeq?: number) => issues.push({ severity: 'warn', code, message, ...(stepSeq !== undefined ? { stepSeq } : {}) });

  if (!pages.size) err('NO_PAGES', 'Document has no page text: paginate it before checking');
  if (!p.steps.length) err('NO_STEPS', 'Procedure has no steps');
  for (const pg of [p.pageFrom, p.pageTo]) {
    if (pg != null && pages.size && !pages.has(pg)) err('PAGE_MISSING', `Procedure cites page ${pg}, which is not in the document`);
  }
  if (p.pageFrom != null && p.pageTo != null && p.pageTo < p.pageFrom) err('PAGE_RANGE', `Page range ${p.pageFrom}-${p.pageTo} is backwards`);

  const seqs = new Set<number>();
  for (const s of p.steps) {
    if (seqs.has(s.seq)) err('DUP_STEP', `Step ${s.seq} appears twice`, s.seq);
    seqs.add(s.seq);
    if (!s.instruction.trim()) err('EMPTY_STEP', 'Step has no instruction', s.seq);
    if (s.page == null) {
      err('STEP_NO_PAGE', 'Step has no page reference', s.seq);
      continue;
    }
    const text = pages.get(s.page);
    if (text === undefined) {
      if (pages.size) err('PAGE_MISSING', `Step cites page ${s.page}, which is not in the document`, s.seq);
      continue;
    }
    for (const spec of s.specs) {
      if (!spec.value.trim()) {
        err('SPEC_EMPTY', `Spec "${spec.label}" has no value`, s.seq);
        continue;
      }
      if (!appearsVerbatim(spec.value, text)) {
        err('SPEC_NOT_VERBATIM', `"${spec.label}: ${spec.value}" does not appear on page ${s.page}`, s.seq);
      }
      if (spec.unit && !ALLOWED_UNITS.has(spec.unit.trim())) warn('UNIT_UNKNOWN', `Unit "${spec.unit}" is not on the allowed list`, s.seq);
      if (!/\d/.test(spec.value)) warn('SPEC_NO_NUMBER', `Spec "${spec.label}: ${spec.value}" has no number`, s.seq);
    }
  }

  for (const part of p.parts) {
    const norm = normalisePartNumber(part.partNumber);
    if (!norm) err('PART_EMPTY', 'Empty part number');
    else if (!known.has(`${part.make.toUpperCase()}|${norm}`)) warn('PART_UNKNOWN', `${part.make} ${part.partNumber} is not in the parts master`);
  }

  return { ok: !issues.some((i) => i.severity === 'error'), checkedAt: new Date().toISOString(), issues };
}
