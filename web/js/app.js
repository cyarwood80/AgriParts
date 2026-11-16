import { api, getKey, html, setKey, store, toast } from './lib.js';
import * as counter from './counter.js';
import * as orders from './orders.js';
import * as insights from './insights.js';
import * as field from './field.js';
import * as review from './review.js';
import * as desk from './desk.js';
import * as job from './job.js';

const view = document.getElementById('view');
let countLoaded = false;
let cleanup = null;

// A demo link like /app/#key=ap_... signs in and is then stripped from the URL.
// Checked on every route, not just page load: opening a new link in a tab
// that already has the app only changes the hash.
function takeKeyFromHash() {
  const m = /^#key=(ap_[A-Za-z0-9_-]+)/.exec(location.hash);
  if (!m) return;
  setKey(m[1]);
  countLoaded = false;
  history.replaceState(null, '', `${location.pathname}#/desk`);
}

const routes = [
  [/^#\/desk\/new$/, () => desk.render(view, 'new'), 'desk'],
  [/^#\/desk(?:\/([0-9a-f-]{36}))?$/, (p) => desk.render(view, p[1]), 'desk'],
  [/^#\/field\/job\/([^/]+)\/([^/]+)\/([0-9a-f-]{36})(?:\?serial=(.*))?$/, (p) => job.renderOnline(view, decodeURIComponent(p[1]), decodeURIComponent(p[2]), p[3], p[4] && decodeURIComponent(p[4])), 'job'],
  [/^#\/field\/pack\/([^/]+)\/job\/([0-9a-f-]{36})$/, (p) => job.renderPack(view, decodeURIComponent(p[1]), p[2]), 'job'],
  [/^#\/counter(?:\/([^/]+)\/(.+))?$/, (p) => counter.render(view, { make: p[1] && decodeURIComponent(p[1]), partNumber: p[2] && decodeURIComponent(p[2]) }), 'counter'],
  [/^#\/orders\/(.+)$/, (p) => orders.renderOrder(view, decodeURIComponent(p[1])), 'orders'],
  [/^#\/orders$/, () => orders.renderList(view), 'orders'],
  [/^#\/backorders$/, () => orders.renderBackorders(view), 'backorders'],
  [/^#\/insights$/, () => insights.render(view), 'insights'],
  // 3D teardown prototype (ADR-0006): loaded on demand so the app shell never depends on the CDN.
  [/^#\/field\/explode\/demo$/, () => import('./explode.js').then((m) => m.render(view)).catch((e) => {
    view.innerHTML = html`<div class="alert alert-danger">The 3D viewer needs a connection the first time it opens (it loads three.js). ${e.message}</div>`.s;
  }), 'teardown'],
  [/^#\/field\/machine\/(.+)$/, (p) => field.renderMachine(view, decodeURIComponent(p[1])), 'field'],
  [/^#\/field\/guide\/([^/]+)\/([^?]+)(?:\?serial=(.*))?$/, (p) => field.renderGuide(view, decodeURIComponent(p[1]), decodeURIComponent(p[2]), p[3] && decodeURIComponent(p[3])), 'field'],
  [/^#\/field\/pack\/(.+)$/, (p) => field.renderPack(view, decodeURIComponent(p[1])), 'field'],
  [/^#\/field$/, () => field.renderHome(view), 'field'],
  [/^#\/review\/(.+)$/, (p) => review.renderDetail(view, decodeURIComponent(p[1])), 'review'],
  [/^#\/review$/, () => review.renderQueue(view), 'review'],
];

async function route() {
  takeKeyFromHash();
  if (!getKey()) return renderSignIn();
  document.getElementById('shell').classList.remove('signed-out');
  const hash = location.hash || '#/desk';
  const hit = routes.find(([re]) => re.test(hash));
  if (!hit) { location.hash = '#/desk'; return; }
  const [re, fn, nav] = hit;
  document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === (nav === 'teardown' || nav === 'job' ? 'field' : nav)));
  document.body.classList.toggle('field-mode', nav === 'field');
  document.body.classList.toggle('desk-mode', nav === 'desk' || nav === 'teardown');
  document.body.classList.toggle('job-mode', nav === 'job');
  if (typeof cleanup === 'function') cleanup();
  cleanup = null;
  window.scrollTo(0, 0);
  cleanup = await fn(re.exec(hash));
  if (!countLoaded) { countLoaded = true; review.refreshCount(); desk.refreshCount(); }
}

function renderSignIn() {
  document.getElementById('shell').classList.add('signed-out');
  view.innerHTML = html`
    <div class="signin">
      <img src="icon.svg" alt="" width="56" height="56">
      <h1>Linchpin</h1>
      <p class="muted">Paste an API key to sign in. With <code>SEED_DEMO=true</code> the server prints a sign-in link at start-up.</p>
      <form id="signin" class="stack">
        <input id="key" class="input input-lg" placeholder="ap_xxxxxxxxxxxx_..." autocomplete="off" spellcheck="false" required>
        <button class="btn btn-primary btn-lg" type="submit">Sign in</button>
      </form>
      <p class="muted small">Field engineers: job packs already saved on this device work without signing in. <a href="#/field" id="offline-packs">Open saved packs</a></p>
    </div>`.s;
  view.querySelector('#signin').addEventListener('submit', async (e) => {
    e.preventDefault();
    setKey(view.querySelector('#key').value.trim());
    try {
      await api('/depots');
      route();
    } catch (err) {
      store.del('ap.key');
      toast(err.message, 'danger');
    }
  });
  view.querySelector('#offline-packs').addEventListener('click', (e) => {
    e.preventDefault();
    document.getElementById('shell').classList.remove('signed-out');
    document.body.classList.add('field-mode');
    field.renderHome(view);
  });
}

function updateConn() {
  const el = document.getElementById('conn');
  el.innerHTML = navigator.onLine ? '<span class="dot dot-ok"></span> Online' : '<span class="dot dot-off"></span> Offline: saved packs only';
  document.body.classList.toggle('is-offline', !navigator.onLine);
}

document.getElementById('signout').addEventListener('click', () => {
  store.del('ap.key');
  countLoaded = false;
  route();
});
addEventListener('hashchange', route);
addEventListener('online', updateConn);
addEventListener('offline', updateConn);
addEventListener('keydown', (e) => {
  const go = { F2: '#/desk', F3: '#/field', F4: '#/counter' }[e.key];
  if (go) { e.preventDefault(); location.hash = go; }
});

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
updateConn();
route();
