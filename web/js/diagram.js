// Assembly diagram for a procedure, in the style of the Machine Map concept:
// a line drawing with numbered callouts tied to the procedure's parts list.
// The part being replaced is drawn in teal and gets the first callout.
//
// These drawings are invented illustrations. When a licensed parts-book figure
// exists for the assembly it replaces the drawing (ADR-0005 / ADR-0006); the
// numbers and part rows stay the same.
import { html, raw } from './lib.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

const INK = 'currentColor';

// Each drawing: line art, the shape to fill for the part being replaced, and
// callout anchors (x,y on the part → lx,ly where the numbered circle sits).
// anchors[0] always points at the focus shape.
const DRAWINGS = {
  filter: {
    label: 'Engine lubrication and filters',
    art: `
      <path d="M150 140h300l40 40v140H150z"/>
      <path d="M150 180h340M200 140v-30h60v30M330 140v-30h60v30"/>
      <path d="M170 320v40h300v-40" stroke-dasharray="5 5"/>
      <rect x="180" y="360" width="280" height="30" rx="6"/>
      <circle cx="430" cy="375" r="8"/>
      <path d="M490 230h70"/>
      <rect x="560" y="200" width="70" height="60" rx="8"/>
      <path d="M572 214h46M572 246h46"/>`,
    focus: `<rect x="570" y="292" width="50" height="86" rx="10"/><path d="M570 312h50M570 358h50"/>`,
    anchors: [
      { x: 620, y: 335, lx: 700, ly: 300 },
      { x: 230, y: 110, lx: 230, ly: 60 },
      { x: 630, y: 230, lx: 700, ly: 170 },
      { x: 438, y: 375, lx: 540, ly: 405 },
      { x: 360, y: 110, lx: 360, ly: 60 },
    ],
  },
  rotor: {
    label: 'Flail rotor',
    art: `
      <rect x="120" y="170" width="520" height="60" rx="30"/>
      <rect x="78" y="160" width="42" height="80" rx="6"/>
      <rect x="640" y="160" width="42" height="80" rx="6"/>
      <path d="M40 200h38M682 200h38"/>
      <circle cx="99" cy="200" r="14"/><circle cx="661" cy="200" r="14"/>
      ${[170, 225, 280, 435, 490, 545, 600].map((x) => `<rect x="${x - 7}" y="150" width="14" height="20" rx="3"/><rect x="${x - 10}" y="232" width="20" height="46" rx="5"/>`).join('')}
      <rect x="353" y="150" width="14" height="20" rx="3"/>
      <path d="M360 150v-22" stroke-dasharray="4 4"/>
      <path d="M340 118h40" /><path d="M343 112v12M377 112v12"/>`,
    focus: `<rect x="345" y="36" width="30" height="64" rx="7"/><circle cx="360" cy="50" r="5"/>`,
    anchors: [
      { x: 375, y: 70, lx: 470, ly: 52 },
      { x: 343, y: 118, lx: 250, ly: 90 },
      { x: 377, y: 118, lx: 470, ly: 120 },
      { x: 661, y: 214, lx: 680, ly: 320 },
      { x: 99, y: 214, lx: 80, ly: 320 },
    ],
  },
  baler: {
    label: 'Knotter and pick-up',
    art: `
      <circle cx="250" cy="200" r="90"/><circle cx="250" cy="200" r="20"/>
      ${Array.from({ length: 12 }, (_, i) => { const a = (i * Math.PI) / 6; return `<path d="M${250 + 90 * Math.cos(a)} ${200 + 90 * Math.sin(a)}l${10 * Math.cos(a)} ${10 * Math.sin(a)}"/>`; }).join('')}
      <path d="M340 200h120"/>
      <rect x="460" y="160" width="120" height="80" rx="10"/>
      <path d="M480 240v60h80v-60" stroke-dasharray="5 5"/>
      <path d="M120 330h500"/>
      ${[160, 220, 280, 340, 400, 460, 520, 580].map((x) => `<path d="M${x} 330q8 30 22 34"/>`).join('')}`,
    focus: `<path d="M600 120l60-30 14 12-50 40z"/><circle cx="612" cy="128" r="6"/>`,
    anchors: [
      { x: 660, y: 100, lx: 710, ly: 60 },
      { x: 580, y: 200, lx: 700, ly: 220 },
      { x: 250, y: 200, lx: 250, ly: 60 },
      { x: 400, y: 345, lx: 400, ly: 390 },
      { x: 520, y: 300, lx: 600, ly: 390 },
    ],
  },
};

function drawingFor(pr) {
  const t = `${pr.code} ${pr.title}`;
  if (/FM55|flail|rotor/i.test(t)) return DRAWINGS.rotor;
  if (/filter/i.test(t)) return DRAWINGS.filter;
  return DRAWINGS.baler;
}

const ORDER = { replaced: 0, consumable: 1, may_need: 2 };

/** Parts in callout order: the replaced part first. Each gets `n` (1-based). */
export function numberedParts(pr) {
  return [...pr.parts]
    .sort((a, b) => (ORDER[a.role] ?? 3) - (ORDER[b.role] ?? 3))
    .map((p, i) => ({ ...p, n: i + 1 }));
}

/** Figure with numbered callouts. Callouts carry data-n for linking. */
export function diagramFigure(pr, numbered) {
  const d = drawingFor(pr);
  // Only parts that go on the machine get a callout; "may need" alternatives
  // are listed but would point at the wrong place on the drawing.
  const fitted = numbered.filter((p) => p.role !== 'may_need');
  const callouts = fitted.slice(0, d.anchors.length).map((p, i) => {
    const a = d.anchors[i];
    const focus = p.role === 'replaced';
    return `
      <g class="dg-callout${focus ? ' is-focus' : ''}" data-n="${p.n}" tabindex="0" role="button" aria-label="Item ${p.n}: ${esc(p.partNumber)}">
        <path class="dg-leader" d="M${a.x} ${a.y}L${a.lx} ${a.ly}"/>
        <circle cx="${a.lx}" cy="${a.ly}" r="${focus ? 16 : 13}"/>
        <text x="${a.lx}" y="${a.ly + 5}">${p.n}</text>
      </g>`;
  }).join('');
  const gid = `dg-grid-${esc(pr.id)}`;
  const svg = `
    <svg viewBox="0 0 760 420" role="img" aria-label="${d.label}: diagram with numbered parts">
      <defs><pattern id="${gid}" width="20" height="20" patternUnits="userSpaceOnUse"><path d="M20 0H0V20" fill="none" class="dg-gridline"/></pattern></defs>
      <rect width="760" height="420" fill="url(#${gid})"/>
      <g class="dg-art" fill="none" stroke="${INK}" stroke-width="1.6" stroke-linejoin="round">${d.art}</g>
      <g class="dg-focus" stroke-width="2.4" stroke-linejoin="round">${d.focus}</g>
      ${callouts}
    </svg>`;
  return html`
    <figure class="dg">
      <div class="dg-stage">${raw(svg)}</div>
      <figcaption class="dg-cap"><span>${d.label} · ${pr.source.docRef}${pr.pages ? ` · pp. ${pr.pages}` : ''}</span><span class="dg-note">Illustration, not to scale. The manufacturer's page is the reference.</span></figcaption>
    </figure>`;
}

/** Link callouts in the figure with parts rows ([data-n]) inside root. */
export function bindDiagram(root) {
  const pick = (n) => {
    root.querySelectorAll('[data-n]').forEach((x) => x.classList.toggle('is-on', x.dataset.n === String(n)));
  };
  root.querySelectorAll('[data-n]').forEach((x) => {
    x.addEventListener('click', () => pick(x.dataset.n));
    x.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(x.dataset.n); } });
  });
}
