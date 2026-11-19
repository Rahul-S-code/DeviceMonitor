// Minimal RFC 4180 CSV reader and writer (quoted fields, "" escapes, CRLF or LF,
// a UTF-8 byte-order mark from Excel). No dependencies.

export function parseCsv(text) {
  const s = String(text ?? '').replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && s[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw new Error('The CSV has a quote (") that is never closed');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

const cell = (v) => {
  const t = v === null || v === undefined ? '' : String(v);
  // Stop spreadsheet formula injection when the file is opened in Excel.
  const safe = /^[=+\-@\t\r]/.test(t) ? `'${t}` : t;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

export function toCsv(rows) {
  return rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}

/** Rows as objects keyed by normalised header ("Asset tag" -> "assettag"). */
export function csvObjects(text) {
  const [head, ...body] = parseCsv(text);
  if (!head) return { headers: [], records: [] };
  const headers = head.map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]/g, ''));
  return { headers, records: body.map((r, i) => ({ line: i + 2, values: Object.fromEntries(headers.map((h, j) => [h, (r[j] ?? '').trim()])) })) };
}
