// Find a part: the parts desk (concept 1 + 3).
//   queue of enquiries (stopped machines first) | the conversation and draft
//   reply | the best match with its evidence | the machine and "hand to a person"
// The agent only proposes; every part, price, stock line and piece of
// evidence on this screen comes from our data via the API.
import { api, date, errorBox, html, loading, money, raw, toast } from './lib.js';

const CHANNEL = { counter: 'Counter', phone: 'Phone', whatsapp: 'WhatsApp', email: 'Email', web: 'Web' };
const STATUS = { open: 'Working', waiting_customer: 'Waiting on customer', callback: 'Callback', resolved: 'Resolved', closed: 'Closed' };
const CONF = {
  high: { label: 'Sure', cls: 'conf-high' },
  medium: { label: 'Likely', cls: 'conf-med' },
  low: { label: 'Not sure', cls: 'conf-low' },
};
const EV_ICON = {
  number: '<path d="M5 9h14M5 15h14M10 4L8 20M16 4l-2 16"/>',
  parts_book: '<path d="M4 4h12l4 4v12H4z"/><path d="M8 12h8M8 16h5"/>',
  supersession: '<path d="M4 12h14M13 6l6 6-6 6"/>',
  history: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l3 2"/>',
  described: '<path d="M4 6h16M4 12h10M4 18h7"/>',
  equivalent: '<path d="M7 7h10M7 17h10M4 12h16"/>',
};
const icon = (kind) => raw(`<svg class="ev-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">${EV_ICON[kind] ?? EV_ICON.described}</svg>`);

let queueTimer;

/** Top-bar badge: open enquiries. */
export async function refreshCount(list) {
  const badge = document.getElementById('enquiry-count');
  if (!badge) return;
  try {
    const q = list ?? (await api('/enquiries'));
    badge.textContent = q.length;
    badge.hidden = !q.length;
  } catch { badge.hidden = true; }
}

export async function render(el, id) {
  el.innerHTML = html`
    <div class="desk">
      <nav class="desk-queue" aria-label="Enquiries"><div id="queue">${loading()}</div></nav>
      <section class="desk-convo" aria-label="Conversation" id="convo"></section>
      <section class="desk-match" aria-label="Best match" id="match"></section>
      <aside class="desk-side" aria-label="Machine and hand-over" id="side"></aside>
    </div>`.s;

  const state = { id: id && id !== 'new' ? id : null, enquiry: null, queue: [] };

  async function loadQueue() {
    try {
      state.queue = await api('/enquiries');
      refreshCount(state.queue);
      drawQueue();
    } catch (e) {
      el.querySelector('#queue').innerHTML = errorBox(e).s;
    }
  }

  function drawQueue() {
    const q = state.queue;
    el.querySelector('#queue').innerHTML = html`
      <div class="q-head">
        <span class="q-title">Enquiries <span class="q-n">${q.length}</span></span>
        <a class="btn btn-accent btn-sm" href="#/desk/new">New</a>
      </div>
      <ul class="q-list">${q.map((e) => html`
        <li><a class="q-item ${e.id === state.id ? 'is-active' : ''} ${e.priority === 'vor' ? 'is-vor' : ''}" href="#/desk/${e.id}">
          <span class="q-top">
            <span class="q-status">${e.priority === 'vor' ? 'Machine stopped' : STATUS[e.status] ?? e.status}</span>
            <span class="q-time mono">${timer(e)}</span>
          </span>
          <strong class="q-who">${e.customer ?? e.contactName ?? 'New customer'}${e.machine ? html` · ${e.machine.model}` : ''}</strong>
          <span class="q-subject">${e.subject}</span>
          ${e.bestPart ? html`<span class="q-part mono">${e.bestPart}</span>` : ''}
        </a></li>`)}
      </ul>
      ${q.length ? '' : html`<p class="q-empty">No open enquiries. Start one with <strong>New</strong>.</p>`}
      <p class="q-keys"><kbd>J</kbd> <kbd>K</kbd> move · <kbd>N</kbd> new</p>`.s;
  }

  async function loadEnquiry() {
    if (!state.id) return;
    try {
      state.enquiry = await api(`/enquiries/${state.id}`);
      drawEnquiry();
    } catch (e) {
      el.querySelector('#convo').innerHTML = errorBox(e).s;
    }
  }

  // ---- empty / new ---------------------------------------------------------
  function drawEmpty() {
    el.querySelector('#convo').innerHTML = html`
      <div class="desk-empty">
        <h1>Find the right part</h1>
        <p class="muted">Pick an enquiry from the queue, or start one with what the customer said. Linchpin works out the machine and the part, shows its evidence, and hands over to a person when it isn't sure.</p>
        <a class="btn btn-primary btn-lg" href="#/desk/new">Start an enquiry</a>
      </div>`.s;
    el.querySelector('#match').innerHTML = '';
    el.querySelector('#side').innerHTML = '';
  }

  function drawNew() {
    el.querySelector('#convo').innerHTML = html`
      <form class="new-enq" id="new-enq">
        <h1>New enquiry</h1>
        <label class="fld">Customer
          <input class="input" name="customer" list="cust-list" placeholder="Name or account code" autocomplete="off">
          <datalist id="cust-list"></datalist>
        </label>
        <div class="fld-row">
          <label class="fld">How they got in touch
            <select class="input" name="channel">${Object.entries(CHANNEL).map(([k, v]) => html`<option value="${k}" ${k === 'phone' ? 'selected' : ''}>${v}</option>`)}</select>
          </label>
          <label class="fld">Name on the call<input class="input" name="contact" placeholder="e.g. Tom"></label>
        </div>
        <label class="fld">What did they say?
          <textarea class="input" name="message" rows="4" required minlength="2" placeholder="e.g. Need the oil filter for the 165, the one low down by the starter"></textarea>
        </label>
        <label class="vor-toggle"><input type="checkbox" name="vor"> <span><strong>Machine stopped (VOR)</strong><br><span class="muted small">Goes to the top of the queue. Callback within 15 minutes if Linchpin hands over.</span></span></label>
        <div class="actions"><button class="btn btn-primary btn-lg" type="submit">Find the part</button><a class="btn btn-lg" href="#/desk">Cancel</a></div>
      </form>`.s;
    el.querySelector('#match').innerHTML = html`<div class="match-hint"><h2>What Linchpin checks</h2><ul class="plain hint-list"><li>Which machine: serial, reg, or the customer's machines</li><li>The parts book for that machine and serial</li><li>Old numbers and what replaced them</li><li>What this customer bought before</li><li>The fitting guide and what's usually needed with it</li></ul></div>`.s;
    el.querySelector('#side').innerHTML = '';
    const f = el.querySelector('#new-enq');
    const dl = f.querySelector('#cust-list');
    let t;
    f.customer.addEventListener('input', () => {
      clearTimeout(t);
      const q = f.customer.value.trim();
      if (q.length < 2) return;
      t = setTimeout(async () => {
        try {
          const cs = await api(`/customers?q=${encodeURIComponent(q)}`);
          dl.innerHTML = html`${cs.map((c) => html`<option value="${c.accountCode}">${c.name}</option>`)}`.s;
        } catch { /* typing offline: ignore */ }
      }, 200);
    });
    f.message.focus();
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = f.querySelector('[type=submit]');
      btn.disabled = true;
      btn.textContent = 'Checking the catalogue…';
      const account = f.customer.value.trim().split(/\s/)[0]?.toUpperCase();
      try {
        const r = await api('/enquiries', { method: 'POST', body: {
          channel: f.channel.value, message: f.message.value.trim(), priority: f.vor.checked ? 'vor' : 'normal',
          ...(account ? { customerAccount: account } : {}), ...(f.contact.value.trim() ? { contactName: f.contact.value.trim() } : {}),
        } });
        location.hash = `#/desk/${r.id}`;
      } catch (err) {
        btn.disabled = false;
        btn.textContent = 'Find the part';
        toast(err.message, 'danger');
      }
    });
  }

  // ---- one enquiry ---------------------------------------------------------
  function drawEnquiry() {
    const e = state.enquiry;
    const r = e.result;
    const closed = e.status === 'resolved' || e.status === 'closed';
    el.querySelector('#convo').innerHTML = html`
      <header class="convo-head">
        <div>
          <h1 class="convo-who">${e.customer?.name ?? e.contactName ?? 'New customer'}</h1>
          <div class="muted small">${CHANNEL[e.channel] ?? e.channel}${e.contactName ? ` · ${e.contactName}` : ''}${e.customer ? ` · ${e.customer.accountCode}` : ''} · <span class="mono">${e.ref}</span></div>
        </div>
        <span class="pill st-${e.status} ${e.priority === 'vor' ? 'st-vor' : ''}">${e.priority === 'vor' && !closed ? 'Machine stopped' : STATUS[e.status]}</span>
      </header>
      <ol class="msgs">${e.messages.map((m) => m.role === 'system'
        ? html`<li class="msg-sys">${m.body}</li>`
        : html`<li class="msg msg-${m.role}"><div class="bubble">${m.body}</div><div class="msg-meta">${m.role === 'customer' ? (m.author ?? 'Customer') : m.author ?? 'You'} · ${time(m.at)}</div></li>`)}
      </ol>
      ${!closed && r ? html`
        <form class="draft" id="draft">
          <div class="draft-head"><span class="lbl lbl-brand">Draft reply</span><span class="muted small">Linchpin wrote this from the checked parts. Edit before sending.</span></div>
          <textarea class="input" name="body" rows="4">${r.reply}</textarea>
          <div class="actions"><button class="btn btn-primary" type="submit">Send reply</button></div>
        </form>` : ''}
      ${!closed ? html`
        <form class="said" id="said">
          <label class="lbl" for="said-body">Customer said</label>
          <div class="said-row">
            <input id="said-body" class="input" name="body" placeholder="Type what they said next, e.g. the outer one" autocomplete="off">
            <button class="btn" type="submit">Add</button>
          </div>
        </form>` : html`<div class="resolved-note">Resolved${e.resolvedPart ? html` with <strong class="mono">${e.resolvedPart.partNumber}</strong>` : ''}${e.resolution ? html`: ${e.resolution}` : ''}</div>`}`.s;

    drawMatch();
    drawSide();
    bindEnquiry();
    const msgs = el.querySelector('.msgs');
    msgs.scrollTop = msgs.scrollHeight;
  }

  function drawMatch() {
    const e = state.enquiry;
    const r = e.result;
    const box = el.querySelector('#match');
    if (!r) { box.innerHTML = loading().s; return; }
    const best = r.candidates.find((c) => c.role === 'best');
    const options = r.candidates.filter((c) => c.role === 'option');
    const alts = r.candidates.filter((c) => c.role === 'alternative');
    const conf = CONF[r.confidence] ?? CONF.low;
    const closed = e.status === 'resolved' || e.status === 'closed';
    box.innerHTML = html`
      ${e.status === 'callback' ? html`
        <div class="handover">
          <div><span class="lbl lbl-night">With a person</span><strong>${e.assignedTo ?? 'Parts team'} rings back by ${time(e.callbackDueAt)}</strong><div class="small">${e.callbackReason}</div></div>
          <span class="mono handover-t">${countdown(e.callbackDueAt)}</span>
        </div>` : ''}
      ${r.question && !best ? html`
        <div class="question">
          <span class="lbl lbl-brand">One question</span>
          <p class="question-text">${r.question}</p>
          <p class="muted small">Both fit this machine. Ask the customer, then tap the one they mean or type their answer.</p>
        </div>
        <div class="opt-grid">${options.map((c) => html`
          <article class="opt">
            <div class="mono opt-pn">${c.partNumber}</div>
            <div>${c.description}</div>
            ${evidenceList(c.evidence.filter((x) => x.kind !== 'described'))}
            <div class="opt-foot"><span class="price">${money(c.unitNetPence)}</span>${stockLine(c)}</div>
            ${closed ? '' : html`<button class="btn btn-block" type="button" data-pick="${c.description}">Customer means this one</button>`}
          </article>`)}
        </div>` : ''}
      ${best ? html`
        <article class="best">
          <div class="best-top">
            <div>
              <span class="lbl">Best match</span>
              <div class="mono best-pn">${best.partNumber}</div>
              <div class="best-desc">${best.description}</div>
              ${best.requested ? html`<div class="muted small">Asked for <span class="mono">${best.requested}</span></div>` : ''}
            </div>
            <div class="best-right">
              <span class="conf ${conf.cls}">${r.confidence === 'high' ? raw('<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.6" aria-hidden="true"><path d="M5 12l4 4 10-10"/></svg>') : ''}${conf.label}${best.evidence.length ? `: ${sources(best)} agree` : ''}</span>
              <div class="price-big">${money(best.unitNetPence)}</div>
              <div class="muted small">${best.priceBasis ?? ''} · ex VAT</div>
            </div>
          </div>
          ${best.warning ? html`<div class="alert alert-warn">${best.warning}</div>` : ''}
          ${evidenceList(best.evidence)}
          <div class="best-foot">
            ${closed ? '' : html`<button class="btn btn-primary" type="button" data-resolve="${best.make}|${best.partNumber}">Resolve with this part</button>`}
            ${best.guide && e.machine ? html`<a class="btn" href="#/field/guide/${encodeURIComponent(best.make)}/${encodeURIComponent(best.partNumber)}?serial=${encodeURIComponent(e.machine.serial)}">How to fit it</a>` : ''}
            <span class="best-stock">${stockLine(best)}</span>
          </div>
        </article>
        <div class="mini-grid">
          ${best.withIt?.length ? html`<section class="mini"><span class="lbl">Usually needed with it</span><ul class="plain">${best.withIt.map((w) => html`<li><span class="mono">${w.partNumber}</span> ${w.description ?? ''} <span class="muted small">× ${w.qty}</span></li>`)}</ul></section>` : ''}
          ${alts.length ? html`<section class="mini"><span class="lbl">Alternatives</span><ul class="plain">${alts.map((a) => html`<li><span class="mono">${a.partNumber}</span> ${a.description}<div class="small ${a.evidence[0]?.text.startsWith('Verified') ? 'muted' : 'warn-text'}">${a.evidence[0]?.text ?? ''}</div></li>`)}</ul></section>` : ''}
          ${options.length ? html`<section class="mini"><span class="lbl">Also considered</span><ul class="plain">${options.map((o) => html`<li><span class="mono">${o.partNumber}</span> ${o.description}</li>`)}</ul></section>` : ''}
        </div>` : ''}
      ${!best && !options.length ? html`<div class="match-hint"><h2>No part yet</h2><p class="muted">${r.question ?? 'Linchpin needs more to go on. Ask for the machine serial, the number on the old part, or a photo.'}</p></div>` : ''}
      <details class="why">
        <summary>How Linchpin got here <span class="muted small">· ${r.engine === 'claude' ? 'Claude agent' : 'offline matcher'} · ${time(r.at)}</span></summary>
        <ul>${r.notes.map((n) => html`<li>${n}</li>`)}${r.notes.length ? '' : html`<li>Matched directly from the conversation.</li>`}</ul>
      </details>`.s;
  }

  function drawSide() {
    const e = state.enquiry;
    const best = e.result?.candidates.find((c) => c.role === 'best');
    const m = e.machine;
    const closed = e.status === 'resolved' || e.status === 'closed';
    el.querySelector('#side').innerHTML = html`
      <section class="side-card">
        <span class="lbl">Machine</span>
        ${m ? html`
          <div class="side-model">${m.make} ${m.model}</div>
          <div class="mono">${m.serial}</div>
          <dl class="side-facts">
            <div><dt>Year</dt><dd>${m.year ?? '–'}</dd></div>
            <div><dt>Hours</dt><dd>${m.engineHours != null ? m.engineHours.toLocaleString('en-GB') : '–'}</dd></div>
            ${m.regNo ? html`<div><dt>Reg</dt><dd>${m.regNo}</dd></div>` : ''}
            ${m.site ? html`<div class="wide"><dt>Where</dt><dd>${m.site}</dd></div>` : ''}
          </dl>` : html`
          <p class="muted small">Not identified yet.</p>
          ${e.customerMachines.length ? html`<div class="small">Their machines:</div><ul class="plain small">${e.customerMachines.map((x) => html`<li>${x.make} ${x.model} <span class="mono muted">${x.serial}</span></li>`)}</ul>` : ''}`}
        ${best?.bulletins?.length ? best.bulletins.map((b) => html`<div class="bulletin"><strong>Service bulletin ${b.code}:</strong> ${b.summary ?? b.title}</div>`) : ''}
      </section>
      ${best?.guide ? html`
        <section class="side-card">
          <span class="lbl">How to fit it</span>
          <div class="side-guide">${best.guide.title}</div>
          <div class="muted small">${best.guide.estMinutes ? `${best.guide.estMinutes} min · ` : ''}manual pp. ${best.guide.pages ?? '–'} · verified by the workshop</div>
          ${m ? html`<a class="btn btn-sm" href="#/field/guide/${encodeURIComponent(best.make)}/${encodeURIComponent(best.partNumber)}?serial=${encodeURIComponent(m.serial)}">Open the guide</a>` : ''}
        </section>` : ''}
      ${e.customer ? html`
        <section class="side-card">
          <span class="lbl">Customer</span>
          <div><strong>${e.customer.name}</strong></div>
          <div class="small muted">${e.customer.accountCode} · price band ${e.customer.priceBand}</div>
          ${e.customer.phone ? html`<a class="small" href="tel:${e.customer.phone}">${e.customer.phone}</a>` : ''}
        </section>` : ''}
      ${!closed && e.status !== 'callback' ? html`
        <form class="side-card side-night" id="handover">
          <span class="lbl lbl-night">Not sure?</span>
          <p class="small">Hand it to a person with the whole conversation and what's been ruled out. ${e.priority === 'vor' ? 'Machine stopped: callback within 15 minutes.' : 'Callback within the hour.'}</p>
          <input class="input input-night" name="assignee" placeholder="Who rings back, e.g. Dave" aria-label="Who rings back">
          <input class="input input-night" name="reason" placeholder="Why, e.g. customer unsure which model" aria-label="Reason" required minlength="3">
          <button class="btn btn-accent btn-block" type="submit">Hand to a person</button>
        </form>` : ''}`.s;
  }

  function bindEnquiry() {
    const e = state.enquiry;
    el.querySelector('#draft')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = ev.target.body.value.trim();
      if (!body) return;
      busy(ev.target, true);
      try {
        state.enquiry = await api(`/enquiries/${e.id}/replies`, { method: 'POST', body: { body } });
        toast('Reply sent');
        drawEnquiry();
        loadQueue();
      } catch (err) { busy(ev.target, false); toast(err.message, 'danger'); }
    });
    el.querySelector('#said')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      await customerSaid(ev.target.body.value.trim(), ev.target);
    });
    el.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => customerSaid(`The ${b.dataset.pick.toLowerCase()}`, b.closest('article'))));
    el.querySelector('[data-resolve]')?.addEventListener('click', async (ev) => {
      const [make, partNumber] = ev.target.dataset.resolve.split('|');
      ev.target.disabled = true;
      try {
        const r = await api(`/enquiries/${e.id}/resolve`, { method: 'POST', body: { make, partNumber } });
        state.enquiry = r;
        toast(r.learnedFitment ? `Resolved. ${partNumber} added to this model's parts list.` : `Resolved with ${partNumber}`);
        drawEnquiry();
        loadQueue();
      } catch (err) { ev.target.disabled = false; toast(err.message, 'danger'); }
    });
    el.querySelector('#handover')?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const f = ev.target;
      busy(f, true);
      try {
        state.enquiry = await api(`/enquiries/${e.id}/callback`, { method: 'POST', body: { reason: f.reason.value.trim(), ...(f.assignee.value.trim() ? { assignee: f.assignee.value.trim() } : {}) } });
        toast(`Handed to ${state.enquiry.assignedTo}`);
        drawEnquiry();
        loadQueue();
      } catch (err) { busy(f, false); toast(err.message, 'danger'); }
    });
  }

  async function customerSaid(text, formEl) {
    if (!text) return;
    busy(formEl, true);
    el.querySelector('#match').classList.add('is-thinking');
    try {
      state.enquiry = await api(`/enquiries/${state.enquiry.id}/messages`, { method: 'POST', body: { body: text } });
      drawEnquiry();
      loadQueue();
    } catch (err) { busy(formEl, false); toast(err.message, 'danger'); } finally {
      el.querySelector('#match')?.classList.remove('is-thinking');
    }
  }

  // ---- keys and polling ------------------------------------------------------
  const onKey = (ev) => {
    if (ev.target.closest('input, textarea, select') || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const i = state.queue.findIndex((q) => q.id === state.id);
    if (ev.key === 'j' && state.queue.length) location.hash = `#/desk/${state.queue[Math.min(state.queue.length - 1, i + 1)].id}`;
    if (ev.key === 'k' && state.queue.length) location.hash = `#/desk/${state.queue[Math.max(0, i - 1)].id}`;
    if (ev.key === 'n') { ev.preventDefault(); location.hash = '#/desk/new'; }
    if (ev.key === '/') { ev.preventDefault(); el.querySelector('#said-body')?.focus(); }
  };
  addEventListener('keydown', onKey);
  clearInterval(queueTimer);
  queueTimer = setInterval(() => { if (document.visibilityState === 'visible') loadQueue(); }, 30_000);

  if (id === 'new') drawNew();
  else if (!state.id) drawEmpty();
  await loadQueue();
  if (!state.id && id !== 'new' && state.queue.length && matchMedia('(min-width: 1100px)').matches) {
    history.replaceState(null, '', `#/desk/${state.queue[0].id}`);
    state.id = state.queue[0].id;
    drawQueue();
  }
  await loadEnquiry();
  return () => { removeEventListener('keydown', onKey); clearInterval(queueTimer); };
}

// ---- small helpers ----------------------------------------------------------
function evidenceList(list) {
  if (!list?.length) return '';
  return html`<ul class="ev-list">${list.map((x) => html`<li class="ev"><span class="ev-ico">${icon(x.kind)}</span><span>${x.text}${x.ref ? html` <span class="mono ev-ref">${x.ref}</span>` : ''}</span></li>`)}</ul>`;
}

function sources(c) {
  const n = new Set(c.evidence.map((x) => x.kind)).size;
  return `${n} source${n === 1 ? '' : 's'}`;
}

function stockLine(c) {
  if (!c.stock) return '';
  if (!c.stock.length) return html`<span class="small muted">None in stock</span>`;
  return html`<span class="small"><span class="ok"><strong>${c.stock[0].available} at ${c.stock[0].depot}</strong></span>${c.stock.slice(1, 3).map((s) => ` · ${s.available} at ${s.depot}`).join('')}</span>`;
}

function busy(form, on) {
  form?.querySelectorAll('button, input, textarea').forEach((x) => { x.disabled = on; });
}

const time = (d) => (d ? new Date(d).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) : '–');

function countdown(d) {
  if (!d) return '';
  const mins = Math.round((new Date(d).getTime() - Date.now()) / 60_000);
  return mins >= 0 ? `${mins} min` : `${-mins} min late`;
}

function timer(e) {
  if (e.status === 'callback' && e.callbackDueAt) return countdown(e.callbackDueAt);
  const mins = Math.round((Date.now() - new Date(e.updatedAt).getTime()) / 60_000);
  if (mins < 60) return `${mins} min`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h`;
  return date(e.updatedAt);
}
