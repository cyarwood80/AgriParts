import { api, date, dateTime, errorBox, html, loading, money, partLink, qs, statusPill, toast } from './lib.js';

export async function renderList(el) {
  let status = '';
  el.innerHTML = html`
    <header class="page-head">
      <div><h1>Sales orders</h1><p class="muted">Quotes, confirmed orders and invoices.</p></div>
      <div class="seg" id="seg">
        ${[['', 'All'], ['quote', 'Quotes'], ['confirmed', 'Confirmed'], ['part_invoiced', 'Part invoiced'], ['invoiced', 'Invoiced']].map(([v, l]) => html`<button data-s="${v}" class="${v === status ? 'on' : ''}">${l}</button>`)}
      </div>
    </header>
    <section class="panel" id="list">${loading()}</section>`.s;
  const load = async () => {
    const list = el.querySelector('#list');
    try {
      const rows = await api(`/sales-orders?${qs({ status, limit: 100 })}`);
      list.innerHTML = rows.length ? html`
        <table class="tbl clickable">
          <thead><tr><th>Order</th><th>Status</th><th>Customer</th><th>Depot</th><th class="num">Gross</th><th>Created</th></tr></thead>
          <tbody>${rows.map((o) => html`<tr data-href="#/orders/${o.number}"><td class="mono"><a href="#/orders/${o.number}">${o.number}</a></td><td>${statusPill(o.status)}</td><td>${o.customer}</td><td>${o.depot}</td><td class="num">${money(o.grossPence)}</td><td>${dateTime(o.createdAt)}</td></tr>`)}</tbody>
        </table>` .s : '<div class="empty"><p>No orders yet. Create a quote from the counter.</p></div>';
      list.querySelectorAll('tr[data-href]').forEach((tr) => tr.addEventListener('click', () => { location.hash = tr.dataset.href; }));
    } catch (e) { list.innerHTML = errorBox(e).s; }
  };
  el.querySelectorAll('#seg button').forEach((b) => b.addEventListener('click', () => {
    status = b.dataset.s;
    el.querySelectorAll('#seg button').forEach((x) => x.classList.toggle('on', x === b));
    load();
  }));
  load();
}

export async function renderOrder(el, number) {
  el.innerHTML = loading().s;
  let o;
  try { o = await api(`/sales-orders/${encodeURIComponent(number)}`); } catch (e) { el.innerHTML = errorBox(e).s; return; }
  const outstanding = o.lines.some((l) => l.qtyAllocated > 0);
  el.innerHTML = html`
    <header class="page-head">
      <div>
        <a class="back" href="#/orders">← Orders</a>
        <h1><span class="mono">${o.number}</span> ${statusPill(o.status)}</h1>
        <p class="muted">${o.customer.accountCode} · ${o.customer.name} · ${o.depot.code} ${o.customerRef ? `· ref ${o.customerRef}` : ''} · ${dateTime(o.createdAt)}</p>
      </div>
      <div class="actions">
        ${o.status === 'quote' ? html`<button class="btn btn-primary" data-act="confirm">Confirm order</button>` : ''}
        ${['confirmed', 'part_invoiced'].includes(o.status) && outstanding ? html`<button class="btn btn-primary" data-act="invoice">Invoice allocated</button>` : ''}
        ${['quote', 'confirmed', 'part_invoiced'].includes(o.status) ? html`<button class="btn" data-act="cancel">Cancel outstanding</button>` : ''}
      </div>
    </header>
    ${o.customer.onStop ? html`<div class="alert alert-danger">Customer is on stop.</div>` : ''}
    <section class="panel">
      <table class="tbl">
        <thead><tr><th>#</th><th>Part</th><th class="num">Qty</th><th class="num">Alloc.</th><th class="num">B/O</th><th class="num">Inv.</th><th class="num">Unit net</th><th class="num">Line net</th><th>Pricing</th></tr></thead>
        <tbody>
          ${o.lines.map((l) => html`
            <tr>
              <td>${l.lineNo}</td>
              <td><a class="mono" href="${partLink(l.make, l.partNumber)}">${l.partNumber}</a> <span class="muted small">${l.description}</span>
                ${l.requestedPartNumber && l.requestedPartNumber !== l.partNumber ? html`<div class="small muted">Asked for <span class="mono">${l.requestedPartNumber}</span></div>` : ''}
                ${l.availability ? html`<div class="small ${l.availability.atDepot >= l.qty ? 'ok' : 'bad'}">${l.availability.atDepot} free here${l.availability.elsewhere.length ? ` · ${l.availability.elsewhere.map((x) => `${x.depot} ${x.available}`).join(', ')}` : ''}</div>` : ''}</td>
              <td class="num">${l.qty}</td><td class="num">${l.qtyAllocated}</td><td class="num ${l.qtyBackordered ? 'bad' : ''}">${l.qtyBackordered}</td><td class="num">${l.qtyInvoiced}</td>
              <td class="num">${money(l.unitNetPence)}</td><td class="num">${money(l.lineNetPence)}</td>
              <td class="small muted">${l.pricing?.explanation ?? ''}</td>
            </tr>`)}
        </tbody>
        <tfoot>
          <tr><td colspan="7" class="num muted">Net</td><td class="num">${money(o.totals.netPence)}</td><td></td></tr>
          <tr><td colspan="7" class="num muted">VAT</td><td class="num">${money(o.totals.vatPence)}</td><td></td></tr>
          <tr><td colspan="7" class="num"><strong>Gross</strong></td><td class="num"><strong>${money(o.totals.grossPence)}</strong></td><td></td></tr>
        </tfoot>
      </table>
    </section>
    ${o.invoices.length ? html`<section class="panel"><h2 class="panel-title">Invoices</h2><ul class="plain">${o.invoices.map((i) => html`<li class="mono">${i.number} <span class="muted">${money(i.grossPence)} · due ${date(i.dueDate)}</span></li>`)}</ul></section>` : ''}`.s;

  el.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', async () => {
    const act = b.dataset.act;
    let body;
    if (act === 'cancel') {
      const reason = prompt('Reason for cancelling the outstanding quantities?');
      if (!reason || reason.length < 3) return;
      body = { reason };
    }
    b.disabled = true;
    try {
      await api(`/sales-orders/${o.number}/${act}`, { method: 'POST', body });
      toast({ confirm: 'Order confirmed', invoice: 'Invoiced', cancel: 'Cancelled' }[act]);
      renderOrder(el, number);
    } catch (e) {
      toast(e.message, 'danger');
      b.disabled = false;
    }
  }));
}

export async function renderBackorders(el) {
  el.innerHTML = html`<header class="page-head"><div><h1>Backorders</h1><p class="muted">Who to ring when it lands. Goods received are allocated to these automatically.</p></div></header><section class="panel" id="bo">${loading()}</section>`.s;
  const box = el.querySelector('#bo');
  try {
    const rows = await api('/backorders');
    box.innerHTML = rows.length ? html`
      <table class="tbl">
        <thead><tr><th>Order</th><th>Customer</th><th>Phone</th><th>Part</th><th class="num">Waiting</th><th>Depot</th><th class="num">Age</th></tr></thead>
        <tbody>${rows.map((r) => html`<tr><td class="mono"><a href="#/orders/${r.orderNumber}">${r.orderNumber}</a></td><td>${r.customerName}</td><td>${r.phone ?? '–'}</td><td><a class="mono" href="${partLink(r.make, r.partNumber)}">${r.partNumber}</a> <span class="muted small">${r.description}</span></td><td class="num bad"><strong>${r.qtyBackordered}</strong></td><td>${r.depot}</td><td class="num">${r.ageDays}d</td></tr>`)}</tbody>
      </table>`.s : '<div class="empty"><p>Nothing waiting for stock.</p></div>';
  } catch (e) { box.innerHTML = errorBox(e).s; }
}
