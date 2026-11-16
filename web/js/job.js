// Job mode (concept 3): one step per screen for an engineer at the machine.
// Dark, big targets for gloves, the spec as large as it can be, the page it
// came from one tap away. Works from a saved pack with no signal.
// Progress is shared with the field guide (same storage keys).
import { api, date, errorBox, html, loading, qs, store, toast } from './lib.js';

const progress = {
  get: (key) => store.get(`ap.progress.${key}`, {}),
  set: (key, v) => store.set(`ap.progress.${key}`, v),
};

export async function renderOnline(el, make, partNumber, procId, serial) {
  el.innerHTML = html`<div class="job job-loading">${loading()}</div>`.s;
  try {
    const g = await api(`/guidance?${qs({ partNumber, make, serial })}`);
    const proc = g.procedures.find((p) => p.id === procId);
    if (!proc) throw new Error('That procedure is no longer published for this part.');
    return run(el, {
      proc,
      key: `guide.${g.part.make}.${g.part.partNumber}`,
      back: `#/field/guide/${encodeURIComponent(make)}/${encodeURIComponent(partNumber)}${serial ? `?serial=${encodeURIComponent(serial)}` : ''}`,
      machine: g.machine ? `${g.machine.model} · ${g.machine.serial}` : g.part.partNumber,
      validity: null,
    });
  } catch (e) {
    el.innerHTML = html`<div class="job"><a class="job-back" href="#/field">← Field guide</a>${errorBox(e)}</div>`.s;
  }
}

export function renderPack(el, ref, procId) {
  const p = store.get('ap.packs', {})[ref];
  const proc = p?.procedures.find((x) => x.id === procId);
  if (!p || !proc) {
    el.innerHTML = html`<div class="job"><a class="job-back" href="#/field">← Field guide</a><p>This job pack isn't on this device.</p></div>`.s;
    return;
  }
  if (new Date(p.expiresAt).getTime() < Date.now()) {
    location.hash = `#/field/pack/${encodeURIComponent(ref)}`;
    return;
  }
  return run(el, {
    proc,
    key: ref,
    back: `#/field/pack/${encodeURIComponent(ref)}`,
    machine: `${p.machine.model.model} · ${p.machine.serial}`,
    validity: `Pack valid to ${date(p.expiresAt)}`,
  });
}

function run(el, o) {
  const { proc } = o;
  const total = proc.steps.length;
  const prog = progress.get(o.key);
  const done = new Set(prog[proc.id] ?? []);
  // Start at the first step not done yet.
  let i = Math.max(0, proc.steps.findIndex((s) => !done.has(s.seq)));
  if (done.size >= total) i = total; // finished
  let listening = null;

  const save = () => { const p = progress.get(o.key); p[proc.id] = [...done]; progress.set(o.key, p); };

  function draw() {
    if (i >= total) return drawDone();
    const s = proc.steps[i];
    const caution = s.caution ?? (i === 0 ? proc.safety[0] : null);
    el.innerHTML = html`
      <div class="job">
        <header class="job-head">
          <a class="job-back" href="${o.back}" aria-label="Leave job mode">←</a>
          <div class="job-ctx"><span class="mono">${o.machine}</span><span>${navigator.onLine ? (o.validity ?? 'Online') : `Offline · ${o.validity ?? 'saved copy'}`}</span></div>
        </header>
        <div class="job-prog" role="progressbar" aria-valuemin="1" aria-valuemax="${total}" aria-valuenow="${i + 1}" aria-label="Step ${i + 1} of ${total}">
          ${proc.steps.map((x, n) => html`<span class="${done.has(x.seq) ? 'is-done' : n === i ? 'is-now' : ''}"></span>`)}
        </div>
        ${caution ? html`<div class="job-caution" role="note"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M12 3l10 18H2z"/><path d="M12 10v5M12 18v.5"/></svg><span>${caution}</span></div>` : ''}
        <main class="job-main">
          <div class="job-step">Step ${i + 1} of ${total} · ${proc.title}</div>
          <p class="job-text">${s.instruction}</p>
          ${s.specs.map((sp) => html`
            <div class="job-spec">
              <div class="job-spec-label">${sp.label}</div>
              <div class="job-spec-val mono">${sp.value}${sp.unit ? html`<span class="job-spec-unit">${sp.unit}</span>` : ''}</div>
              <div class="job-spec-foot"><span>As printed in ${proc.source.docRef}${proc.source.revision ? ` ${proc.source.revision}` : ''}</span>${s.page ? html`<button class="job-page mono" type="button" data-page="${s.page}">p.${s.page}</button>` : ''}</div>
            </div>`)}
          ${!s.specs.length && s.page ? html`<button class="job-page mono job-page-solo" type="button" data-page="${s.page}">Manual p.${s.page}</button>` : ''}
          ${i === 0 && proc.tools.length ? html`<div class="job-tools">${proc.tools.map((t) => html`<span>${t}</span>`)}</div>` : ''}
          <div id="job-sheet"></div>
        </main>
        <footer class="job-foot">
          <div class="job-nav">
            <button class="job-prev" type="button" aria-label="Previous step" ${i === 0 ? 'disabled' : ''}><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
            <button class="job-next" type="button">${i === total - 1 ? 'Done · finish' : 'Done · next'}</button>
          </div>
          <div class="job-extra">
            ${speechSupported() ? html`<button class="job-voice ${listening ? 'is-on' : ''}" type="button" aria-pressed="${listening ? 'true' : 'false'}"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>${listening ? 'Listening: say "next" or "back"' : 'Hands-free'}</button>` : html`<span></span>`}
            <button class="job-flag" type="button">Doesn't match?</button>
          </div>
        </footer>
      </div>`.s;
    el.querySelector('.job-prev').addEventListener('click', prev);
    el.querySelector('.job-next').addEventListener('click', next);
    el.querySelectorAll('[data-page]').forEach((b) => b.addEventListener('click', () => showPage(Number(b.dataset.page))));
    el.querySelector('.job-voice')?.addEventListener('click', toggleVoice);
    el.querySelector('.job-flag').addEventListener('click', () => flag(s.seq));
  }

  function drawDone() {
    el.innerHTML = html`
      <div class="job job-finished">
        <header class="job-head"><a class="job-back" href="${o.back}" aria-label="Back">←</a><div class="job-ctx"><span class="mono">${o.machine}</span></div></header>
        <main class="job-main">
          <div class="job-tick" aria-hidden="true"><svg viewBox="0 0 24 24" width="56" height="56" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12l4 4 10-10"/></svg></div>
          <p class="job-text">${proc.title}: all ${total} steps done.</p>
          <p class="job-muted">Check your work against the last step before handing the machine back.</p>
        </main>
        <footer class="job-foot"><div class="job-nav">
          <button class="job-prev" type="button" aria-label="Back to the last step"><svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2.4" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg></button>
          <a class="job-next" href="${o.back}">Back to the job</a>
        </div></footer>
      </div>`.s;
    el.querySelector('.job-prev').addEventListener('click', prev);
  }

  function next() {
    if (i < total) { done.add(proc.steps[i].seq); save(); }
    i = Math.min(total, i + 1);
    draw();
  }
  function prev() {
    i = Math.max(0, i - 1);
    done.delete(proc.steps[i].seq);
    save();
    draw();
  }

  async function showPage(page) {
    const box = el.querySelector('#job-sheet');
    if (box.dataset.page === String(page)) { box.innerHTML = ''; box.dataset.page = ''; return; }
    box.dataset.page = String(page);
    box.innerHTML = html`<div class="job-sheet">${loading()}</div>`.s;
    try {
      const p = await api(`/documents/${encodeURIComponent(proc.source.documentId)}/pages/${page}`);
      box.innerHTML = html`<div class="job-sheet"><div class="job-sheet-head"><span class="mono">${p.docRef} · page ${p.page}</span><button type="button" class="job-sheet-x" aria-label="Close page">✕</button></div><pre>${p.text}</pre></div>`.s;
    } catch (e) {
      box.innerHTML = html`<div class="job-sheet"><div class="job-sheet-head"><span>Page ${page}</span><button type="button" class="job-sheet-x" aria-label="Close page">✕</button></div><p>${e.code === 'OFFLINE' ? 'Manual pages need signal: they aren’t in offline packs yet.' : e.message}</p></div>`.s;
    }
    box.querySelector('.job-sheet-x')?.addEventListener('click', () => { box.innerHTML = ''; box.dataset.page = ''; });
  }

  function flag(seq) {
    const box = el.querySelector('#job-sheet');
    box.dataset.page = '';
    box.innerHTML = html`
      <form class="job-sheet job-flag-form">
        <strong>What doesn't match on this machine?</strong>
        <textarea name="m" rows="3" required minlength="5" placeholder="e.g. Bolt is 27 mm on this one, not 24 mm"></textarea>
        <div class="job-flag-actions"><button type="submit" class="job-next">Send to workshop</button><button type="button" class="job-flag-cancel">Cancel</button></div>
      </form>`.s;
    const f = box.querySelector('form');
    f.m.focus();
    f.querySelector('.job-flag-cancel').addEventListener('click', () => { box.innerHTML = ''; });
    f.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      f.querySelector('[type=submit]').disabled = true;
      try {
        await api(`/procedures/${encodeURIComponent(proc.id)}/flags`, { method: 'POST', body: { stepSeq: seq, message: f.m.value.trim() } });
        box.innerHTML = '';
        toast('Sent to the workshop. The foreman checks it against the manual.');
      } catch (err) {
        f.querySelector('[type=submit]').disabled = false;
        toast(err.code === 'OFFLINE' ? "No signal: try again when you're back online" : err.message, 'danger');
      }
    });
  }

  // ---- hands-free (where the browser supports speech recognition) ----
  function toggleVoice() {
    if (listening) { listening.stop(); listening = null; draw(); return; }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const rec = new SR();
    rec.lang = 'en-GB';
    rec.continuous = true;
    rec.onresult = (ev) => {
      const said = ev.results[ev.results.length - 1][0].transcript.toLowerCase();
      if (/\b(next|done)\b/.test(said)) next();
      else if (/\b(back|previous)\b/.test(said)) prev();
      else if (/\brepeat\b/.test(said)) speak(proc.steps[i]);
    };
    rec.onend = () => { if (listening === rec) rec.start(); };
    rec.start();
    listening = rec;
    draw();
  }
  function speak(s) {
    if (!s || !window.speechSynthesis) return;
    const text = [s.instruction, ...s.specs.map((sp) => `${sp.label}: ${sp.value} ${sp.unit ?? ''}`)].join('. ');
    speechSynthesis.speak(new SpeechSynthesisUtterance(text));
  }

  const onKey = (ev) => {
    if (ev.target.closest('input, textarea')) return;
    if (ev.key === 'ArrowRight' || ev.key === ' ') { ev.preventDefault(); next(); }
    if (ev.key === 'ArrowLeft') { ev.preventDefault(); prev(); }
  };
  addEventListener('keydown', onKey);
  draw();
  return () => { removeEventListener('keydown', onKey); if (listening) { const l = listening; listening = null; l.stop(); } };
}

function speechSupported() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}
