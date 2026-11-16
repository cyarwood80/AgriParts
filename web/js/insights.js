import { api, errorBox, html, loading, money, partLink, qs } from './lib.js';

export async function render(el) {
  el.innerHTML = html`
    <header class="page-head">
      <div><h1>Purchasing insights</h1><p class="muted">Deterministic and explainable: every line says why.</p></div>
    </header>
    <div class="kpis" id="kpis">${loading()}</div>
    <div class="insight-grid">
      <section class="panel"><h2 class="panel-title">Move before you buy</h2><div id="rebalance">${loading()}</div></section>
      <section class="panel"><h2 class="panel-title">Dead stock <span class="muted small">no movement out in 365 days</span></h2><div id="dead">${loading()}</div></section>
    </div>
    <section class="panel"><h2 class="panel-title">Reorder suggestions</h2><div id="reorder">${loading()}</div></section>`.s;

  const [reorder, rebalance, dead, backorders] = await Promise.allSettled([
    api('/insights/reorder'), api('/insights/rebalance'), api(`/insights/dead-stock?${qs({ days: 365 })}`), api('/backorders'),
  ]);
  const val = (r) => (r.status === 'fulfilled' ? r.value : null);
  const ro = val(reorder) ?? [];
  const rb = val(rebalance) ?? [];
  const dd = val(dead);
  const bo = val(backorders) ?? [];

  el.querySelector('#kpis').innerHTML = html`
    <div class="kpi"><div class="kpi-label">To reorder</div><div class="kpi-val">${ro.length}</div><div class="kpi-sub">${money(ro.reduce((s, r) => s + r.estCostPence, 0))} at cost</div></div>
    <div class="kpi"><div class="kpi-label">Transfers suggested</div><div class="kpi-val">${rb.length}</div><div class="kpi-sub">saves ${money(rb.reduce((s, r) => s + r.avoidsPurchasePence, 0))} of buying</div></div>
    <div class="kpi"><div class="kpi-label">Dead stock</div><div class="kpi-val">${money(dd?.totalValuePence ?? 0)}</div><div class="kpi-sub">${dd?.lines ?? 0} lines</div></div>
    <a class="kpi" href="#/backorders"><div class="kpi-label">Customer backorders</div><div class="kpi-val ${bo.length ? 'bad' : ''}">${bo.length}</div><div class="kpi-sub">lines waiting for stock</div></a>`.s;

  const pl = (r) => html`<a class="mono" href="${partLink(r.make, r.partNumber)}">${r.partNumber}</a>`;
  el.querySelector('#reorder').innerHTML = reorder.status === 'rejected' ? errorBox(reorder.reason).s : ro.length ? html`
    <table class="tbl">
      <thead><tr><th>Depot</th><th>Part</th><th>Supplier</th><th class="num">Qty</th><th class="num">Est. cost</th><th class="num">Per day</th><th>Why</th></tr></thead>
      <tbody>${ro.map((r) => html`<tr><td>${r.depot}</td><td>${pl(r)} <span class="muted small">${r.description}</span></td><td>${r.supplier ?? '–'}</td><td class="num"><strong>${r.suggestedQty}</strong></td><td class="num">${money(r.estCostPence)}</td><td class="num">${r.dailyDemand}</td><td class="small muted">${r.reason}</td></tr>`)}</tbody>
    </table>`.s : '<p class="muted">Nothing to reorder.</p>';

  el.querySelector('#rebalance').innerHTML = rebalance.status === 'rejected' ? errorBox(rebalance.reason).s : rb.length ? html`
    <table class="tbl compact">
      <thead><tr><th>Part</th><th>Move</th><th class="num">Qty</th><th class="num">Saves</th></tr></thead>
      <tbody>${rb.map((r) => html`<tr title="${r.reason}"><td>${pl(r)}</td><td>${r.fromDepot} → ${r.toDepot}</td><td class="num">${r.qty}</td><td class="num">${money(r.avoidsPurchasePence)}</td></tr>`)}</tbody>
    </table>`.s : '<p class="muted">No transfers needed.</p>';

  el.querySelector('#dead').innerHTML = dead.status === 'rejected' ? errorBox(dead.reason).s : dd?.items?.length ? html`
    <table class="tbl compact">
      <thead><tr><th>Depot</th><th>Part</th><th class="num">On hand</th><th class="num">Value</th></tr></thead>
      <tbody>${dd.items.slice(0, 12).map((r) => html`<tr><td>${r.depot}</td><td>${pl(r)}</td><td class="num">${r.onHand}</td><td class="num">${money(r.valuePence)}</td></tr>`)}</tbody>
    </table>`.s : '<p class="muted">No dead stock.</p>';
}
