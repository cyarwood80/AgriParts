// Field guide: the engineer's view. Machine → parts being swapped → licensed
// manufacturer procedures, saved to the device as an expiring job pack so it
// works in a field with no signal.
import { api, date, debounce, errorBox, html, loading, qs, relDays, store, toast } from './lib.js';
import { bindDiagram, diagramFigure, numberedParts } from './diagram.js';

// ---- local packs ----------------------------------------------------------
const packs = {
  all: () => store.get('ap.packs', {}),
  get: (ref) => packs.all()[ref] ?? null,
  save: (p) => { const a = packs.all(); a[p.packRef] = p; return store.set('ap.packs', a); },
  del: (ref) => { const a = packs.all(); delete a[ref]; store.set('ap.packs', a); store.del(`ap.progress.${ref}`); },
};
const progress = {
  get: (key) => store.get(`ap.progress.${key}`, {}),
  set: (key, v) => store.set(`ap.progress.${key}`, v),
};
const expired = (p) => new Date(p.expiresAt).getTime() < Date.now();

const SKILL = { basic: 'Basic', competent: 'Competent', specialist: 'Specialist' };
const ROLE = { replaced: 'Replace', consumable: 'Consumable', may_need: 'May need' };

// ---- home -----------------------------------------------------------------
export async function renderHome(el) {
  const local = Object.values(packs.all()).sort((a, b) => String(b.issuedAt).localeCompare(String(a.issuedAt)));
  el.innerHTML = html`
    <header class="field-hero">
      <div class="field-hero-text">
        <span class="eyebrow">Engineering in the field</span>
        <h1>The manufacturer's procedure for the exact part you're swapping, on the machine, with no signal.</h1>
        <p>Start from the machine serial, tick the parts on the job, and save a licensed job pack to this device. Specs are quoted verbatim with the page they came from.</p>
      </div>
      <div class="field-search">
        <label for="mq">Find the machine</label>
        <input id="mq" class="input input-lg" placeholder="Serial, reg, customer or model" autocomplete="off" spellcheck="false">
        <div class="chips small">Try:
          <a class="chip" href="#/field/machine/ACM165-K004417">ACM165-K004417</a>
          <a class="chip" href="#/field/machine/NFB12-88213">NFB12-88213 baler</a>
          <a class="chip" href="#/field/machine/FM55-20219">FM55-20219 hedgecutter</a>
        </div>
        <ul id="mres" class="machine-results"></ul>
      </div>
    </header>

    <a class="teardown-teaser" href="#/field/explode/demo">
      <span class="eyebrow">New · prototype</span>
      <strong>Teardown: see the assembly in 3D</strong>
      <span>Pull the flail rotor apart workshop-manual style, tap any piece for its part number, and walk through the hammer change step by step.</span>
      <span class="teardown-go">Open the 3D view →</span>
    </a>

    <section class="panel">
      <h2 class="panel-title">On this device <span class="count">${local.length}</span></h2>
      ${local.length ? html`<div class="pack-grid">${local.map(packCard)}</div>`
        : html`<p class="muted">No job packs saved yet. Saved packs open here even with no signal, until their licence window ends.</p>`}
    </section>

    <section class="panel" id="issued"><h2 class="panel-title">Recently issued <span class="muted small">audit trail for publishers</span></h2><div id="issued-list">${navigator.onLine ? loading() : html`<p class="muted">Available when online.</p>`}</div></section>

    <section class="panel how">
      <h2 class="panel-title">How it stays licensed</h2>
      <div class="how-grid">
        <div><strong>Licensed or invisible</strong><p>Every procedure hangs off a publisher licence. Expired licences hide their content.</p></div>
        <div><strong>Offline only where allowed</strong><p>Online-only content (some service bulletins) is listed but never copied to the device.</p></div>
        <div><strong>Packs expire</strong><p>Each pack carries the shortest licence window. On expiry the device locks it until re-downloaded.</p></div>
        <div><strong>Every copy is audited</strong><p>Who took which procedures, for which machine, until when. Packs can be revoked remotely.</p></div>
      </div>
    </section>`.s;

  bindPackCards(el, () => renderHome(el));

  const mq = el.querySelector('#mq');
  const mres = el.querySelector('#mres');
  mq.addEventListener('input', debounce(async () => {
    const q = mq.value.trim();
    if (q.length < 2) { mres.innerHTML = ''; return; }
    try {
      const rows = await api(`/machines?${qs({ q })}`);
      mres.innerHTML = rows.length ? rows.map((m) => html`
        <li><a href="#/field/machine/${encodeURIComponent(m.serial)}">
          <span class="make-badge make-${m.make}">${m.make}</span>
          <span><strong>${m.model}</strong> <span class="mono small">${m.serial}</span><br><span class="muted small">${m.customerName ?? 'No customer'} · ${m.kind ?? ''}${m.regNo ? ` · ${m.regNo}` : ''}</span></span>
        </a></li>`).join('') : '<li class="muted small">No machines match.</li>';
    } catch (e) { mres.innerHTML = errorBox(e).s; }
  }));

  if (navigator.onLine) {
    api('/guidance/packs?limit=8').then((rows) => {
      el.querySelector('#issued-list').innerHTML = rows.length ? html`
        <table class="tbl compact">
          <thead><tr><th>Pack</th><th>Machine</th><th>Parts</th><th>Issued to</th><th>Issued</th><th>Expires</th></tr></thead>
          <tbody>${rows.map((r) => html`<tr><td class="mono">${r.packRef}</td><td class="mono small">${r.serial ?? '–'}</td><td class="small">${r.partNumbers.join(', ')}</td><td class="small muted">${r.issuedTo}</td><td>${date(r.issuedAt)}</td><td>${r.revokedAt ? 'Revoked' : relDays(r.expiresAt)}</td></tr>`)}</tbody>
        </table>`.s : '<p class="muted">None issued yet.</p>';
    }).catch((e) => { el.querySelector('#issued-list').innerHTML = errorBox(e).s; });
  }
}

function packCard(p) {
  const exp = expired(p);
  const days = Math.ceil((new Date(p.expiresAt).getTime() - Date.now()) / 86_400_000);
  const prog = progress.get(p.packRef);
  const totalSteps = p.procedures.reduce((s, pr) => s + pr.steps.length, 0);
  const done = Object.values(prog).reduce((s, a) => s + a.length, 0);
  return html`
    <div class="pack-card ${exp ? 'is-expired' : ''}">
      <a href="#/field/pack/${encodeURIComponent(p.packRef)}" class="pack-card-main">
        <div class="pack-card-top"><span class="mono">${p.packRef}</span>${exp ? html`<span class="pill pill-cancelled">Expired</span>` : days <= 3 ? html`<span class="pill pill-quote">Expires ${relDays(p.expiresAt)}</span>` : html`<span class="pill pill-invoiced">Valid ${days}d</span>`}</div>
        <strong>${p.machine.model.make} ${p.machine.model.model}</strong>
        <div class="mono small">${p.machine.serial}</div>
        <div class="muted small">${p.machine.customer?.name ?? ''}${p.jobRef ? ` · job ${p.jobRef}` : ''}</div>
        <div class="small">${p.procedures.length} procedure${p.procedures.length === 1 ? '' : 's'} · ${p.parts.map((x) => x.supplied.partNumber).join(', ')}</div>
        <div class="progress"><span style="width:${totalSteps ? Math.round((done / totalSteps) * 100) : 0}%"></span></div>
      </a>
      <button class="link-btn small" data-delpack="${p.packRef}">Remove from device</button>
    </div>`;
}

function bindPackCards(el, rerender) {
  el.querySelectorAll('[data-delpack]').forEach((b) => b.addEventListener('click', () => {
    if (!confirm(`Remove ${b.dataset.delpack} from this device?`)) return;
    packs.del(b.dataset.delpack);
    rerender();
  }));
}

// ---- machine --------------------------------------------------------------
export async function renderMachine(el, serial) {
  el.innerHTML = loading().s;
  let m;
  try { m = await api(`/machines/${encodeURIComponent(serial)}`); } catch (e) { el.innerHTML = html`<a class="back" href="#/field">← Field guide</a>${errorBox(e)}`.s; return; }
  const groups = {};
  for (const p of m.fittedParts) (groups[p.assembly ?? 'Other'] ??= []).push(p);
  const selected = new Set();

  el.innerHTML = html`
    <a class="back" href="#/field">← Field guide</a>
    <div class="machine-head card">
      <span class="make-badge make-${m.model.make} lg">${m.model.make}</span>
      <div class="machine-head-main">
        <h1>${m.model.model} <span class="muted">${m.model.kind ?? ''}</span></h1>
        <div class="mono">${m.serial}${m.regNo ? ` · ${m.regNo}` : ''}</div>
      </div>
      <dl class="facts">
        <div><dt>Customer</dt><dd>${m.customer?.name ?? '–'}</dd></div>
        <div><dt>Site</dt><dd>${m.site ?? '–'}</dd></div>
        <div><dt>Year</dt><dd>${m.year ?? '–'}</dd></div>
        ${m.engineHours != null ? html`<div><dt>Hours</dt><dd>${m.engineHours.toLocaleString('en-GB')}</dd></div>` : ''}
      </dl>
    </div>

    <section class="panel">
      <h2 class="panel-title">What's being swapped?</h2>
      <p class="muted small">Tick the parts on this job. Parts marked <span class="guide-dot"></span> have licensed manufacturer procedures.</p>
      ${Object.entries(groups).map(([asm, list]) => html`
        <div class="asm">
          <h3>${asm}</h3>
          <ul class="fit-list">
            ${list.map((p) => html`
              <li>
                <label class="fit-row">
                  <input type="checkbox" data-pn="${p.partNumber}" data-make="${p.make}">
                  <span class="fit-main"><span class="mono">${p.partNumber}</span> <span>${p.description ?? ''}</span> <span class="muted small">× ${p.qtyPerMachine}</span></span>
                  ${p.hasGuidance ? html`<span class="guide-dot" title="Licensed guidance available"></span>` : ''}
                </label>
                ${p.hasGuidance ? html`<a class="btn btn-sm" href="#/field/guide/${encodeURIComponent(p.make)}/${encodeURIComponent(p.partNumber)}?serial=${encodeURIComponent(m.serial)}">Guide</a>` : html`<span class="muted small nog">No guide</span>`}
              </li>`)}
          </ul>
        </div>`)}
    </section>

    <div class="job-bar" id="jobbar">
      <div><strong id="nsel">0 parts</strong> <span class="muted small">selected</span></div>
      <input id="jobref" class="input" placeholder="Job ref (optional)" maxlength="60">
      <button id="savepack" class="btn btn-primary" disabled>⤓ Save job pack for offline</button>
    </div>`.s;

  const nsel = el.querySelector('#nsel');
  const btn = el.querySelector('#savepack');
  el.querySelectorAll('input[type=checkbox][data-pn]').forEach((cb) => cb.addEventListener('change', () => {
    const k = `${cb.dataset.make}|${cb.dataset.pn}`;
    if (cb.checked) selected.add(k); else selected.delete(k);
    nsel.textContent = `${selected.size} part${selected.size === 1 ? '' : 's'}`;
    btn.disabled = selected.size === 0;
  }));
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Building pack…';
    const parts = [...selected].map((k) => { const [make, partNumber] = k.split('|'); return { make, partNumber }; });
    await issueAndOpen({ serial: m.serial, parts, jobRef: el.querySelector('#jobref').value.trim() || undefined }, () => {
      btn.disabled = false;
      btn.textContent = '⤓ Save job pack for offline';
    });
  });
}

async function issueAndOpen(body, onFail) {
  try {
    const pack = await api('/guidance/packs', { method: 'POST', body });
    pack._request = body; // so an expired pack can be re-issued
    if (!packs.save(pack)) { toast('Could not save to this device (storage blocked)', 'danger'); onFail?.(); return; }
    toast(`${pack.packRef} saved to this device`);
    location.hash = `#/field/pack/${encodeURIComponent(pack.packRef)}`;
  } catch (e) {
    toast(e.message, 'danger');
    onFail?.();
  }
}

// ---- guide (online) -------------------------------------------------------
export async function renderGuide(el, make, partNumber, serial) {
  el.innerHTML = loading().s;
  let g;
  try { g = await api(`/guidance?${qs({ partNumber, make, serial })}`); } catch (e) { el.innerHTML = html`<a class="back" href="#/field">← Field guide</a>${errorBox(e)}`.s; return; }
  const key = `guide.${g.part.make}.${g.part.partNumber}`;
  el.innerHTML = html`
    <a class="back" href="${serial ? `#/field/machine/${encodeURIComponent(serial)}` : '#/field'}">← ${serial ? serial : 'Field guide'}</a>
    <header class="guide-head">
      <div>
        <span class="eyebrow">Fitting guide${g.machine ? ` · ${g.machine.make} ${g.machine.model} ${g.machine.serial}` : ''}</span>
        <h1><span class="mono">${g.part.partNumber}</span> ${g.part.description}</h1>
      </div>
      ${serial && g.procedures.some((p) => p.licence.allowOffline) ? html`<button id="save" class="btn btn-primary">⤓ Save for offline</button>` : ''}
    </header>
    ${partWarning(g)}
    ${g.procedures.length ? '' : html`<div class="alert alert-warn">${g.rule}</div>`}
    <div class="procs">${g.procedures.map((pr) => renderProcedure(pr, progress.get(key), `#/field/job/${encodeURIComponent(make)}/${encodeURIComponent(partNumber)}/${pr.id}${serial ? `?serial=${encodeURIComponent(serial)}` : ""}`))}</div>
    ${withheldBlock(g.withheld)}
    ${g.procedures.length ? html`<p class="rule small">${g.rule}</p>` : ''}`.s;
  bindSteps(el, key);
  el.querySelector('#save')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    issueAndOpen({ serial, parts: [{ make, partNumber }] }, () => { e.target.disabled = false; });
  });
}

// ---- pack (offline) -------------------------------------------------------
export async function renderPack(el, ref) {
  const p = packs.get(ref);
  if (!p) {
    el.innerHTML = html`<a class="back" href="#/field">← Field guide</a><div class="empty"><p>Pack <span class="mono">${ref}</span> isn't on this device. Packs can only be opened on the device that downloaded them.</p></div>`.s;
    return;
  }
  const exp = expired(p);
  el.innerHTML = html`
    <a class="back" href="#/field">← Field guide</a>
    <div class="watermark ${exp ? 'is-expired' : ''}">
      <span>🔒 ${p.watermark}</span>
      <span id="validity">${exp ? 'Expired' : `Valid until ${date(p.expiresAt)}`}${navigator.onLine ? '' : ' · offline copy'}</span>
    </div>
    <div class="machine-head card">
      <span class="make-badge make-${p.machine.model.make} lg">${p.machine.model.make}</span>
      <div class="machine-head-main">
        <h1>${p.machine.model.model}</h1>
        <div class="mono">${p.machine.serial}${p.machine.regNo ? ` · ${p.machine.regNo}` : ''}</div>
      </div>
      <dl class="facts">
        <div><dt>Customer</dt><dd>${p.machine.customer?.name ?? '–'}${p.machine.customer?.phone ? html`<br><a href="tel:${p.machine.customer.phone}">${p.machine.customer.phone}</a>` : ''}</dd></div>
        <div><dt>Site</dt><dd>${p.machine.site ?? '–'}</dd></div>
        ${p.jobRef ? html`<div><dt>Job</dt><dd>${p.jobRef}</dd></div>` : ''}
        ${p.machine.engineHours != null ? html`<div><dt>Hours</dt><dd>${p.machine.engineHours.toLocaleString('en-GB')}</dd></div>` : ''}
      </dl>
    </div>
    ${exp ? html`
      <div class="locked card">
        <div class="empty-ico">🔒</div>
        <h2>This pack's licence window has ended</h2>
        <p class="muted">The publisher's licence lets procedures live on a device for a limited time. Re-download while you have signal to keep working.</p>
        <button id="reissue" class="btn btn-primary" ${navigator.onLine && p._request ? '' : 'disabled'}>Re-download pack</button>
      </div>` : html`
      <section class="panel">
        <h2 class="panel-title">Parts on this job</h2>
        <ul class="job-parts">
          ${p.parts.map((x) => html`
            <li>
              <span class="mono"><strong>${x.supplied.partNumber}</strong></span> ${x.supplied.description}
              ${x.superseded ? html`<span class="muted small">(asked for ${x.requested})</span>` : ''}
              ${x.coverage === 'licensed' ? html`<span class="pill pill-invoiced">${x.procedureCodes.length} procedure${x.procedureCodes.length === 1 ? '' : 's'}</span>` : html`<span class="pill pill-cancelled">No offline guide</span>`}
              ${x.warning ? html`<div class="alert alert-danger small">${x.warning}</div>` : ''}
            </li>`)}
        </ul>
      </section>
      <div class="procs">${p.procedures.map((pr) => renderProcedure(pr, progress.get(ref), `#/field/pack/${encodeURIComponent(ref)}/job/${pr.id}`))}</div>
      ${withheldBlock(p.onlineOnly, 'Online only (not copied to this device)')}
      <p class="rule small">${p.rule}</p>
      <p class="muted small">Pack hash <span class="mono">${p.contentHash.slice(0, 16)}…</span> · issued ${date(p.issuedAt)} to ${p.issuedTo}</p>`}`.s;

  if (!exp) bindSteps(el, ref);
  el.querySelector('#reissue')?.addEventListener('click', (e) => {
    e.target.disabled = true;
    packs.del(ref);
    issueAndOpen(p._request, () => { e.target.disabled = false; });
  });

  // Back online: ask the server whether the pack is still valid (revocation).
  if (navigator.onLine) {
    try {
      const s = await api(`/guidance/packs/${encodeURIComponent(ref)}`);
      if (s.revoked) {
        packs.del(ref);
        toast('This pack was revoked and has been removed from the device', 'danger');
        location.hash = '#/field';
      } else if (new Date(s.expiresAt).getTime() !== new Date(p.expiresAt).getTime()) {
        // The server's expiry is authoritative (device clocks and local copies can't be trusted).
        packs.save({ ...p, expiresAt: s.expiresAt });
        renderPack(el, ref);
      } else el.querySelector('#validity').textContent = s.valid ? `Checked just now · valid until ${date(s.expiresAt)}` : s.reason;
    } catch { /* offline or no access: keep the local verdict */ }
  }
}

// ---- shared rendering -----------------------------------------------------
function partWarning(g) {
  if (!g.superseded && !g.warning) return '';
  return html`<div class="alert ${g.straightSwap ? 'alert-info' : 'alert-danger'}">
    ${g.superseded ? html`Asked for <span class="mono">${g.requested}</span>: superseded by <strong class="mono">${g.part.partNumber}</strong>. ` : ''}
    ${g.warning ? html`<strong>${g.warning}</strong>` : 'Straight swap.'}
  </div>`;
}

function withheldBlock(list, title = 'Not shown') {
  if (!list?.length) return '';
  return html`<section class="panel withheld"><h2 class="panel-title">${title}</h2><ul class="plain">${list.map((w) => html`<li><strong>${w.title}</strong> <span class="mono small">${w.code}</span><div class="muted small">${w.reason}</div></li>`)}</ul></section>`;
}

function renderProcedure(pr, prog, jobHref) {
  const done = new Set(prog[pr.id] ?? []);
  const numbered = numberedParts(pr);
  const pctDone = pr.steps.length ? Math.round((done.size / pr.steps.length) * 100) : 0;
  return html`
    <article class="proc card" data-proc="${pr.id}" data-doc="${pr.source.documentId ?? ''}">
      <header class="proc-head">
        <div>
          <span class="mono small muted">${pr.code}</span>
          <h2>${pr.title}</h2>
          <p class="muted">${pr.summary}</p>
        </div>
        <div class="proc-meta">
          <span title="Estimated time">⏱ ${pr.estMinutes} min</span>
          <span class="skill skill-${pr.skill}">${SKILL[pr.skill] ?? pr.skill}</span>
        </div>
      </header>
      <div class="source">
        <span>📖 <strong>${pr.source.document}</strong> · <span class="mono">${pr.source.docRef}</span>${pr.source.revision ? ` ${pr.source.revision}` : ''} · pp. ${pr.pages}</span>
        <span class="muted">${pr.source.publisher} · licence ${pr.licence.reference ?? pr.licence.title}</span>
      </div>

      ${pr.safety.length ? html`<div class="safety"><strong>⚠ Safety first</strong><ul>${pr.safety.map((s) => html`<li>${s}</li>`)}</ul></div>` : ''}

      ${pr.parts.length ? diagramFigure(pr, numbered) : ''}

      <div class="proc-cols">
        ${pr.tools.length ? html`<div><h3>Tools</h3><ul class="plain tick">${pr.tools.map((t) => html`<li>${t}</li>`)}</ul></div>` : ''}
        <div>
          <h3>Parts</h3>
          <ul class="plain dg-parts">${numbered.map((x) => html`<li data-n="${x.n}"><span class="dg-n">${x.n}</span><span class="role role-${x.role}">${ROLE[x.role] ?? x.role}</span> <span class="mono">${x.partNumber}</span> × ${x.qty} <span class="muted small">${x.description ?? ''}</span>${x.available != null ? html` <span class="small ${x.available >= x.qty ? 'ok' : 'bad'}">(${x.available} in stock)</span>` : ''}</li>`)}</ul>
        </div>
      </div>

      ${jobHref ? html`<a class="btn btn-job btn-lg btn-block job-start" href="${jobHref}">Start job mode · step by step</a>` : ""}
      <div class="steps-head"><h3>Procedure</h3><span class="small muted"><span data-count>${done.size}</span>/${pr.steps.length} done</span></div>
      <div class="progress"><span data-bar style="width:${pctDone}%"></span></div>
      <ol class="steps">
        ${pr.steps.map((s) => html`
          <li class="step ${done.has(s.seq) ? 'done' : ''}">
            <label>
              <input type="checkbox" data-seq="${s.seq}" ${done.has(s.seq) ? 'checked' : ''}>
              <span class="step-n">${s.seq}</span>
              <span class="step-body">
                <span>${s.instruction}</span>
                ${s.caution ? html`<span class="caution">⚠ ${s.caution}</span>` : ''}
                ${s.specs?.length ? html`<span class="specs">${s.specs.map((sp) => html`<span class="spec"><span class="spec-label">${sp.label}</span><span class="spec-val">${sp.value}${sp.unit ? ` ${sp.unit}` : ''}</span></span>`)}</span>` : ''}
              </span>
              ${s.page ? (pr.source.documentId ? html`<button type="button" class="page-ref page-btn" data-page="${s.page}" title="Show page ${s.page} of ${pr.source.docRef}">p.${s.page}</button>` : html`<span class="page-ref" title="Page in ${pr.source.docRef}">p.${s.page}</span>`) : ''}
            </label>
          </li>`)}
      </ol>
      <div class="proc-foot"><button type="button" class="link-btn small" data-flag>⚑ Something doesn't match this machine?</button></div>
    </article>`;
}

function bindSteps(el, key) {
  el.querySelectorAll('.proc').forEach((card) => {
    const id = card.dataset.proc;
    card.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', (e) => {
      e.preventDefault();
      togglePage(card, b.closest('.step'), Number(b.dataset.page));
    }));
    bindDiagram(card);
    card.querySelector('[data-flag]')?.addEventListener('click', () => toggleFlagForm(card));
    card.querySelectorAll('input[data-seq]').forEach((cb) => cb.addEventListener('change', () => {
      const prog = progress.get(key);
      const set = new Set(prog[id] ?? []);
      const seq = Number(cb.dataset.seq);
      if (cb.checked) set.add(seq); else set.delete(seq);
      prog[id] = [...set];
      progress.set(key, prog);
      cb.closest('.step').classList.toggle('done', cb.checked);
      const total = card.querySelectorAll('input[data-seq]').length;
      card.querySelector('[data-count]').textContent = set.size;
      card.querySelector('[data-bar]').style.width = `${Math.round((set.size / total) * 100)}%`;
    }));
  });
}

// ---- the manufacturer's page, and flagging a step ----------------------------
async function togglePage(card, stepEl, page) {
  const open = stepEl.querySelector('.page-sheet');
  if (open) { open.remove(); return; }
  const sheet = document.createElement('div');
  sheet.className = 'page-sheet';
  sheet.innerHTML = loading().s;
  stepEl.appendChild(sheet);
  try {
    const p = await api(`/documents/${encodeURIComponent(card.dataset.doc)}/pages/${page}`);
    sheet.innerHTML = html`<div class="small muted">📖 <span class="mono">${p.docRef}</span>${p.revision ? ` ${p.revision}` : ''}, page ${p.page}${p.label ? ` (${p.label})` : ''}: the manufacturer's text</div><pre class="rv-page-text">${p.text}</pre>`.s;
  } catch (e) {
    sheet.innerHTML = (e.code === 'OFFLINE' ? html`<p class="muted small">Pages need signal: they aren't copied into offline packs yet.</p>` : errorBox(e)).s;
  }
}

function toggleFlagForm(card) {
  const existing = card.querySelector('.flag-form');
  if (existing) { existing.remove(); return; }
  const seqs = [...card.querySelectorAll('input[data-seq]')].map((cb) => Number(cb.dataset.seq));
  const form = document.createElement('form');
  form.className = 'flag-form';
  form.innerHTML = html`
    <strong>Tell the workshop what's wrong</strong>
    <span class="muted small">It goes to the foreman's review queue. The procedure stays visible until they look at it.</span>
    <select class="input" name="step" aria-label="Which step"><option value="">Whole procedure</option>${seqs.map((n) => html`<option value="${n}">Step ${n}</option>`)}</select>
    <textarea class="input" name="message" rows="3" required minlength="5" placeholder="e.g. The bolt is 27 mm on this machine, not 24 mm"></textarea>
    <div class="actions"><button class="btn btn-primary btn-sm" type="submit">Send to workshop</button><button class="btn btn-sm" type="button" data-cancel>Cancel</button></div>`.s;
  card.querySelector('.proc-foot').before(form);
  form.message.focus();
  form.querySelector('[data-cancel]').addEventListener('click', () => form.remove());
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = form.querySelector('[type=submit]');
    btn.disabled = true;
    try {
      await api(`/procedures/${encodeURIComponent(card.dataset.proc)}/flags`, { method: 'POST', body: { message: form.message.value.trim(), ...(form.step.value ? { stepSeq: Number(form.step.value) } : {}) } });
      form.remove();
      toast('Sent to the workshop. Thanks: the foreman will check it against the manual.');
    } catch (err) {
      btn.disabled = false;
      toast(err.code === 'OFFLINE' ? "No signal: try again when you're back online" : err.message, 'danger');
    }
  });
}
