// Find a part: the guided path. One question per screen.
//
//   1. Which machine?      serial, reg, customer or model (or a part number)
//   2. What do you need?   describe it in your own words, or browse the machine
//   3. The part            right part, why, price and stock, a 3D exploded view
//                          where we have one, and the manufacturer's fitting steps
//
// Identification is done by the server (POST /v1/find). It only ever returns
// parts it has checked against the catalogue and this machine's parts book.
import { api, debounce, errorBox, getKey, html, loading, money, qs, raw, store, toast } from './lib.js';
import { bindDiagram, diagramFigure, numberedParts } from './diagram.js';
import { modelFor } from './model3d.js';

const enc = encodeURIComponent;

// ---- small pieces ---------------------------------------------------------
const I = {
  search: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l9.5 17h-19z"/><path d="M12 10v4M12 17.5v.5"/></svg>',
  book: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5a2 2 0 012-2h13v16H6a2 2 0 00-2 2z"/><path d="M4 19V5"/></svg>',
  clock: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  box: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7.5L12 3l9 4.5v9L12 21l-9-4.5z"/><path d="M3 7.5l9 4.5 9-4.5M12 12v9"/></svg>',
  wrench: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14.5 6.5a4 4 0 00-5.4 5.1L3.5 17.2l3.3 3.3 5.6-5.6a4 4 0 005.1-5.4l-2.5 2.5-2.5-.5-.5-2.5z"/></svg>',
  history: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M3 12a9 9 0 103-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
  chat: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h16v11H9l-5 4z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h13l-3-3M20 16H7l3 3"/></svg>',
};
const ic = (k) => rawSvg(I[k]);
function rawSvg(s) { return html([s]); }

const EVIDENCE_ICON = { number: 'check', parts_book: 'book', supersession: 'swap', history: 'history', described: 'chat', equivalent: 'swap' };

// Machine silhouettes (invented line art), chosen by machine kind.
function machineArt(kind = '') {
  const k = kind.toLowerCase();
  const common = 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (/baler/.test(k)) {
    return rawSvg(`<svg viewBox="0 0 120 70" ${common} aria-hidden="true"><rect x="22" y="14" width="66" height="34" rx="4"/><path d="M88 22h14l8 12v14H88M10 40h12M30 48v4M76 48v4"/><circle cx="36" cy="54" r="9"/><circle cx="74" cy="54" r="9"/><path d="M28 24h20M28 32h30"/></svg>`);
  }
  if (/flail|hedge|mower|cutter/.test(k)) {
    return rawSvg(`<svg viewBox="0 0 120 70" ${common} aria-hidden="true"><path d="M10 26l34-12 26 18"/><path d="M44 14l8 20"/><rect x="62" y="30" width="46" height="18" rx="9"/><path d="M68 48l-2 6M78 48l-2 6M88 48l-2 6M98 48l-2 6"/><circle cx="10" cy="26" r="4"/></svg>`);
  }
  return rawSvg(`<svg viewBox="0 0 120 70" ${common} aria-hidden="true"><path d="M30 46h40M58 18h20l6 16"/><path d="M58 18v16H34l-6 8"/><rect x="62" y="22" width="13" height="10" rx="1"/><path d="M84 34h16l6 6v6h-8"/><circle cx="30" cy="48" r="14"/><circle cx="30" cy="48" r="5"/><circle cx="92" cy="52" r="8"/><path d="M46 18V8"/></svg>`);
}

function stepper(active) {
  const steps = ['Machine', 'Describe it', 'See it & fit it'];
  return html`<ol class="stepper" aria-label="Progress">${steps.map((s, i) => html`
    <li class="${i < active ? 'done' : i === active ? 'now' : ''}" ${i === active ? 'aria-current="step"' : ''}><span class="stepper-n">${i < active ? ic('check') : i + 1}</span><span>${s}</span></li>`)}</ol>`;
}

const recent = {
  all: () => store.get('ap.recentMachines', []),
  add(m) {
    const list = [m, ...recent.all().filter((x) => x.serial !== m.serial)].slice(0, 6);
    store.set('ap.recentMachines', list);
  },
};

const confidenceLabel = { high: 'Confirmed match', medium: 'Likely match', low: 'Possible match' };

// ---- 1. which machine? ----------------------------------------------------
export async function renderStart(el) {
  const rec = recent.all();
  el.innerHTML = html`
    <section class="hero">
      <div class="hero-inner">
        ${stepper(0)}
        <h1 class="hero-title">The right part, first time.</h1>
        <p class="hero-lede">Start with the machine. We check every answer against its parts book, then show you the part in 3D and the manufacturer's fitting instructions.</p>
        <form class="hero-search" id="msearch" role="search">
          <label class="sr-only" for="mq">Find the machine</label>
          <span class="hero-search-ico">${ic('search')}</span>
          <input id="mq" placeholder="Serial number, registration, customer or model" autocomplete="off" spellcheck="false" autofocus>
          <button class="btn btn-primary btn-xl" type="submit">Find machine</button>
        </form>
        <ul id="mres" class="mresults" aria-live="polite"></ul>
        <div class="hero-try">Try <a href="#/find/m/ACM165-K004417">ACM165-K004417</a><a href="#/find/m/FM55-20219">FM55-20219</a><a href="#/find/m/NFB12-88213">NFB12-88213</a><span class="hero-or">or</span><a class="hero-ask" href="#/find/ask">Just tell us what you need ${ic('arrow')}</a></div>
      </div>
      <div class="hero-art" aria-hidden="true">${machineArt('tractor')}</div>
    </section>

    <section class="start-grid">
      <div class="tile">
        <h2 class="tile-title">Recent machines</h2>
        ${rec.length ? html`<ul class="mlist">${rec.map((m) => machineRow(m))}</ul>` : html`<p class="muted">Machines you look up appear here.</p>`}
      </div>
      <div class="tile">
        <h2 class="tile-title">Already have a part number?</h2>
        <p class="muted">Old numbers are followed to the current one.</p>
        <form id="pnform" class="inline-form">
          <input id="pn" class="input input-lg mono" placeholder="e.g. ACM-10021" autocomplete="off" spellcheck="false" required>
          <button class="btn btn-lg" type="submit">Look up</button>
        </form>
      </div>
      <div class="tile tile-quiet">
        <h2 class="tile-title">How it works</h2>
        <ol class="how">
          <li><b>Machine.</b> So we only show parts that fit it.</li>
          <li><b>Describe it.</b> "Oil filter", "hammers keep flying off", or a photo of the old part soon.</li>
          <li><b>See it and fit it.</b> Exploded 3D view and the licensed manufacturer procedure, step by step.</li>
        </ol>
      </div>
    </section>`.s;

  const input = el.querySelector('#mq');
  const res = el.querySelector('#mres');
  let last = [];
  const search = debounce(async () => {
    const q = input.value.trim();
    if (q.length < 2) { res.innerHTML = ''; last = []; return; }
    try {
      last = await api(`/machines?${qs({ q })}`);
      res.innerHTML = last.length
        ? html`${last.map((m) => machineRow({ ...m, customerName: m.customerName }))}`.s
        : html`<li class="mresults-empty"><span>“${q}” isn’t on our machine records. Linchpin can still help: it knows the main makes and can search for the part.</span><a class="btn btn-primary" href="#/find/ask?q=${enc(q)}">Ask Linchpin about “${q}” ${ic('arrow')}</a></li>`.s;
    } catch (e) { res.innerHTML = errorBox(e).s; }
  });
  input.addEventListener('input', search);
  el.querySelector('#msearch').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = input.value.trim();
    if (!q) return;
    if (!last.length) { try { last = await api(`/machines?${qs({ q })}`); } catch { last = []; } }
    if (last.length === 1 || last[0]?.serial.toLowerCase() === q.toLowerCase()) location.hash = `#/find/m/${enc(last[0].serial)}`;
    else if (!last.length) location.hash = `#/find/ask?q=${enc(q)}`;
    else search();
  });
  el.querySelector('#pnform').addEventListener('submit', async (e) => {
    e.preventDefault();
    const pn = el.querySelector('#pn').value.trim();
    try {
      const r = await api(`/parts/resolve?${qs({ partNumber: pn })}`);
      location.hash = `#/part/${enc(r.part.make)}/${enc(r.part.partNumber)}`;
    } catch (err) { toast(err.message, 'danger'); }
  });
}

function machineRow(m) {
  return html`<li><a class="mrow" href="#/find/m/${enc(m.serial)}">
    <span class="mrow-art">${machineArt(m.kind ?? '')}</span>
    <span class="mrow-main"><b>${m.make} ${m.model}</b><span class="mono">${m.serial}</span></span>
    <span class="mrow-who">${m.customerName ?? ''}</span>
    <span class="mrow-go">${ic('arrow')}</span>
  </a></li>`;
}

// ---- 2. what do you need? --------------------------------------------------
const EXAMPLES = {
  tractor: ['Oil filter', 'Air filter', 'Fuel filters', 'Hydraulic filter'],
  flail: ['Flail hammers', 'Rotor bearing'],
  baler: ['Knotter bill hook', 'Pick-up tines'],
};

export async function renderMachine(el, serial) {
  el.innerHTML = loading().s;
  let m;
  try { m = await api(`/machines/${enc(serial)}`); } catch (e) { el.innerHTML = html`<a class="back" href="#/find">← Find a part</a>${errorBox(e)}`.s; return; }
  recent.add({ serial: m.serial, make: m.model.make, model: m.model.model, kind: m.model.kind, customerName: m.customer?.name });
  const kind = /baler/i.test(m.model.kind) ? 'baler' : /flail|hedge|mower/i.test(m.model.kind) ? 'flail' : 'tractor';
  const groups = new Map();
  for (const p of m.fittedParts) {
    const a = p.assembly ?? 'Other';
    if (!groups.has(a)) groups.set(a, []);
    groups.get(a).push(p);
  }

  el.innerHTML = html`
    <div class="flow">
      ${stepper(1)}
      <section class="machine-bar">
        <span class="machine-art">${machineArt(m.model.kind)}</span>
        <div class="machine-id">
          <span class="eyebrow">${m.model.kind ?? 'Machine'}</span>
          <h1>${m.model.make} ${m.model.model}</h1>
          <div class="machine-facts"><span class="mono">${m.serial}</span>${m.year ? html`<span>${m.year}</span>` : ''}${m.engineHours ? html`<span>${m.engineHours.toLocaleString('en-GB')} h</span>` : ''}${m.customer ? html`<span>${m.customer.name}</span>` : ''}</div>
        </div>
        <a class="btn" href="#/find">Change machine</a>
      </section>

      <section class="chat" id="chat"></section>

      <section class="browse">
        <div class="section-head"><h2>Or pick it from this machine's parts</h2><span class="muted">${m.fittedParts.length} parts from the parts book for serial ${m.serial}</span></div>
        <div class="assemblies">${[...groups].map(([a, list]) => html`
          <details class="assembly">
            <summary><span class="assembly-name">${a}</span><span class="assembly-n">${list.length}</span></summary>
            <ul>${list.map((p) => html`<li><a href="#/part/${enc(p.make)}/${enc(p.partNumber)}?serial=${enc(m.serial)}">
              <span class="mono">${p.partNumber}</span><span>${p.description ?? ''}</span>
              <span class="assembly-tags">${p.hasGuidance ? html`<span class="tag tag-guide">Fitting guide</span>` : ''}${modelFor(p) ? html`<span class="tag tag-3d">3D</span>` : ''}</span>
            </a></li>`)}</ul>
          </details>`)}</div>
      </section>
    </div>`.s;

  mountChat(el.querySelector('#chat'), { machine: m, examples: EXAMPLES[kind], title: 'What do you need for it?' });
}

/** No machine picked: "Valtra T214 oil filter", or anything else. */
export async function renderAsk(el, first) {
  el.innerHTML = html`
    <div class="flow">
      ${stepper(1)}
      <section class="chat" id="chat"></section>
    </div>`.s;
  mountChat(el.querySelector('#chat'), {
    machine: null,
    first,
    title: 'Tell us the machine and what you need',
    examples: ['Oil filter for a Valtra T214', 'Flail hammers for the hedgecutter FM55-20219', 'Air filter for a John Deere 6155R'],
  });
}

function partHref(c, serial) { return `#/part/${enc(c.make)}/${enc(c.partNumber)}${serial ? `?serial=${enc(serial)}` : ''}`; }

function stockLine(c) {
  if (!c.stock) return '';
  const total = c.stock.reduce((n, s) => n + s.available, 0);
  if (!total) return html`<span class="stock stock-out">Out of stock: order in</span>`;
  return html`<span class="stock stock-in">${ic('check')} ${total} in stock · ${c.stock[0].depot}${c.stock.length > 1 ? ` +${c.stock.length - 1}` : ''}</span>`;
}

/** POST /v1/find/stream: calls onStatus while the agent works, resolves with the result. */
async function findStream(body, onStatus) {
  let res;
  try {
    res = await fetch('/v1/find/stream', { method: 'POST', headers: { Authorization: `Bearer ${getKey()}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch { throw new Error('No connection to the server'); }
  if (!res.ok) {
    const j = await res.json().catch(() => null);
    throw new Error(j?.error?.message ?? `HTTP ${res.status}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let ev = 'message';
      let data = '';
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event: ')) ev = line.slice(7);
        else if (line.startsWith('data: ')) data += line.slice(6);
      }
      if (!data) continue;
      const d = JSON.parse(data);
      if (ev === 'status') onStatus(d.status);
      else if (ev === 'result') return d;
      else if (ev === 'error') throw new Error(d.message);
    }
  }
  throw new Error('The connection closed before an answer came back');
}

const ENGINE_LABEL = { 'claude-local': 'Claude', claude: 'Claude', rules: 'Offline matcher' };

/**
 * The conversation: what the user says, Linchpin's reply, and under each
 * reply the parts it found (checked against our catalogue, or found online
 * and marked unconfirmed). Works with or without a machine picked.
 */
function mountChat(host, { machine, examples, title, first }) {
  const history = [];
  let serial = machine?.serial ?? null;
  const account = machine?.customer?.accountCode ?? null;
  host.innerHTML = html`
    <div class="chat-head">
      <h2 class="ask-title">${title}</h2>
      <span class="engine-chip" id="engine"><span class="dot"></span> Checking connection…</span>
    </div>
    <div class="chat-thread" id="thread" aria-live="polite"></div>
    <form class="ask-form" id="chatform">
      <label class="sr-only" for="chatq">Message</label>
      <input id="chatq" placeholder="${machine ? 'Describe it in your own words, or type a part number' : 'e.g. oil filter for a Valtra T214 (serial if you have it)'}" autocomplete="off" autofocus>
      <button class="btn btn-primary btn-xl" type="submit">Send ${ic('arrow')}</button>
    </form>
    <div class="ask-examples" id="examples">${examples.map((x) => html`<button type="button" class="pillbtn" data-ex="${x}">${x}</button>`)}</div>
    <p class="chat-foot" id="enginenote"></p>`.s;
  const thread = host.querySelector('#thread');
  const input = host.querySelector('#chatq');
  const form = host.querySelector('#chatform');

  function showEngine(engine, live, detail) {
    const chip = host.querySelector('#engine');
    chip.className = `engine-chip ${live ? 'is-live' : 'is-off'}`;
    chip.innerHTML = html`<span class="dot"></span> ${live ? `${ENGINE_LABEL[engine]} · live` : 'Offline matcher'}`.s;
    host.querySelector('#enginenote').innerHTML = !live && detail
      ? html`Claude isn't connected on this computer (${detail}), so answers come from the offline matcher and only cover our own records. Sign in to Claude Code once and restart the server.`.s
      : '';
  }
  api('/find/engine').then((e) => showEngine(e.engine, e.engine !== 'rules' && e.connected, e.engine === 'claude-local' ? e.detail : null)).catch(() => {});

  function bubble(role, inner) {
    const div = document.createElement('div');
    div.className = `msg msg-${role}`;
    div.innerHTML = inner;
    thread.appendChild(div);
    div.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return div;
  }

  async function send(text) {
    host.querySelector('#examples').hidden = true;
    history.push({ role: 'user', body: text });
    bubble('user', html`<p>${text}</p>`.s);
    const pending = bubble('bot', html`<div class="msg-who">Linchpin</div><div class="typing"><span class="spinner"></span><span class="typing-status">Thinking…</span></div><ol class="trail"></ol>`.s);
    const trail = pending.querySelector('.trail');
    const button = form.querySelector('button');
    button.disabled = true;
    input.value = '';
    try {
      const r = await findStream({ serial: serial ?? undefined, messages: history }, (status) => {
        pending.querySelector('.typing-status').textContent = status;
        const li = document.createElement('li');
        li.textContent = status;
        trail.appendChild(li);
      });
      history.push({ role: 'assistant', body: r.reply });
      const fell = r.notes.find((n) => /unavailable/.test(n));
      showEngine(r.engine, r.engine !== 'rules', fell ? (/not logged in|login/i.test(fell) ? 'Claude Code is not signed in' : 'Claude could not answer') : null);
      if (r.machine && !serial) serial = r.machine.serial;
      pending.innerHTML = botView(r, serial, trail.innerHTML).s;
      bindBot(pending);
      pending.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      history.pop();
      pending.innerHTML = html`<div class="msg-who">Linchpin</div>${errorBox(e)}`.s;
    } finally {
      button.disabled = false;
      input.focus();
    }
  }

  function bindBot(box) {
    box.querySelectorAll('[data-todesk]').forEach((b) => b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const message = history.map((h) => `${h.role === 'user' ? '' : 'Linchpin: '}${h.body}`).join('\n');
        const enq = await api('/enquiries', { method: 'POST', body: { channel: 'web', customerAccount: account ?? undefined, machineSerial: serial ?? undefined, message } });
        location.hash = `#/desk/${enq.id}`;
      } catch (err) { toast(err.message, 'danger'); b.disabled = false; }
    }));
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = input.value.trim();
    if (v) send(v); else input.focus();
  });
  host.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => send(b.dataset.ex)));
  if (first) send(first);
}

function botView(r, serial, trailHtml) {
  const best = r.candidates.find((c) => c.role === 'best');
  const options = r.candidates.filter((c) => c.role === 'option');
  const alts = r.candidates.filter((c) => c.role === 'alternative');
  const fellBack = r.notes.find((n) => /unavailable/.test(n));
  return html`
    <div class="msg-who">Linchpin <span class="msg-engine">${ENGINE_LABEL[r.engine] ?? r.engine}</span></div>
    ${r.machine ? html`<div class="msg-machine">${ic('check')} ${r.machine.make} ${r.machine.model} · <span class="mono">${r.machine.serial}</span></div>`
      : r.machineText ? html`<div class="msg-machine is-unknown">${r.machineText} · not on our machine records</div>` : ''}
    <p class="msg-text">${r.reply}</p>
    ${r.needsPerson ? html`<div class="msg-flag">${ic('alert')} <span>${r.needsPerson}.</span> <button class="btn btn-sm" type="button" data-todesk>Send to the parts desk</button></div>` : ''}

    ${best ? html`
      <div class="pcard">
        <div class="pcard-main">
          <span class="conf conf-${r.confidence}">${ic('check')} ${confidenceLabel[r.confidence]}</span>
          <div class="pcard-pn mono">${best.partNumber}</div>
          <div class="pcard-desc">${best.description}</div>
          <ul class="evidence evidence-sm">${best.evidence.map((ev) => html`<li><span class="ev-ico">${ic(EVIDENCE_ICON[ev.kind] ?? 'check')}</span><span>${ev.text}</span></li>`)}</ul>
        </div>
        <div class="pcard-side">
          <div class="price price-lg">${money(best.unitNetPence)}</div>
          ${stockLine(best)}
          <a class="btn btn-primary btn-lg btn-block" href="${partHref(best, serial)}">See it and fit it ${ic('arrow')}</a>
          <div class="found-has">${modelFor(best) ? html`<span class="tag tag-3d">3D</span>` : ''}${best.guide ? html`<span class="tag tag-guide">Fitting guide</span>` : ''}</div>
        </div>
      </div>` : ''}

    ${options.length ? html`<div class="choices">${options.map((c) => html`
      <a class="choice" href="${partHref(c, serial)}">
        <span class="choice-pn mono">${c.partNumber}</span>
        <span class="choice-desc">${c.description}</span>
        <span class="choice-foot"><span class="price">${money(c.unitNetPence)}</span>${stockLine(c)}</span>
        <span class="choice-go">This one ${ic('arrow')}</span>
      </a>`)}</div>` : ''}

    ${alts.length ? html`<div class="alts">${alts.map((a) => html`<span>${ic('swap')} Equivalent: <a class="mono" href="${partHref(a, serial)}">${a.partNumber}</a> ${a.description}</span>`)}</div>` : ''}

    ${r.web?.length ? html`
      <div class="webfind">
        <div class="webfind-head">${ic('alert')} <span>Found online, not yet confirmed. Not in our catalogue, so there's no price, stock or licensed fitting guide yet.</span></div>
        ${r.web.map((w) => html`
          <div class="webcard">
            <div><span class="webcard-make">${w.make}</span> <span class="mono webcard-pn">${w.partNumber}</span></div>
            <div class="webcard-desc">${w.description}</div>
            <p class="small muted">${w.note}</p>
            <a class="small" href="${w.source.url}" target="_blank" rel="noopener noreferrer">Source: ${w.source.title}</a>
          </div>`)}
        <button class="btn" type="button" data-todesk>Ask the parts desk to confirm and order</button>
      </div>` : ''}

    ${trailHtml ? html`<details class="trail-wrap"><summary>How Linchpin got here</summary><ol class="trail">${raw(trailHtml)}</ol></details>` : ''}
    ${fellBack ? html`<p class="small muted">${fellBack}</p>` : ''}`;
}

// ---- 3. the part ----------------------------------------------------------
const SKILL = { basic: 'Basic', competent: 'Competent', specialist: 'Specialist' };
const ROLE = { replaced: 'Replace', consumable: 'Consumable', may_need: 'May need' };

export async function renderPart(el, make, partNumber, serial) {
  el.innerHTML = loading().s;
  let card;
  try { card = await api(`/parts/${enc(make)}/${enc(partNumber)}/card?${qs({ serial })}`); } catch (e) { el.innerHTML = html`<a class="back" href="#/find">← Find a part</a>${errorBox(e)}`.s; return; }
  const p = card.part;
  const m = card.machine;
  let proc = null;
  let bulletins = [];
  try {
    const g = await api(`/guidance?${qs({ partNumber: p.partNumber, make: p.make, serial })}`);
    bulletins = g.procedures.filter((x) => x.source.kind === 'service_bulletin');
    proc = g.procedures.find((x) => x.id === p.guide?.procedureId) ?? g.procedures.find((x) => x.source.kind !== 'service_bulletin') ?? null;
  } catch { /* no licensed guidance for this part */ }
  const model = modelFor(p);
  const numbered = proc ? numberedParts(proc) : [];
  const jobHref = proc ? `#/field/job/${enc(p.make)}/${enc(p.partNumber)}/${proc.id}${serial ? `?serial=${enc(serial)}` : ''}` : null;
  const total = p.stock?.reduce((n, s) => n + s.available, 0);

  el.innerHTML = html`
    <div class="flow flow-wide">
      ${stepper(2)}
      <nav class="crumbs" aria-label="Breadcrumb"><a href="#/find">Find a part</a>${m ? html`<span>/</span><a href="#/find/m/${enc(m.serial)}">${m.make} ${m.model} · ${m.serial}</a>` : ''}<span>/</span><b class="mono">${p.partNumber}</b></nav>

      <header class="pp-head">
        <div class="pp-id">
          ${card.fitsMachine === true ? html`<span class="fit fit-yes">${ic('check')} Fits this ${m.model}</span>` : card.fitsMachine === false ? html`<span class="fit fit-no">${ic('alert')} Not in the parts book for ${m.serial}</span>` : ''}
          <h1 class="pp-pn mono">${p.partNumber}</h1>
          <p class="pp-desc">${p.description}</p>
          ${p.superseded ? html`<p class="pp-note">${ic('swap')} You asked for ${p.requested}. This is the current number${p.straightSwap ? ', a straight swap' : '; check the fitting changes'}.</p>` : ''}
          ${p.safetyCritical ? html`<p class="pp-safety">${ic('alert')} Safety-critical part: the parts desk confirms it before it's supplied.</p>` : ''}
        </div>
        <div class="pp-buy">
          <div class="price price-xl">${money(p.unitNetPence)}</div>
          <div class="muted small">${p.priceBasis ?? ''}${m?.customer ? ` · ${m.customer}` : ''}</div>
          ${p.stock ? html`<ul class="depots">${p.stock.length ? p.stock.map((s) => html`<li><span>${s.depot}</span><b>${s.available}</b></li>`) : html`<li class="bad">Out of stock at every depot</li>`}</ul>` : ''}
          <div class="pp-actions">
            ${jobHref ? html`<a class="btn btn-primary btn-lg" href="${jobHref}">${ic('wrench')} Start fitting, step by step</a>` : ''}
            <a class="btn btn-lg" href="#/counter/${enc(p.make)}/${enc(p.partNumber)}">${ic('box')} Order at the counter</a>
          </div>
          ${total === 0 ? html`<p class="small bad">None in stock: the counter can order it in.</p>` : ''}
        </div>
      </header>

      <div class="pp-main">
        <section class="pp-viewer">
          <div class="viewer-tabs" role="tablist">
            ${model ? html`<button role="tab" class="on" data-tab="3d">3D exploded</button>` : ''}
            ${proc ? html`<button role="tab" class="${model ? '' : 'on'}" data-tab="diagram">Parts diagram</button>` : ''}
          </div>
          <div class="viewer-body">
            ${model ? html`<div class="viewer-pane" data-pane="3d">
              <div id="m3d" class="m3d-host"><div class="m3d-loading"><span class="spinner"></span> Loading 3D view…</div></div>
              <div class="viewer-ctrl">
                <label class="explode"><span>Assembled</span><input id="explode" type="range" min="0" max="100" value="0" aria-label="Explode the assembly"><span>Exploded</span></label>
                <button class="btn btn-sm" type="button" id="vstyle">Manual style</button>
              </div>
            </div>` : ''}
            ${proc ? html`<div class="viewer-pane" data-pane="diagram" ${model ? 'hidden' : ''}>${diagramFigure(proc, numbered)}</div>` : ''}
            ${!model && !proc ? html`<div class="viewer-empty">${ic('box')}<p>No 3D model or diagram for this part yet.</p><p class="muted small">They're added when the manufacturer licenses the parts-book figure or CAD.</p></div>` : ''}
          </div>
          <p class="viewer-note">${model ? 'Illustration for orientation: invented demo geometry, not to scale. ' : ''}${proc ? `Specs come only from ${proc.source.docRef}.` : ''}</p>
        </section>

        <section class="pp-fit">
          <details class="why" open>
            <summary><h2>Why this is the right part</h2></summary>
            <ul class="evidence">${p.evidence.map((ev) => html`<li><span class="ev-ico">${ic(EVIDENCE_ICON[ev.kind] ?? 'check')}</span><span>${ev.text}${ev.ref ? html` <span class="muted mono small">${ev.ref}</span>` : ''}</span></li>`)}${!p.evidence.length ? html`<li class="muted">Pick a machine to check it fits.</li>` : ''}</ul>
          </details>

          ${bulletins.map((b) => html`<div class="bulletin">${ic('alert')}<div><b>Service bulletin ${b.code}</b><p>${b.summary}</p></div></div>`)}

          ${proc ? html`
            <div class="fit-head">
              <div>
                <span class="eyebrow">How to fit it</span>
                <h2>${proc.title}</h2>
                <div class="fit-meta"><span>${ic('clock')} ${proc.estMinutes} min</span><span>${SKILL[proc.skill] ?? proc.skill}</span><span>${ic('book')} ${proc.source.document} · <span class="mono">${proc.source.docRef}</span>${proc.source.revision ? ` ${proc.source.revision}` : ''} · pp. ${proc.pages}</span></div>
              </div>
            </div>
            <p class="licence small muted">Published by ${proc.source.publisher} under licence ${proc.licence.reference ?? proc.licence.title}. Checked by the workshop.</p>
            ${proc.safety.length ? html`<div class="safety-box"><b>${ic('alert')} Before you start</b><ul>${proc.safety.map((s) => html`<li>${s}</li>`)}</ul></div>` : ''}
            <div class="fit-cols">
              ${proc.tools.length ? html`<div><h3>Tools</h3><ul class="plain tick">${proc.tools.map((t) => html`<li>${t}</li>`)}</ul></div>` : ''}
              <div><h3>Parts for this job</h3><ul class="plain dg-parts">${numbered.map((x) => html`<li data-n="${x.n}"><span class="dg-n">${x.n}</span><span class="role role-${x.role}">${ROLE[x.role] ?? x.role}</span> <span class="mono">${x.partNumber}</span> × ${x.qty}</li>`)}</ul></div>
            </div>
            <h3 class="steps-title">Steps <span class="muted">· tap a step to see it in 3D</span></h3>
            <ol class="fsteps">${proc.steps.map((s) => html`
              <li class="fstep" tabindex="0" data-i="${s.seq}">
                <span class="fstep-n">${s.seq}</span>
                <div class="fstep-body">
                  <p>${s.instruction}</p>
                  ${s.caution ? html`<p class="fstep-caution">${ic('alert')} ${s.caution}</p>` : ''}
                  ${s.specs?.length ? html`<div class="fstep-specs">${s.specs.map((sp) => html`<span class="spec"><span class="spec-label">${sp.label}</span><span class="spec-val">${sp.value}${sp.unit ? ` ${sp.unit}` : ''}</span></span>`)}</div>` : ''}
                </div>
                ${s.page ? html`<span class="fstep-page mono" title="Page in ${proc.source.docRef}">p.${s.page}</span>` : ''}
              </li>`)}</ol>
            ${jobHref ? html`<a class="btn btn-primary btn-xl btn-block" href="${jobHref}">${ic('wrench')} Start fitting, step by step</a>` : ''}`
          : html`<div class="noguide"><h2>No fitting guide yet</h2><p class="muted">No licensed manufacturer procedure covers this part yet. Ask the workshop, or flag it so the content team can source one.</p></div>`}
        </section>
      </div>
    </div>`.s;

  if (proc) bindDiagram(el.querySelector('.pp-main'));

  // Tabs
  el.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    el.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('on', x === b));
    el.querySelectorAll('[data-pane]').forEach((x) => { x.hidden = x.dataset.pane !== b.dataset.tab; });
  }));

  // 3D viewer, loaded on demand.
  let viewer = null;
  if (model) {
    const host = el.querySelector('#m3d');
    import('./model3d.js').then((mod) => mod.mount(host, model, { partNumber: p.partNumber })).then((v) => {
      viewer = v;
      const slider = el.querySelector('#explode');
      slider.addEventListener('input', () => viewer.explode(Number(slider.value) / 100));
      el.querySelector('#vstyle').addEventListener('click', (e) => {
        const manual = e.target.textContent === 'Manual style';
        viewer.setStyle(manual ? 'manual' : 'shaded');
        e.target.textContent = manual ? 'Shaded' : 'Manual style';
      });
      setTimeout(() => { if (Number(slider.value) === 0) { viewer.explode(0.6); slider.value = '60'; } }, 900);
    }).catch((e) => {
      host.innerHTML = html`<div class="viewer-empty"><p>The 3D view needs a connection the first time (it loads three.js).</p><p class="muted small">${e.message}</p></div>`.s;
    });
  }

  // Steps drive the 3D view.
  el.querySelectorAll('.fstep').forEach((li) => {
    const go = () => {
      el.querySelectorAll('.fstep').forEach((x) => x.classList.toggle('on', x === li));
      if (viewer) {
        viewer.step(li.querySelector('.fstep-body p').textContent);
        const s = el.querySelector('#explode');
        if (s) s.value = '0';
        el.querySelector('[data-tab="3d"]')?.click();
      }
    };
    li.addEventListener('click', go);
    li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });

  return () => viewer?.dispose();
}
