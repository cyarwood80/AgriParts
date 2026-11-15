// Part-number normalisation (ported unchanged in behaviour from AgriParts v1).
// Every brand prints numbers differently ("332/X5626", "332-X5626", "332 x5626").
// We store the raw form for display and a normalised key for matching. Keep this
// function boring and tested: every match in the system depends on it.

const CONFUSABLES: Record<string, string> = {
  '‐': '-', '‑': '-', '‒': '-', '–': '-', '—': '-', // dashes from Excel/PDF
  ' ': ' ', // non-breaking space
};

export function normalisePartNumber(raw: string): string {
  let s = raw.trim();
  for (const [bad, good] of Object.entries(CONFUSABLES)) s = s.split(bad).join(good);
  s = s.toUpperCase();
  // Excel turns all-digit part numbers into floats ("450112.0"). Undo that
  // before stripping dots. Leading zeros it ate cannot be recovered here:
  // read spreadsheets as text.
  s = s.replace(/^(\d+)\.0$/, '$1');
  // Strip separators that brands use cosmetically.
  s = s.replace(/[\s\-/._]/g, '');
  return s;
}

/** True when a raw string looks like a part number rather than a description. */
export function looksLikePartNumber(raw: string): boolean {
  const n = normalisePartNumber(raw);
  return n.length >= 4 && n.length <= 20 && /\d/.test(n) && !/\s{2,}/.test(raw) && raw.trim().split(/\s+/).length <= 2;
}
