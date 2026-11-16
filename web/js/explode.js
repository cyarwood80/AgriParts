// Teardown prototype (ADR-0006): an exploded, workshop-manual style 3D view
// with a walkthrough driven by the published procedure.
// The geometry is INVENTED for the demo (a simplified flail rotor). In
// production layer 2 comes from licensed OEM CAD or a model of the licensed
// parts-book diagram, reviewed by the foreman.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { api, errorBox, html, qs } from './lib.js';

const MACHINE = { make: 'DH', partNumber: 'DH-10442', serial: 'FM55-20219', model: 'Flailmaster 5.5' };

// Callout number -> what it is. Part numbers are the demo catalogue's.
const PARTS = [
  { n: 1, key: 'rotor', name: 'Rotor tube', pn: null, note: 'Not sold separately' },
  { n: 2, key: 'lug', name: 'Hammer lug (welded)', pn: null, note: 'Part of the rotor' },
  { n: 3, key: 'hammer', name: 'Flail hammer, 80mm, heavy duty', pn: 'DH-10442' },
  { n: 4, key: 'bolt', name: 'Hammer bolt (single use)', pn: null, note: 'Supplied with the hammer' },
  { n: 5, key: 'nut', name: 'Hammer nut (single use)', pn: null, note: 'Supplied with the hammer' },
  { n: 6, key: 'opposite', name: 'Opposite hammer (replace as a pair)', pn: 'DH-10442' },
  { n: 7, key: 'bearing', name: 'Rotor bearing, 2-bolt flange', pn: 'DH-10471' },
];

// Procedure step (seq) -> what moves and where the camera looks. Illustration only.
const STEP_SCRIPT = {
  1: { explode: 0, focus: 'rotor', spin: 0, cam: [5.5, -3.2, 6.5] },
  2: { explode: 0.55, focus: 'bolt', spin: 0, only: ['bolt', 'nut'], cam: [4.2, 2.4, 5.2] },
  3: { explode: 1, focus: 'lug', spin: 0, only: ['bolt', 'nut', 'hammer'], cam: [3.6, 2.8, 4.8] },
  4: { explode: 0.15, focus: 'hammer', spin: 0, also: 'opposite', cam: [4.6, 2.2, 6] },
  5: { explode: 0, focus: 'rotor', spin: 0.6, cam: [7, 3, 8] },
  6: { explode: 0, focus: 'rotor', spin: 6, cam: [8, 3.5, 9] },
};

export async function render(el) {
  el.innerHTML = html`
    <div class="td">
      <div class="td-stage" id="td-stage" aria-label="3D view of the flail rotor assembly. Drag to turn, scroll to zoom."></div>
      <div class="td-labels" id="td-labels" aria-hidden="true"></div>
      <header class="td-head">
        <a class="td-back" href="#/field" aria-label="Back to the field guide">←</a>
        <div>
          <div class="td-eyebrow">Teardown · prototype</div>
          <h1 class="td-title">Flail rotor · hammer set</h1>
          <div class="td-sub mono">${MACHINE.model} · ${MACHINE.serial}</div>
        </div>
        <span class="td-badge">Illustration: invented demo geometry</span>
      </header>
      <aside class="td-panel">
        <div class="td-ctrl">
          <label class="td-slider"><span>Assembled</span><input id="td-explode" type="range" min="0" max="100" value="0" aria-label="Explode the assembly"><span>Exploded</span></label>
          <div class="td-btns">
            <button class="btn btn-sm" type="button" id="td-toggle">Explode</button>
            <button class="btn btn-sm" type="button" id="td-style">Shaded</button>
            <button class="btn btn-sm btn-primary" type="button" id="td-walk">Walk me through it</button>
          </div>
        </div>
        <ol class="td-parts" id="td-parts">${PARTS.map((p) => html`
          <li><button type="button" data-key="${p.key}"><span class="td-n mono">${p.n}</span><span class="td-pname">${p.name}</span><span class="td-pn mono">${p.pn ?? '–'}</span></button></li>`)}
        </ol>
        <div class="td-picked" id="td-picked"><p class="muted small">Tap a piece in the view, or a line above, to see what it is.</p></div>
      </aside>
      <section class="td-step" id="td-step" hidden></section>
    </div>`.s;

  // ---- scene ----------------------------------------------------------------
  const stage = el.querySelector('#td-stage');
  const labels = el.querySelector('#td-labels');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  stage.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 200);
  camera.position.set(7, 4, 9);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.target.set(0, 0.2, 0);
  controls.minDistance = 3;
  controls.maxDistance = 22;
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a9590, 1.6));
  const sun = new THREE.DirectionalLight(0xffffff, 1.6);
  sun.position.set(6, 10, 7);
  scene.add(sun);

  const INK = 0x15191c;
  const TEAL = 0x0a6e69;
  let manualStyle = true;
  const meshes = []; // { mesh, key, edges }
  const lineMat = new THREE.LineBasicMaterial({ color: INK });
  function mat() { return new THREE.MeshStandardMaterial({ color: 0xf4f6f4, roughness: 0.85, metalness: 0.05, flatShading: true }); }
  function add(geom, key, parent, pos = [0, 0, 0], rot = [0, 0, 0]) {
    const mesh = new THREE.Mesh(geom, mat());
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.userData.key = key;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geom, 25), lineMat);
    mesh.add(edges);
    parent.add(mesh);
    meshes.push({ mesh, key, edges });
    return mesh;
  }

  // Rotor: tube along X, spinning group.
  const rotor = new THREE.Group();
  scene.add(rotor);
  add(new THREE.CylinderGeometry(0.55, 0.55, 6, 28, 1, false), 'rotor', rotor, [0, 0, 0], [0, 0, Math.PI / 2]);
  add(new THREE.CylinderGeometry(0.18, 0.18, 7.4, 16), 'rotor', rotor, [0, 0, 0], [0, 0, Math.PI / 2]);

  // Lugs and hammers in a spiral; index 4 (top, centre) is the one we work on.
  const featured = {};
  const STATIONS = 9;
  for (let i = 0; i < STATIONS; i++) {
    const x = -2.6 + i * 0.65;
    for (const side of [0, Math.PI]) {
      const angle = (i - 4) * 0.7 + side; // station 4 (the one we work on) faces up
      const arm = new THREE.Group();
      arm.position.x = x;
      arm.rotation.x = angle;
      rotor.add(arm);
      const isFeatured = i === 4 && side === 0;
      const isOpposite = i === 4 && side === Math.PI;
      for (const dx of [-0.13, 0.13]) add(new THREE.BoxGeometry(0.06, 0.42, 0.34), isFeatured ? 'lug' : 'rotor', arm, [dx, 0.68, 0]);
      const hammer = new THREE.Group();
      hammer.position.y = 0.82;
      arm.add(hammer);
      const hk = isFeatured ? 'hammer' : isOpposite ? 'opposite' : 'other';
      add(new THREE.BoxGeometry(0.18, 0.62, 0.16), hk, hammer, [0, 0.28, 0]);
      add(new THREE.BoxGeometry(0.2, 0.16, 0.5), hk, hammer, [0, 0.62, 0.12]);
      if (isFeatured) {
        featured.arm = arm;
        featured.hammer = hammer;
        featured.bolt = add(new THREE.CylinderGeometry(0.05, 0.05, 0.56, 12), 'bolt', arm, [0, 0.82, 0], [0, 0, Math.PI / 2]);
        add(new THREE.CylinderGeometry(0.09, 0.09, 0.05, 6), 'bolt', featured.bolt, [0, 0.29, 0]);
        featured.nut = add(new THREE.CylinderGeometry(0.09, 0.09, 0.08, 6), 'nut', arm, [-0.22, 0.82, 0], [0, 0, Math.PI / 2]);
      }
      if (isOpposite) featured.opposite = hammer;
    }
  }
  // End bearings (static frame) with flanges.
  for (const x of [-3.45, 3.45]) {
    const b = add(new THREE.CylinderGeometry(0.36, 0.36, 0.3, 24), 'bearing', scene, [x, 0, 0], [0, 0, Math.PI / 2]);
    add(new THREE.BoxGeometry(0.18, 1.4, 0.5), 'bearing', b, [0, 0, 0], [0, 0, Math.PI / 2]);
  }

  // Explode vectors (in the featured arm's local space).
  const base = { bolt: featured.bolt.position.clone(), nut: featured.nut.position.clone(), hammer: featured.hammer.position.clone() };
  const vec = { bolt: new THREE.Vector3(1.4, 0, 0), nut: new THREE.Vector3(-1.1, 0, 0), hammer: new THREE.Vector3(0, 1.5, 0) };

  // Callout anchors.
  const anchors = {
    rotor: () => new THREE.Vector3(-1.8, 0.6, 0.4),
    lug: () => featured.arm.localToWorld(new THREE.Vector3(0.13, 0.72, 0.18)),
    hammer: () => featured.hammer.localToWorld(new THREE.Vector3(0, 0.62, 0.3)),
    bolt: () => featured.bolt.localToWorld(new THREE.Vector3(0, 0.3, 0)),
    nut: () => featured.nut.localToWorld(new THREE.Vector3(0, -0.05, 0)),
    opposite: () => featured.opposite.localToWorld(new THREE.Vector3(0, 0.62, 0.3)),
    bearing: () => new THREE.Vector3(3.45, 0.75, 0),
  };
  labels.innerHTML = PARTS.map((p) => `<span class="td-callout" data-key="${p.key}">${p.n}</span>`).join('');

  // ---- state ----------------------------------------------------------------
  let explode = 0;
  let explodeTarget = 0;
  let spin = 0;
  let only = null;
  let picked = null;
  let camGoal = null;

  function applyExplode() {
    for (const k of ['bolt', 'nut', 'hammer']) {
      const amount = only && !only.includes(k) ? 0 : explode;
      const target = featured[k];
      target.position.copy(base[k]).addScaledVector(vec[k], amount);
    }
  }

  function setStyle() {
    for (const m of meshes) {
      const hot = picked && (m.key === picked || (picked === 'hammer' && m.key === 'hammer'));
      m.mesh.material.color.set(hot ? (manualStyle ? 0xbfe3df : 0x2bb3a8) : manualStyle ? 0xf4f6f4 : m.key === 'bearing' ? 0x5e6a71 : 0x9aa6a0);
      m.mesh.material.metalness = manualStyle ? 0.05 : 0.4;
      m.edges.visible = manualStyle;
    }
    scene.background = new THREE.Color(manualStyle ? 0xeef1ee : 0x101416);
    el.querySelector('.td').classList.toggle('is-dark', !manualStyle);
  }

  function pick(key) {
    picked = key === picked ? null : key;
    setStyle();
    el.querySelectorAll('#td-parts button').forEach((b) => b.classList.toggle('on', b.dataset.key === picked));
    const p = PARTS.find((x) => x.key === picked);
    el.querySelector('#td-picked').innerHTML = p ? html`
      <div class="td-picked-card">
        <span class="td-n mono">${p.n}</span>
        <div><strong>${p.name}</strong><div class="mono">${p.pn ?? p.note}</div></div>
      </div>
      ${p.pn ? html`<div class="td-picked-actions"><a class="btn btn-sm btn-primary" href="#/field/guide/${MACHINE.make}/${encodeURIComponent(p.pn)}?serial=${MACHINE.serial}">How to fit it</a><a class="btn btn-sm" href="#/counter/${MACHINE.make}/${encodeURIComponent(p.pn)}">Price and stock</a></div>` : ''}`.s
      : html`<p class="muted small">Tap a piece in the view, or a line above, to see what it is.</p>`.s;
  }

  // ---- interaction ------------------------------------------------------------
  const ray = new THREE.Raycaster();
  const ptr = new THREE.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return; // a drag, not a tap
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(meshes.map((m) => m.mesh), false).find((h) => h.object.userData.key !== 'other');
    if (hit) pick(hit.object.userData.key);
  });
  el.querySelectorAll('#td-parts button').forEach((b) => b.addEventListener('click', () => pick(b.dataset.key)));
  labels.querySelectorAll('.td-callout').forEach((c) => c.addEventListener('click', () => pick(c.dataset.key)));
  const slider = el.querySelector('#td-explode');
  slider.addEventListener('input', () => { only = null; explodeTarget = Number(slider.value) / 100; });
  el.querySelector('#td-toggle').addEventListener('click', (e) => {
    only = null;
    explodeTarget = explodeTarget > 0.5 ? 0 : 1;
    e.target.textContent = explodeTarget > 0.5 ? 'Assemble' : 'Explode';
  });
  el.querySelector('#td-style').addEventListener('click', (e) => {
    manualStyle = !manualStyle;
    e.target.textContent = manualStyle ? 'Shaded' : 'Manual style';
    setStyle();
  });

  // ---- walkthrough: the published procedure's real steps ----------------------
  let proc = null;
  let stepIdx = 0;
  const stepBox = el.querySelector('#td-step');
  el.querySelector('#td-walk').addEventListener('click', async () => {
    if (!proc) {
      try {
        const g = await api(`/guidance?${qs({ partNumber: MACHINE.partNumber, make: MACHINE.make, serial: MACHINE.serial })}`);
        proc = g.procedures.find((p) => p.code === 'OM-FM55-06-01') ?? g.procedures[0];
        if (!proc) throw new Error('No published procedure for this part.');
      } catch (e) {
        stepBox.hidden = false;
        stepBox.innerHTML = errorBox(e).s;
        return;
      }
    }
    stepIdx = 0;
    showStep();
  });

  function showStep() {
    const s = proc.steps[stepIdx];
    const script = STEP_SCRIPT[s.seq] ?? { explode: 0, focus: null, spin: 0 };
    only = script.only ?? null;
    explodeTarget = script.explode;
    slider.value = String(Math.round(script.explode * 100));
    spin = script.spin;
    if (script.cam) camGoal = new THREE.Vector3(...script.cam);
    picked = null;
    pick(script.focus);
    stepBox.hidden = false;
    stepBox.innerHTML = html`
      <div class="td-step-top"><span>Step ${stepIdx + 1} of ${proc.steps.length}</span><button type="button" class="td-x" aria-label="Close walkthrough">✕</button></div>
      <p class="td-step-text">${s.instruction}</p>
      ${s.caution ? html`<div class="td-caution">${s.caution}</div>` : ''}
      ${s.specs.map((sp) => html`<div class="td-spec"><span>${sp.label}</span><strong class="mono">${sp.value}${sp.unit ? ` ${sp.unit}` : ''}</strong>${s.page ? html`<span class="mono td-page">p.${s.page}</span>` : ''}</div>`)}
      <div class="td-step-src small">${proc.code} · ${proc.source.docRef} · verified by the workshop. Spec as printed; animation is illustration.</div>
      <div class="td-step-nav">
        <button class="btn" type="button" id="td-prev" ${stepIdx === 0 ? 'disabled' : ''}>Back</button>
        <button class="btn btn-primary" type="button" id="td-next">${stepIdx === proc.steps.length - 1 ? 'Finish' : 'Next step'}</button>
      </div>`.s;
    stepBox.querySelector('.td-x').addEventListener('click', endWalk);
    stepBox.querySelector('#td-prev').addEventListener('click', () => { stepIdx = Math.max(0, stepIdx - 1); showStep(); });
    stepBox.querySelector('#td-next').addEventListener('click', () => { if (stepIdx < proc.steps.length - 1) { stepIdx += 1; showStep(); } else endWalk(); });
  }
  function endWalk() {
    stepBox.hidden = true;
    spin = 0;
    only = null;
    explodeTarget = 0;
    slider.value = '0';
    camGoal = new THREE.Vector3(7, 4, 9);
  }

  // ---- loop -------------------------------------------------------------------
  function resize() {
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / Math.max(1, h);
    camera.updateProjectionMatrix();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();
  setStyle();

  const clock = new THREE.Clock();
  const tmp = new THREE.Vector3();
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    explode += (explodeTarget - explode) * Math.min(1, dt * 6);
    applyExplode();
    if (spin) rotor.rotation.x -= spin * dt;
    else rotor.rotation.x += (Math.round(rotor.rotation.x / (Math.PI * 2)) * Math.PI * 2 - rotor.rotation.x) * Math.min(1, dt * 3);
    if (camGoal) {
      camera.position.lerp(camGoal, Math.min(1, dt * 2.5));
      if (camera.position.distanceTo(camGoal) < 0.05) camGoal = null;
    }
    controls.update();
    renderer.render(scene, camera);
    // Callouts follow their parts.
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    labels.querySelectorAll('.td-callout').forEach((c) => {
      tmp.copy(anchors[c.dataset.key]()).project(camera);
      const visible = tmp.z < 1;
      c.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`;
      c.style.opacity = visible ? '1' : '0';
      c.classList.toggle('on', c.dataset.key === picked);
    });
  });

  return () => {
    renderer.setAnimationLoop(null);
    ro.disconnect();
    controls.dispose();
    renderer.dispose();
  };
}
