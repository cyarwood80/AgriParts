// Small shared helpers: escaping templates, API client, formatting, storage.

class Raw {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
export const raw = (s) => new Raw(String(s));

const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function render(v) {
  if (v == null || v === false) return '';
  if (v instanceof Raw) return v.s;
  if (Array.isArray(v)) return v.map(render).join('');
  return esc(String(v));
}
/** Tagged template: interpolations are HTML-escaped unless built with html`` or raw(). */
export function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => { out += render(v) + strings[i + 1]; });
  return new Raw(out);
}

// ---- storage (never trusted to exist: private windows, blocked storage) ----
export const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem(k); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch { return false; }
  },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
};

// ---- API ------------------------------------------------------------------
export class ApiError extends Error {
  constructor(status, body) {
    super(body?.error?.message ?? `HTTP ${status}`);
    this.status = status;
    this.code = body?.error?.code;
    this.details = body?.error?.details;
  }
}

export function getKey() { return store.get('ap.key'); }
export function setKey(k) { store.set('ap.key', k); }

export async function api(path, opts = {}) {
  const headers = { Authorization: `Bearer ${getKey()}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.method === 'POST') headers['Idempotency-Key'] = crypto.randomUUID();
  let res;
  try {
    res = await fetch(`/v1${path}`, { method: opts.method ?? 'GET', headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  } catch {
    throw new ApiError(0, { error: { code: 'OFFLINE', message: 'No connection to AgriParts' } });
  }
  const body = res.headers.get('content-type')?.includes('json') ? await res.json() : null;
  if (!res.ok) throw new ApiError(res.status, body);
  return body;
}

export const qs = (o) => new URLSearchParams(Object.entries(o).filter(([, v]) => v != null && v !== '')).toString();

// ---- formatting -----------------------------------------------------------
const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });
export const money = (pence) => (pence == null ? '–' : gbp.format(pence / 100));
export const pct = (bps) => (bps == null ? '–' : `${(bps / 100).toFixed(1)}%`);
export const date = (d) => (d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '–');
export const dateTime = (d) => (d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '–');
export function relDays(d) {
  const days = Math.round((new Date(d).getTime() - Date.now()) / 86_400_000);
  if (days === 0) return 'today';
  return days > 0 ? `in ${days} day${days === 1 ? '' : 's'}` : `${-days} day${days === -1 ? '' : 's'} ago`;
}

const STATUS = { quote: 'Quote', confirmed: 'Confirmed', part_invoiced: 'Part invoiced', invoiced: 'Invoiced', cancelled: 'Cancelled' };
export const statusPill = (s) => html`<span class="pill pill-${s}">${STATUS[s] ?? s}</span>`;

// ---- UI bits --------------------------------------------------------------
let toastTimer;
export function toast(msg, kind = 'ok') {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast show toast-${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 3500);
}

export function errorBox(e) {
  if (e?.code === 'OFFLINE') return html`<div class="empty"><div class="empty-ico">⚡</div><p><strong>You're offline.</strong> Job packs saved on this device still work in the <a href="#/field">Field guide</a>.</p></div>`;
  return html`<div class="alert alert-danger"><strong>${e?.code ?? 'Error'}</strong> ${e?.message ?? String(e)}</div>`;
}

export const loading = () => html`<div class="loading"><span class="spinner"></span> Loading…</div>`;

export function debounce(fn, ms = 180) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export const partLink = (make, pn) => `#/counter/${encodeURIComponent(make)}/${encodeURIComponent(pn)}`;
