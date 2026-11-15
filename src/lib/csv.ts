/**
 * Small RFC 4180 CSV parser. Handles quoted fields, escaped quotes ("") and
 * embedded newlines; accepts LF or CRLF; strips a UTF-8 BOM. Synchronous and
 * in-memory: fine for files up to a few hundred thousand rows. Very large OEM
 * price files will move to a streaming parser (see docs/ROADMAP.md).
 */
export function parseCsv(input: string, delimiter = ','): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += ch;
      i++;
      continue;
    }
    if (ch === '"' && field.length === 0) {
      inQuotes = true;
      i++;
    } else if (ch === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (ch === '\r' || ch === '\n') {
      row.push(field);
      field = '';
      if (!(row.length === 1 && row[0] === '')) rows.push(row);
      row = [];
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += ch;
      i++;
    }
  }
  if (inQuotes) throw new Error('CSV parse error: unterminated quoted field');
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    if (!(row.length === 1 && row[0] === '')) rows.push(row);
  }
  return rows;
}

export function toCsv(rows: (string | number | null | undefined)[][], delimiter = ','): string {
  const esc = (v: string | number | null | undefined) => {
    const s = v == null ? '' : String(v);
    return /["\r\n]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(delimiter)).join('\r\n') + '\r\n';
}
