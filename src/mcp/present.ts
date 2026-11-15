import { formatGBP } from '../lib/money.js';

/**
 * Shape service results for a language model: money as "£12.34" strings
 * instead of integer pence (models misplace decimal points), basis points as
 * percentages, dates as ISO strings, no internal UUIDs unless useful.
 */
export function present(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(present);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === 'tenantId') continue;
      if (/Pence$/.test(k) && typeof v === 'number') out[k.replace(/Pence$/, '')] = formatGBP(v);
      else if (/Bps$/.test(k) && typeof v === 'number') out[k.replace(/Bps$/, 'Pct')] = `${(v / 100).toFixed(2)}%`;
      else out[k] = present(v);
    }
    return out;
  }
  return value;
}
