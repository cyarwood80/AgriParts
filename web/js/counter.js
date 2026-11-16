import { api, debounce, errorBox, html, loading, money, partLink, pct, qs, store, toast } from './lib.js';

// Survives re-renders when the hash changes to a part.
const state = { q: '', results: [], active: -1 };

const basket = {
  get: () => store.get('ap.basket', []),
  set: (b) => store.set('ap.basket', b),
};

export async function render(el, { make, partNumber }) {
  const customer = store.get('ap.customer');
  el.innerHTML = html`
    <header class="page-head">
      <div>
        <h1>Parts counter</h1>
        <p class="muted">Any number format, typos, barcodes or words. Press <kbd>/</kbd> to search.</p>
      </div>
      <div class="ctx-bar">
        <div class="field-inline cust-picker">
          <label for="cust">Customer</label>
          <div class="combo">
            <input id="cust" class="input" placeholder="Account, name, postcode…" autocomplete="off" value="${customer ? `${customer.accountCode} · ${customer.name}` : ''}">
            <div id="cust-list" class="combo-list" hidden></div>
          </div>
        </div>
        <div class="field-inline">
          <label for="depot">Depot</label>
          <select id="depot" class="input"></select>
        </div>
      </div>
    </header>
    ${customer?.onStop ? html`<div class="alert alert-danger">${customer.name} is <strong>on stop</strong>. Quotes are allowed; confirming needs a manager.</div>` : ''}
    <div class="counter-grid">
      <section class="panel search-panel">
        <div class="search-box">
          <span class="search-ico">⌕</span>
          <input id="q" class="input input-lg" placeholder="e.g. acm 10021, flail hamer, 5012345678901" autocomplete="off" spellcheck="false" value="${state.q}">
        </div>
        <ul id="results" class="results" role="listbox"></ul>
      </section>
      <section id="detail" class="panel detail-panel">
        ${partNumber ? loading() : html`<div class="empty"><div class="empty-ico">⌕</div><p>Search for a part to see supersessions, stock at every depot, this customer's price and the fitting guide.</p></div>`}
      </section>
      <aside id="basket" class="panel basket-panel"></aside>
    </div>`.s;

  const $ = (s) => el.querySelector(s);

  // ---- depots
  api('/depots').then((ds) => {
    const cur = store.get('ap.depot', 'HQ');
    $('#depot').innerHTML = ds.map((d) => html`<option value="${d.code}" ${d.code === cur ? 'selected' : ''}>${d.code} · ${d.name}</option>`).join('');
  }).catch(() => {});
  $('#depot').addEventListener('change', (e) => { store.set('ap.depot', e.target.value); if (partNumber) showDetail(); });

  // ---- customer picker
  const custInput = $('#cust');
  const custList = $('#cust-list');
  custInput.addEventListener('focus', () => custInput.select());
  custInput.addEventListener('input', debounce(async () => {
    const q = custInput.value.trim();
    if (q.length < 2) { custList.hidden = true; return; }
    const rows = await api(`/customers?${qs({ q })}`).catch(() => []);
    custList.innerHTML = rows.length
      ? rows.map((c, i) => html`<button type="button" class="combo-item" data-i="${i}"><strong>${c.accountCode}</strong> ${c.name} <span class="muted">${c.postcode ?? ''} · ${c.priceBand}</span>${c.onStop ? html` <span class="pill pill-cancelled">On stop</span>` : ''}</button>`).join('')
      : '<div class="combo-empty">No match</div>';
    custList.hidden = false;
    custList.querySelectorAll('.combo-item').forEach((b) => b.addEventListener('mousedown', () => {
      store.set('ap.customer', rows[Number(b.dataset.i)]);
      render(el, { make, partNumber });
    }));
  }));
  custInput.addEventListener('blur', () => setTimeout(() => { custList.hidden = true; }, 150));

  // ---- search
  const qEl = $('#q');
  const resultsEl = $('#results');
  const drawResults = () => {
    if (state.q.trim().length < 2) {
      resultsEl.innerHTML = html`<li class="results-hint">Try <a href="#" data-try="acm 10021">acm 10021</a> (superseded twice), <a href="#" data-try="NFB2210">NFB2210</a> (fitting changes) or <a href="#" data-try="flail hamer">flail hamer</a> (typo).</li>`.s;
      resultsEl.querySelectorAll('[data-try]').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); qEl.value = a.dataset.try; doSearch(); }));
      return;
    }
    if (!state.results.length) { resultsEl.innerHTML = '<li class="results-hint">No active parts match. Superseded numbers resolve when you press Enter.</li>'; return; }
    resultsEl.innerHTML = state.results.map((r, i) => html`
      <li role="option" class="result ${i === state.active ? 'active' : ''} ${r.make === make && r.partNumber === partNumber ? 'current' : ''}" data-i="${i}">
        <span class="make-badge make-${r.make}">${r.make}</span>
        <span class="result-main"><strong class="mono">${r.partNumber}</strong><span>${r.description}</span></span>
        <span class="result-price">${money(r.listPricePence)}</span>
      </li>`).join('');
    resultsEl.querySelectorAll('.result').forEach((li) => li.addEventListener('click', () => open(state.results[Number(li.dataset.i)])));
  };
  const open = (r) => { location.hash = partLink(r.make, r.partNumber); };
  const doSearch = async () => {
    state.q = qEl.value;
    state.active = -1;
    if (state.q.trim().length < 2) { state.results = []; drawResults(); return; }
    try { state.results = await api(`/parts?${qs({ q: state.q.trim(), limit: 15 })}`); } catch { state.results = []; }
    drawResults();
  };
  qEl.addEventListener('input', debounce(doSearch, 150));
  qEl.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = state.results.length;
      if (!n) return;
      state.active = (state.active + (e.key === 'ArrowDown' ? 1 : -1) + n) % n;
      drawResults();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (state.active >= 0) open(state.results[state.active]);
      else if (state.results.length === 1) open(state.results[0]);
      else if (state.q.trim()) location.hash = partLink('_', state.q.trim()); // resolve directly (superseded numbers)
    }
  });
  drawResults();
  if (!partNumber) qEl.focus();

  const onKey = (e) => {
    if (e.key === '/' && document.activeElement?.tagName !== 'INPUT') { e.preventDefault(); qEl.focus(); qEl.select(); }
  };
  addEventListener('keydown', onKey);

  // ---- detail
  async function showDetail() {
    const detail = $('#detail');
    const m = make === '_' ? undefined : make;
    const cust = store.get('ap.customer');
    try {
      const [d, price, guide] = await Promise.all([
        api(`/parts/resolve?${qs({ partNumber, make: m })}`),
        cust ? api(`/prices?${qs({ partNumber, make: m, customer: cust.accountCode })}`).catch(() => null) : null,
        api(`/guidance?${qs({ partNumber, make: m })}`).catch(() => null),
      ]);
      detail.innerHTML = renderDetail(d, price, guide, cust).s;
      const qty = detail.querySelector('#qty');
      const add = () => {
        const n = Math.max(1, Number(qty.value) || 1);
        const b = basket.get();
        const ex = b.find((x) => x.make === d.part.make && x.partNumber === d.part.partNumber);
        if (ex) ex.qty += n;
        else b.push({ make: d.part.make, partNumber: d.part.partNumber, description: d.part.description, qty: n, unitPence: price?.unitNetPence ?? d.part.listPricePence });
        basket.set(b);
        drawBasket();
        toast(`Added ${n} × ${d.part.partNumber}`);
        qEl.focus();
        qEl.select();
      };
      detail.querySelector('#add').addEventListener('click', add);
      qty.addEventListener('keydown', (e) => { if (e.key === 'Enter') add(); });
    } catch (e) {
      if (e.code === 'AMBIGUOUS') {
        detail.innerHTML = html`<div class="alert alert-warn">${e.message}</div><div class="chips">${(e.details?.makes ?? []).map((mk) => html`<a class="chip" href="${partLink(mk, partNumber)}">${mk} ${partNumber}</a>`)}</div>`.s;
      } else detail.innerHTML = errorBox(e).s;
    }
  }

  // ---- basket
  function drawBasket() {
    const b = basket.get();
    const cust = store.get('ap.customer');
    const total = b.reduce((s, x) => s + x.qty * (x.unitPence ?? 0), 0);
    $('#basket').innerHTML = html`
      <h2 class="panel-title">Quote <span class="count">${b.length}</span></h2>
      ${b.length ? html`
        <ul class="basket-lines">
          ${b.map((x, i) => html`
            <li>
              <div><a class="mono" href="${partLink(x.make, x.partNumber)}">${x.partNumber}</a><div class="muted small">${x.description}</div></div>
              <input class="input qty-input" type="number" min="1" value="${x.qty}" data-i="${i}" aria-label="Quantity">
              <button class="icon-btn" data-del="${i}" aria-label="Remove">×</button>
            </li>`)}
        </ul>
        <div class="basket-total"><span>Est. net</span><strong>${money(total)}</strong></div>
        <button id="make-quote" class="btn btn-primary btn-block" ${cust ? '' : 'disabled'}>${cust ? `Create quote for ${cust.accountCode}` : 'Pick a customer first'}</button>
        <button id="clear" class="link-btn small">Clear</button>`
      : html`<p class="muted small">Add parts with <kbd>Enter</kbd> in the quantity box. Prices are confirmed when the quote is created.</p>`}`.s;
    $('#basket').querySelectorAll('[data-del]').forEach((btn) => btn.addEventListener('click', () => { const bb = basket.get(); bb.splice(Number(btn.dataset.del), 1); basket.set(bb); drawBasket(); }));
    $('#basket').querySelectorAll('.qty-input').forEach((inp) => inp.addEventListener('change', () => { const bb = basket.get(); bb[Number(inp.dataset.i)].qty = Math.max(1, Number(inp.value) || 1); basket.set(bb); drawBasket(); }));
    $('#basket').querySelector('#clear')?.addEventListener('click', () => { basket.set([]); drawBasket(); });
    $('#basket').querySelector('#make-quote')?.addEventListener('click', async (e) => {
      e.target.disabled = true;
      try {
        const o = await api('/sales-orders', { method: 'POST', body: { customerAccount: cust.accountCode, depotCode: store.get('ap.depot', 'HQ'), channel: 'counter', lines: b.map((x) => ({ partNumber: x.partNumber, make: x.make, qty: x.qty })) } });
        basket.set([]);
        toast(`Quote ${o.number} created`);
        location.hash = `#/orders/${o.number}`;
      } catch (err) {
        toast(err.message, 'danger');
        e.target.disabled = false;
      }
    });
  }
  drawBasket();
  if (partNumber) showDetail();

  return () => removeEventListener('keydown', onKey);
}

function renderDetail(d, price, guide, cust) {
  const p = d.part;
  const depot = store.get('ap.depot', 'HQ');
  const here = d.stock?.find((s) => s.depotCode === depot);
  return html`
    <div class="part-head">
      <span class="make-badge make-${p.make} lg">${p.make}</span>
      <div>
        <h2 class="mono">${p.partNumber}</h2>
        <p>${p.description}</p>
      </div>
    </div>

    ${d.superseded ? html`
      <div class="alert ${d.straightSwap ? 'alert-info' : 'alert-danger'}">
        <div class="chain">${d.supersessionChain.map((n, i) => html`${i ? html`<span class="arrow">→</span>` : ''}<span class="mono ${i === d.supersessionChain.length - 1 ? 'chain-current' : 'chain-old'}">${n}</span>`)}</div>
        ${d.straightSwap
          ? html`<div>Asked for <strong class="mono">${d.requested}</strong>. Superseded: supply <strong class="mono">${p.partNumber}</strong>, straight swap.</div>`
          : html`<div><strong>Fitting changes.</strong> ${d.warning} ${guide?.procedures?.length ? html`<a href="#/field/guide/${encodeURIComponent(p.make)}/${encodeURIComponent(p.partNumber)}">Open the fitting guide →</a>` : ''}</div>`}
        ${d.qtyMultiplier !== 1 ? html`<div>Quantity × ${d.qtyMultiplier}</div>` : ''}
      </div>` : ''}

    <div class="detail-cols">
      <div class="card">
        <h3>Price ${cust ? html`<span class="muted">for ${cust.accountCode}</span>` : ''}</h3>
        ${price ? html`
          <div class="price-big">${money(price.unitNetPence)} <span class="muted small">ex VAT</span></div>
          <div class="muted small">List ${money(price.unitListPence)}${price.discountBps ? ` · ${pct(price.discountBps)} off` : ''} · margin ${pct(price.marginBps)}</div>
          <div class="basis basis-${price.basis}">${price.explanation}</div>
          ${price.warnings.map((w) => html`<div class="alert alert-warn small">${w}</div>`)}`
        : html`<div class="price-big">${money(p.listPricePence)} <span class="muted small">list</span></div><p class="muted small">Pick a customer for their price.</p>`}
        <div class="add-row">
          <input id="qty" class="input" type="number" min="1" value="1" aria-label="Quantity">
          <button id="add" class="btn btn-primary">Add to quote</button>
        </div>
        ${here ? html`<div class="small ${here.available > 0 ? 'ok' : 'bad'}">${here.available > 0 ? `${here.available} free at ${depot}, bin ${here.bin ?? '–'}` : `None free at ${depot}: will backorder`}</div>` : ''}
      </div>

      <div class="card">
        <h3>Stock <span class="muted">${d.totalAvailable ?? 0} free in total</span></h3>
        <table class="tbl compact">
          <thead><tr><th>Depot</th><th class="num">Free</th><th class="num">On hand</th><th class="num">Alloc.</th><th class="num">On order</th><th>Bin</th></tr></thead>
          <tbody>
            ${(d.stock ?? []).map((s) => html`<tr class="${s.depotCode === depot ? 'row-hl' : ''}"><td>${s.depotCode}</td><td class="num ${s.available > 0 ? 'ok' : 'bad'}"><strong>${s.available}</strong></td><td class="num">${s.onHand}</td><td class="num">${s.allocated}</td><td class="num">${s.onOrder}</td><td class="mono small">${s.bin ?? '–'}</td></tr>`)}
          </tbody>
        </table>
      </div>
    </div>

    ${guide ? html`
      <div class="card guide-teaser ${guide.coverage}">
        <div class="guide-teaser-head">
          <h3>⚙ Field guide</h3>
          ${guide.coverage === 'licensed' ? html`<a class="btn btn-sm" href="#/field/guide/${encodeURIComponent(p.make)}/${encodeURIComponent(p.partNumber)}">Open guide</a>` : ''}
        </div>
        ${guide.coverage === 'licensed'
          ? html`<ul class="plain">${guide.procedures.map((pr) => html`<li><strong>${pr.title}</strong> <span class="muted small">${pr.source.docRef} p.${pr.pages} · ${pr.estMinutes} min · ${pr.skill}</span></li>`)}</ul>`
          : guide.coverage === 'withheld' ? html`<p class="muted small">${guide.withheld.map((w) => w.reason).join('; ')}</p>`
          : html`<p class="muted small">No licensed manufacturer instructions for this part yet.</p>`}
      </div>` : ''}

    ${d.equivalents?.length ? html`
      <div class="card">
        <h3>Equivalents</h3>
        <ul class="plain">
          ${d.equivalents.map((e) => html`<li><a class="mono" href="${partLink(e.make, e.partNumber)}">${e.make} ${e.partNumber}</a> ${e.description} <span class="muted small">${e.kind.replace('_', ' ')}</span> ${e.verified ? html`<span class="pill pill-invoiced">Verified</span>` : html`<span class="pill pill-quote" title="${e.label}">Unverified</span>`}</li>`)}
        </ul>
      </div>` : ''}
  `;
}
