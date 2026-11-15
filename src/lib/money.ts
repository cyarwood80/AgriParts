/** All money is integer pence. All rates are integer basis points (10000 = 100%). */

export const VAT_RATES_BPS: Record<string, number> = {
  S: 2000, // UK standard rate 20%
  R: 500, // reduced rate 5%
  Z: 0, // zero rated
  E: 0, // exempt
};

export function vatRateFor(code: string): number {
  const rate = VAT_RATES_BPS[code];
  if (rate === undefined) throw new Error(`Unknown VAT code ${code}`);
  return rate;
}

/** Round half away from zero; amounts here are non-negative so this is round-half-up. */
export function applyBps(pence: number, bps: number): number {
  return Math.round((pence * bps) / 10_000);
}

export function discount(pence: number, discountBps: number): number {
  return pence - applyBps(pence, discountBps);
}

export function formatGBP(pence: number): string {
  const sign = pence < 0 ? '-' : '';
  const abs = Math.abs(pence);
  return `${sign}£${Math.floor(abs / 100).toLocaleString('en-GB')}.${String(abs % 100).padStart(2, '0')}`;
}

/** Parse "12.34", "£1,234.5", "1234" (pounds) into pence. Returns null for blank/invalid. */
export function parsePounds(input: string): number | null {
  const s = input.replace(/[£,\s]/g, '');
  if (!/^-?\d+(\.\d{1,4})?$/.test(s)) return null;
  return Math.round(Number(s) * 100);
}
