// Foreman review (ADR-0004 §3.4, ADR-0005): every extracted step beside the
// manufacturer's page it cites. Approve publishes; nothing reaches engineers
// until it's approved, and approval is refused while a check error remains.
import { ApiError, api, date, dateTime, errorBox, getKey, html, loading, raw, toast } from './lib.js';

const STATUS = { draft: 'Draft', in_review: 'Ready to review', published: 'Live', rejected: 'Rejected', withdrawn: 'Withdrawn' };
const statusPill = (s) => html`<span class="pill rv-${s}">${STATUS[s] ?? s}</span>`;
const DECISION = { approve: 'Approved', reject: 'Rejected', withdraw: 'Withdrawn', edit: 'Edited' };

/** Sidebar badge: how many procedures are waiting. Silent for keys without content access. */
export async function refreshCount() {
  const badge = document.getElementById('review-count');
  if (!badge) return;
  try {
    const q = await api('/content/review-queue');
    badge.textContent = q.length;
    badge.hidden = !q.length;
  } catch { badge.hidden = true; }
}

// ---- queue ----------------------------------------------------------------
export async function renderQueue(el) {
  el.innerHTML = html`
    <header class="page-head">
      <div><h1>Content review</h1><p class="muted">Check each procedure against the manufacturer's page before engineers can see it.</p></div>
    </header>
    <div id="q">${loading()}</div>`.s;
  let q;
  try { q = await api('/content/review-queue'); refreshCountFrom(q); } catch (e) { el.querySelector('#q').innerHTML = errorBox(e).s; return; }
  const counts = { blocked: q.filter((p) => p.errors > 0).length, ready: q.filter((p) => p.status === 'in_review' && !p.errors).length, flagged: q.filter((p) => p.openFlags > 0).length };
  el.querySelector('#q').innerHTML = q.length ? html`
    <div class="kpis">
      <div class="kpi"><div class="kpi-label">Ready to review</div><div class="kpi-val">${counts.ready}</div><div class="kpi-sub">checks passed</div></div>
      <div class="kpi"><div class="kpi-label">Need fixing</div><div class="kpi-val ${counts.blocked ? 'bad' : ''}">${counts.blocked}</div><div class="kpi-sub">a spec or page doesn't match</div></div>
      <div class="kpi"><div class="kpi-label">Flagged from the field</div><div class="kpi-val ${counts.flagged ? 'bad' : ''}">${counts.flagged}</div><div class="kpi-sub">live, but an engineer queried it</div></div>
    </div>
    <section class="panel">
      <table class="tbl rv-queue">
        <thead><tr><th>Procedure</th><th>Document</th><th>Pages</th><th>Status</th><th>Checks</th><th class="num">Flags</th><th class="num">Ver.</th></tr></thead>
        <tbody>${q.map((p) => html`
          <tr data-href="#/review/${p.id}" tabindex="0">
            <td><a href="#/review/${p.id}"><strong>${p.title}</strong></a><div class="mono small muted">${p.code}</div></td>
            <td><span class="make-badge make-${p.make}">${p.make}</span> <span class="small">${p.document}</span><div class="mono small muted">${p.docRef}</div></td>
            <td class="mono small">${p.pages ?? '–'}</td>
            <td>${statusPill(p.status)}</td>
            <td>${checkSummary(p)}</td>
            <td class="num">${p.openFlags ? html`<span class="pill rv-flag">⚑ ${p.openFlags}</span>` : html`<span class="muted">–</span>`}</td>
            <td class="num">v${p.version}</td>
          </tr>`)}</tbody>
      </table>
    </section>` : html`<div class="empty"><div class="empty-ico">✓</div><p><strong>Nothing to review.</strong> New manuals appear here after extraction, and live procedures come back if an engineer flags a step.</p></div>`;
  el.querySelectorAll('tr[data-href]').forEach((tr) => {
    tr.addEventListener('click', (e) => { if (!e.target.closest('a')) location.hash = tr.dataset.href; });
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = tr.dataset.href; });
  });
}

function refreshCountFrom(q) {
  const badge = document.getElementById('review-count');
  if (badge) { badge.textContent = q.length; badge.hidden = !q.length; }
}

function checkSummary(p) {
  if (p.checkOk == null) return html`<span class="muted small">Not checked</span>`;
  if (p.errors) return html`<span class="bad small"><strong>✕ ${p.errors} error${p.errors === 1 ? '' : 's'}</strong></span>${p.warnings ? html` <span class="muted small">· ${p.warnings} warning${p.warnings === 1 ? '' : 's'}</span>` : ''}`;
  return html`<span class="ok small"><strong>✓ Passed</strong></span>${p.warnings ? html` <span class="muted small">· ${p.warnings} warning${p.warnings === 1 ? '' : 's'}</span>` : ''}`;
}

// ---- one procedure --------------------------------------------------------
export async function renderDetail(el, id) {
  el.innerHTML = loading().s;
  let d;
  try { d = await api(`/procedures/${encodeURIComponent(id)}/review`); } catch (e) { el.innerHTML = html`<a class="back" href="#/review">← Review queue</a>${errorBox(e)}`.s; return; }

  const pages = new Map(d.pages.map((p) => [p.page, p]));
  const issues = d.check?.issues ?? [];
  const errors = issues.filter((i) => i.severity === 'error');
  const general = issues.filter((i) => i.stepSeq == null);
  const openFlags = d.flags.filter((f) => f.status === 'open');
  const state = { seq: null, page: d.steps.find((s) => s.page)?.page ?? d.pageFrom, editing: null };

  const draw = () => {
    el.innerHTML = html`
      <a class="back" href="#/review">← Review queue</a>
      <header class="page-head rv-head">
        <div>
          <span class="eyebrow">${d.document.make} · ${d.code} · v${d.version} · ${d.origin === 'extracted' ? 'extracted by Claude' : d.origin === 'seed' ? 'demo content' : 'entered by hand'}</span>
          <h1>${d.title} ${statusPill(d.status)}</h1>
          <p class="muted small">📖 <strong>${d.document.title}</strong> · <span class="mono">${d.document.docRef}</span>${d.document.revision ? ` ${d.document.revision}` : ''} · pp. ${d.pageFrom ?? '?'}${d.pageTo && d.pageTo !== d.pageFrom ? `–${d.pageTo}` : ''} · ${d.licence.publisher}, ${d.licence.reference ?? d.licence.title}${d.licence.expiresOn ? `, licence to ${date(d.licence.expiresOn)}` : ''}</p>
        </div>
      </header>

      ${errors.length ? html`<div class="alert alert-danger"><strong>Can't approve yet: ${errors.length} check error${errors.length === 1 ? '' : 's'}.</strong> Fix the step so it matches the page exactly, then approve.</div>`
        : d.check ? html`<div class="alert alert-info">✓ Automatic checks passed: every spec appears word for word on its page. Now read each step against the page yourself.</div>` : ''}
      ${general.length ? html`<ul class="rv-issues">${general.map(issueLi)}</ul>` : ''}
      ${openFlags.length ? html`<div class="alert alert-warn"><strong>⚑ ${openFlags.length} open flag${openFlags.length === 1 ? '' : 's'} from the field.</strong> Approving again marks ${openFlags.length === 1 ? 'it' : 'them'} resolved, so fix the step first if the engineer is right.</div>` : ''}

      <div class="rv-grid">
        <section class="rv-steps">
          ${d.safety.length ? html`<div class="safety"><strong>⚠ Safety</strong><ul>${d.safety.map((s) => html`<li>${s}</li>`)}</ul></div>` : ''}
          ${d.tools.length ? html`<p class="small"><strong>Tools:</strong> ${d.tools.join(' · ')}</p>` : ''}
          <ol class="rv-list">${d.steps.map((s) => (state.editing === s.seq ? editForm(s) : stepCard(s)))}</ol>
          ${d.parts.length ? html`<p class="small"><strong>Parts:</strong> ${d.parts.map((p) => html`<span class="mono">${p.partNumber}</span> × ${p.qty} <span class="muted">(${p.role.replace('_', ' ')})</span>`).reduce((a, b) => html`${a}, ${b}`)}</p>` : ''}
        </section>
        <aside class="rv-page" aria-label="Manufacturer page">${pagePane()}</aside>
      </div>

      <section class="panel rv-decide">
        <h2 class="panel-title">Your decision</h2>
        <textarea id="notes" class="input" rows="2" placeholder="Notes (required to reject or withdraw), e.g. checked against pp. 702–703"></textarea>
        <div class="actions">
          <button id="approve" class="btn btn-primary" ${errors.length || d.status === 'withdrawn' ? 'disabled' : ''} title="${errors.length ? 'Fix the check errors first' : ''}">✓ Approve and publish</button>
          <button id="reject" class="btn" ${d.status === 'published' ? 'disabled' : ''}>Reject</button>
          ${d.status === 'published' ? html`<button id="withdraw" class="btn">Withdraw from engineers</button>` : ''}
          <span class="muted small">Signing as you. Every decision is recorded.</span>
        </div>
      </section>

      <div class="insight-grid">
        <section class="panel"><h2 class="panel-title">Flags from the field</h2>${d.flags.length ? html`<ul class="plain rv-flags">${d.flags.map((f) => html`<li class="${f.status === 'open' ? 'is-open' : ''}"><span class="pill ${f.status === 'open' ? 'rv-flag' : 'rv-published'}">${f.status}</span> ${f.stepSeq ? html`<strong>Step ${f.stepSeq}:</strong> ` : ''}${f.message}<div class="muted small">${f.flaggedBy} · ${dateTime(f.createdAt)}${f.resolution ? ` · ${f.resolution}` : ''}</div></li>`)}</ul>` : html`<p class="muted small">None.</p>`}</section>
        <section class="panel"><h2 class="panel-title">History</h2>${d.history.length ? html`<ul class="plain rv-history">${d.history.map((h) => html`<li><strong>${DECISION[h.decision] ?? h.decision}</strong> v${h.version} by ${h.reviewer}${h.notes ? html` <span class="muted">· ${h.notes}</span>` : ''}<div class="muted small">${dateTime(h.at)}</div></li>`)}</ul>` : html`<p class="muted small">No decisions yet.</p>`}${d.verifiedBy ? html`<p class="small muted">Last verified by ${d.verifiedBy}, ${dateTime(d.verifiedAt)}</p>` : ''}</section>
      </div>`.s;
    bind();
  };

  const stepIssues = (seq) => issues.filter((i) => i.stepSeq === seq);
  const stepFlags = (seq) => openFlags.filter((f) => f.stepSeq === seq);

  function issueLi(i) {
    return html`<li class="rv-issue rv-issue-${i.severity}"><span class="mono">${i.code}</span> ${i.message}</li>`;
  }

  function stepCard(s) {
    const iss = stepIssues(s.seq);
    const fl = stepFlags(s.seq);
    const bad = iss.some((i) => i.severity === 'error');
    return html`
      <li class="rv-step ${state.seq === s.seq ? 'is-active' : ''} ${bad ? 'is-bad' : ''} ${fl.length ? 'is-flagged' : ''}" data-seq="${s.seq}" tabindex="0">
        <div class="rv-step-top">
          <span class="step-n">${s.seq}</span>
          <span class="rv-step-body">
            <span>${s.instruction}</span>
            ${s.caution ? html`<span class="caution">⚠ ${s.caution}</span>` : ''}
            ${s.specs.length ? html`<span class="specs">${s.specs.map((sp) => html`<span class="spec"><span class="spec-label">${sp.label}</span><span class="spec-val">${sp.value}${sp.unit ? ` ${sp.unit}` : ''}</span></span>`)}</span>` : ''}
          </span>
          <span class="rv-step-side">
            ${s.page ? html`<span class="page-ref">p.${s.page}</span>` : html`<span class="pill rv-draft">no page</span>`}
            ${d.status !== 'withdrawn' ? html`<button class="link-btn small" data-edit="${s.seq}" type="button">Edit</button>` : ''}
          </span>
        </div>
        ${iss.length ? html`<ul class="rv-issues">${iss.map(issueLi)}</ul>` : ''}
        ${fl.map((f) => html`<div class="rv-flag-note">⚑ <strong>${f.flaggedBy}:</strong> ${f.message}</div>`)}
      </li>`;
  }

  function editForm(s) {
    return html`
      <li class="rv-step is-active is-editing" data-seq="${s.seq}">
        <form class="stack rv-edit" data-form="${s.seq}">
          <div class="rv-edit-row"><span class="step-n">${s.seq}</span><strong>Edit step ${s.seq}</strong><span class="muted small">Copy specs exactly as printed on the page.</span></div>
          <label class="small">Instruction<textarea class="input" name="instruction" rows="3" required>${s.instruction}</textarea></label>
          <div class="rv-edit-cols">
            <label class="small">Page<input class="input" name="page" type="number" min="1" value="${s.page ?? ''}"></label>
            <label class="small rv-grow">Caution<input class="input" name="caution" value="${s.caution ?? ''}"></label>
          </div>
          <div class="small"><strong>Specs</strong></div>
          <div data-specs>${s.specs.map(specRow)}</div>
          <button class="link-btn small" type="button" data-addspec>+ Add spec</button>
          <label class="small">Why the change<input class="input" name="notes" placeholder="e.g. value corrected to match p.${s.page ?? '?'}"></label>
          <div class="actions">
            <button class="btn btn-primary btn-sm" type="submit">Save and re-check</button>
            <button class="btn btn-sm" type="button" data-cancel>Cancel</button>
          </div>
        </form>
      </li>`;
  }

  function specRow(sp = { label: '', value: '', unit: '' }) {
    return html`<div class="rv-spec-row">
      <input class="input" data-k="label" placeholder="Label" value="${sp.label}" aria-label="Spec label">
      <input class="input mono" data-k="value" placeholder="Value as printed" value="${sp.value}" aria-label="Spec value">
      <input class="input" data-k="unit" placeholder="Unit" value="${sp.unit ?? ''}" aria-label="Unit">
      <button class="icon-btn" type="button" data-delspec aria-label="Remove spec">✕</button>
    </div>`;
  }

  function pagePane() {
    const n = state.page;
    const pg = n != null ? pages.get(n) : null;
    const nums = [...pages.keys()];
    const step = d.steps.find((s) => s.seq === state.seq);
    const values = step && step.page === n ? step.specs.map((sp) => sp.value) : [];
    const { text, missing } = pg ? highlight(pg.text, values) : { text: raw(''), missing: [] };
    return html`
      <div class="rv-page-head">
        <div><strong>${d.document.docRef}</strong> <span class="muted">page</span> <span class="mono">${n ?? '–'}</span>${pg?.label ? html` <span class="muted small">(${pg.label})</span>` : ''}</div>
        <div class="seg rv-pages">${nums.map((p) => html`<button type="button" data-page="${p}" class="${p === n ? 'on' : ''}">${p}</button>`)}</div>
      </div>
      ${pg ? html`
        ${missing.length ? html`<div class="alert alert-danger small">Not on this page: ${missing.map((v) => html`<span class="mono">${v}</span>`).reduce((a, b) => html`${a}, ${b}`)}</div>` : values.length ? html`<div class="alert alert-info small">Highlighted: this step's spec values as printed on the page.</div>` : ''}
        <pre class="rv-page-text">${text}</pre>`
        : html`<p class="muted">${n == null ? 'This procedure cites no page.' : `Page ${n} has no stored text. The document may need paginating again.`}</p>`}
      ${d.document.hasFile && n != null ? html`<button id="pdf" class="btn btn-sm btn-block" type="button">Open the original PDF at page ${n}</button>` : html`<p class="muted small">Text layer shown. ${d.document.hasFile ? '' : 'No PDF stored for this document.'}</p>`}`;
  }

  function bind() {
    el.querySelectorAll('.rv-step[data-seq]:not(.is-editing)').forEach((li) => {
      li.addEventListener('click', (e) => {
        if (e.target.closest('[data-edit]')) return;
        select(Number(li.dataset.seq));
      });
    });
    el.querySelectorAll('[data-edit]').forEach((b) => b.addEventListener('click', () => { state.editing = Number(b.dataset.edit); state.seq = state.editing; const s = d.steps.find((x) => x.seq === state.seq); if (s?.page) state.page = s.page; draw(); el.querySelector('[data-form] textarea')?.focus(); }));
    el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); redrawPage(); }));
    el.querySelector('#pdf')?.addEventListener('click', openPdf);

    const form = el.querySelector('[data-form]');
    if (form) {
      form.querySelector('[data-addspec]').addEventListener('click', () => form.querySelector('[data-specs]').insertAdjacentHTML('beforeend', specRow().s));
      form.addEventListener('click', (e) => { if (e.target.closest('[data-delspec]')) e.target.closest('.rv-spec-row').remove(); });
      form.querySelector('[data-cancel]').addEventListener('click', () => { state.editing = null; draw(); });
      form.addEventListener('submit', saveEdit);
    }

    el.querySelector('#approve')?.addEventListener('click', () => decide('approve'));
    el.querySelector('#reject')?.addEventListener('click', () => decide('reject'));
    el.querySelector('#withdraw')?.addEventListener('click', () => decide('withdraw'));
  }

  function select(seq) {
    state.seq = seq;
    const s = d.steps.find((x) => x.seq === seq);
    if (s?.page) state.page = s.page;
    el.querySelectorAll('.rv-step').forEach((li) => li.classList.toggle('is-active', Number(li.dataset.seq) === seq));
    redrawPage();
  }

  function redrawPage() {
    const pane = el.querySelector('.rv-page');
    pane.innerHTML = pagePane().s;
    pane.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => { state.page = Number(b.dataset.page); redrawPage(); }));
    pane.querySelector('#pdf')?.addEventListener('click', openPdf);
    pane.querySelector('mark')?.scrollIntoView({ block: 'nearest' });
  }

  async function openPdf() {
    // The file needs the API key, so fetch it and open a local copy at the page.
    const w = window.open('', '_blank');
    try {
      const res = await fetch(`/v1/documents/${d.document.id}/file`, { headers: { Authorization: `Bearer ${getKey()}` } });
      if (!res.ok) throw new ApiError(res.status, await res.json().catch(() => null));
      const url = URL.createObjectURL(await res.blob());
      if (w) w.location.href = `${url}#page=${state.page}`; else location.href = `${url}#page=${state.page}`;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      w?.close();
      toast(e.message, 'danger');
    }
  }

  async function saveEdit(e) {
    e.preventDefault();
    const f = e.target;
    const seq = Number(f.dataset.form);
    const specs = [...f.querySelectorAll('.rv-spec-row')].map((r) => {
      const v = (k) => r.querySelector(`[data-k="${k}"]`).value.trim();
      return { label: v('label'), value: v('value'), ...(v('unit') ? { unit: v('unit') } : {}) };
    }).filter((s) => s.label || s.value);
    if (specs.some((s) => !s.label || !s.value)) { toast('Each spec needs a label and a value', 'danger'); return; }
    const page = f.page.value ? Number(f.page.value) : undefined;
    const body = { instruction: f.instruction.value.trim(), specs, caution: f.caution.value.trim() || null, ...(page ? { page } : {}), ...(f.notes.value.trim() ? { notes: f.notes.value.trim() } : {}) };
    f.querySelector('[type=submit]').disabled = true;
    try {
      const r = await api(`/procedures/${d.id}/steps/${seq}`, { method: 'PATCH', body });
      toast(r.check.ok ? `Step ${seq} saved. Checks pass: ready to approve (v${r.version}).` : `Step ${seq} saved, but checks still fail (v${r.version}).`, r.check.ok ? 'ok' : 'danger');
      renderDetail(el, d.id);
    } catch (err) {
      f.querySelector('[type=submit]').disabled = false;
      toast(err.message, 'danger');
    }
  }

  async function decide(decision) {
    const notes = el.querySelector('#notes').value.trim();
    if (decision !== 'approve' && !notes) { toast('Add a note saying why', 'danger'); el.querySelector('#notes').focus(); return; }
    if (decision === 'approve' && !confirm(`Publish ${d.code} v${d.version} to engineers? You're confirming every step matches the manufacturer's page.`)) return;
    if (decision === 'withdraw' && !confirm(`Withdraw ${d.code}? Engineers will stop seeing it straight away.`)) return;
    el.querySelectorAll('.rv-decide button').forEach((b) => { b.disabled = true; });
    try {
      const r = await api(`/procedures/${d.id}/review`, { method: 'POST', body: { decision, ...(notes ? { notes } : {}) } });
      toast(`${d.code}: ${STATUS[r.status] ?? r.status}${r.resolvedFlags ? `, ${r.resolvedFlags} flag${r.resolvedFlags === 1 ? '' : 's'} resolved` : ''}`);
      location.hash = '#/review';
    } catch (err) {
      toast(err.message, 'danger');
      renderDetail(el, d.id);
    }
  }

  // j/k or arrow keys move between steps; e edits the selected step.
  const onKey = (e) => {
    if (e.target.closest('input, textarea, select') || state.editing) return;
    const seqs = d.steps.map((s) => s.seq);
    const i = seqs.indexOf(state.seq);
    if (e.key === 'j' || e.key === 'ArrowDown') { e.preventDefault(); select(seqs[Math.min(seqs.length - 1, i + 1)]); el.querySelector('.rv-step.is-active')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'k' || e.key === 'ArrowUp') { e.preventDefault(); select(seqs[Math.max(0, i - 1)]); el.querySelector('.rv-step.is-active')?.scrollIntoView({ block: 'nearest' }); }
    if (e.key === 'e' && state.seq != null) el.querySelector(`[data-edit="${state.seq}"]`)?.click();
  };
  addEventListener('keydown', onKey);

  if (d.steps.length) state.seq = (d.steps.find((s) => stepIssues(s.seq).some((i) => i.severity === 'error')) ?? d.steps[0]).seq;
  const first = d.steps.find((s) => s.seq === state.seq);
  if (first?.page) state.page = first.page;
  draw();
  return () => removeEventListener('keydown', onKey);
}

/**
 * Mark each value where it appears in the page text. Matching is loose only on
 * whitespace and dash/quote variants: the server's verbatim check decides.
 */
function highlight(text, values) {
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const ranges = [];
  const missing = [];
  for (const v of values) {
    const pattern = v.trim().split('').map((ch) => {
      if (/\s/.test(ch)) return '\\s+';
      if (/[-‐‑‒–—−]/.test(ch)) return '[-‐‑‒–—−]';
      if (/["“”]/.test(ch)) return '["“”]';
      if (/['‘’]/.test(ch)) return "['‘’]";
      return ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('').replace(/(\\s\+)+/g, '\\s+');
    const re = new RegExp(pattern, 'g');
    let m;
    let found = false;
    while ((m = re.exec(text))) { ranges.push([m.index, m.index + m[0].length]); found = true; if (!m[0].length) break; }
    if (!found) missing.push(v);
  }
  ranges.sort((a, b) => a[0] - b[0]);
  let out = '';
  let at = 0;
  for (const [s, e] of ranges) {
    if (s < at) continue;
    out += esc(text.slice(at, s)) + '<mark>' + esc(text.slice(s, e)) + '</mark>';
    at = e;
  }
  out += esc(text.slice(at));
  return { text: raw(out), missing };
}
