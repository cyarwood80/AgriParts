// Embeddable 3D exploded view for the part page (ADR-0006, layer 2).
//
// Geometry here is INVENTED for the demo: simplified assemblies built from
// primitives. In production the assembly comes from licensed OEM CAD or a
// model of the licensed parts-book figure, checked by the foreman; the
// controller API below stays the same.
//
// modelFor() is cheap and synchronous (no three.js); mount() loads three.js
// on demand so the rest of the app never depends on the CDN.

const MODELS = {
  flail: {
    title: 'Flail rotor, one hammer station',
    camera: [5.4, 3.4, 6.6], target: [0, 0.8, 0],
    parts: [
      { key: 'hammer', name: 'Flail hammer', pn: 'DH-10442', words: ['hammer', 'flail'] },
      { key: 'bolt', name: 'Hammer bolt (single use)', words: ['bolt'] },
      { key: 'nut', name: 'Hammer nut (single use)', words: ['nut'] },
      { key: 'lug', name: 'Hammer lug (part of rotor)', words: ['lug'] },
      { key: 'opposite', name: 'Opposite hammer (fit in pairs)', pn: 'DH-10442', words: ['opposite', 'pair'] },
      { key: 'bearing', name: 'Rotor bearing, 2-bolt flange', pn: 'DH-10471', words: ['bearing', 'grease'] },
      { key: 'rotor', name: 'Rotor tube', words: ['rotor', 'shaft', 'rotate', 'spin'] },
    ],
    build(T, add) {
      const rotor = new T.Group();
      add(new T.CylinderGeometry(0.55, 0.55, 3.6, 40), 'rotor', rotor, [0, 0, 0], [0, 0, Math.PI / 2]);
      add(new T.CylinderGeometry(0.2, 0.2, 4.6, 20), 'rotor', rotor, [0, 0, 0], [0, 0, Math.PI / 2]);
      const g = {};
      for (let i = -2; i <= 2; i++) {
        for (const side of [0, Math.PI]) {
          const arm = new T.Group();
          arm.position.x = i * 0.7;
          arm.rotation.x = i * 0.9 + side;
          rotor.add(arm);
          const main = i === 0 && side === 0;
          const opp = i === 0 && side === Math.PI;
          for (const dx of [-0.13, 0.13]) add(new T.BoxGeometry(0.06, 0.42, 0.34), main ? 'lug' : 'rotor', arm, [dx, 0.68, 0]);
          const hammer = new T.Group();
          hammer.position.y = 0.82;
          arm.add(hammer);
          const k = main ? 'hammer' : opp ? 'opposite' : 'other';
          add(new T.BoxGeometry(0.18, 0.62, 0.16), k, hammer, [0, 0.28, 0]);
          add(new T.BoxGeometry(0.22, 0.16, 0.52), k, hammer, [0, 0.62, 0.12]);
          if (main) {
            g.hammer = hammer;
            g.bolt = add(new T.CylinderGeometry(0.05, 0.05, 0.56, 14), 'bolt', arm, [0, 0.82, 0], [0, 0, Math.PI / 2]);
            add(new T.CylinderGeometry(0.09, 0.09, 0.05, 6), 'bolt', g.bolt, [0, 0.29, 0]);
            g.nut = add(new T.CylinderGeometry(0.09, 0.09, 0.08, 6), 'nut', arm, [-0.22, 0.82, 0], [0, 0, Math.PI / 2]);
            g.arm = arm;
          }
          if (opp) g.opposite = hammer;
        }
      }
      const bearing = new T.Group();
      bearing.position.x = 2.45;
      add(new T.CylinderGeometry(0.38, 0.38, 0.3, 30), 'bearing', bearing, [0, 0, 0], [0, 0, Math.PI / 2]);
      add(new T.BoxGeometry(0.16, 1.5, 0.52), 'bearing', bearing, [0, 0, 0]);
      g.bearing = bearing;
      return {
        root: [rotor, bearing],
        moves: {
          bolt: { obj: g.bolt, by: [1.3, 0, 0] },
          nut: { obj: g.nut, by: [-1.0, 0, 0] },
          hammer: { obj: g.hammer, by: [0, 1.4, 0] },
          bearing: { obj: g.bearing, by: [1.3, 0, 0] },
        },
        anchors: {
          hammer: () => g.hammer.localToWorld(new T.Vector3(0, 0.66, 0.36)),
          bolt: () => g.bolt.localToWorld(new T.Vector3(0, 0.3, 0)),
          nut: () => g.nut.localToWorld(new T.Vector3(0, -0.05, 0)),
          lug: () => g.arm.localToWorld(new T.Vector3(0.13, 0.75, 0.18)),
          opposite: () => g.opposite.localToWorld(new T.Vector3(0, 0.62, 0.3)),
          bearing: () => g.bearing.localToWorld(new T.Vector3(0, 0.78, 0)),
          rotor: () => new T.Vector3(-1.2, 0.5, 0.35),
        },
      };
    },
  },

  spinOn: {
    title: 'Spin-on filter on its head',
    camera: [4.8, 1.2, 6.0], target: [-0.3, -1.0, 0], floor: -2.9,
    parts: [
      { key: 'filter', name: 'Filter, spin-on', words: ['filter', 'canister', 'cartridge', 'element'] },
      { key: 'seal', name: 'Sealing ring (on the filter)', words: ['seal', 'gasket', 'o-ring', 'ring', 'oil the'] },
      { key: 'head', name: 'Filter head', words: ['head', 'thread', 'housing'] },
      { key: 'block', name: 'Engine block / mounting', words: ['engine', 'sump', 'drain', 'block', 'level'] },
    ],
    build(T, add) {
      const g = {};
      const block = new T.Group();
      add(new T.BoxGeometry(2.0, 1.8, 1.6), 'block', block, [-1.55, 0.2, 0]);
      add(new T.BoxGeometry(2.2, 0.25, 1.8), 'block', block, [-1.55, -0.82, 0]);
      add(new T.CylinderGeometry(0.12, 0.12, 0.2, 6), 'block', block, [-1.0, -1.02, 0.4]);
      g.head = new T.Group();
      add(new T.BoxGeometry(0.7, 0.55, 0.9), 'head', g.head, [-0.25, 0.35, 0]);
      add(new T.CylinderGeometry(0.5, 0.5, 0.3, 36), 'head', g.head, [0.25, 0.25, 0]);
      add(new T.CylinderGeometry(0.11, 0.11, 0.35, 16), 'head', g.head, [0.25, -0.05, 0]);
      g.seal = add(new T.TorusGeometry(0.4, 0.04, 10, 40), 'seal', null, [0.25, 0.04, 0], [Math.PI / 2, 0, 0]);
      g.filter = new T.Group();
      g.filter.position.set(0.25, -0.62, 0);
      add(new T.CylinderGeometry(0.47, 0.47, 1.25, 40), 'filter', g.filter, [0, 0, 0]);
      add(new T.CylinderGeometry(0.43, 0.47, 0.1, 40), 'filter', g.filter, [0, 0.66, 0]);
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        add(new T.BoxGeometry(0.06, 0.18, 0.03), 'filter', g.filter, [Math.cos(a) * 0.475, -0.48, Math.sin(a) * 0.475], [0, -a, 0]);
      }
      return {
        root: [block, g.head, g.seal, g.filter],
        moves: {
          filter: { obj: g.filter, by: [0, -1.5, 0] },
          seal: { obj: g.seal, by: [0, -0.75, 0] },
        },
        anchors: {
          filter: () => g.filter.localToWorld(new T.Vector3(0.48, -0.1, 0.2)),
          seal: () => g.seal.localToWorld(new T.Vector3(0.42, 0, 0)),
          head: () => g.head.localToWorld(new T.Vector3(-0.25, 0.65, 0.4)),
          block: () => new T.Vector3(-2.0, 1.1, 0.8),
        },
      };
    },
  },

  airFilter: {
    title: 'Air cleaner, two-stage',
    camera: [5.2, 2.6, 5.8], target: [1.4, 0, 0],
    parts: [
      { key: 'outer', name: 'Outer (primary) element', pn: 'ACM-30552', words: ['outer', 'primary', 'element', 'filter'] },
      { key: 'inner', name: 'Inner (safety) element', pn: 'ACM-30553', words: ['inner', 'safety'] },
      { key: 'cover', name: 'End cover and clips', words: ['cover', 'clip', 'cap', 'valve'] },
      { key: 'housing', name: 'Air cleaner housing', words: ['housing', 'inside', 'wipe', 'clean'] },
    ],
    build(T, add) {
      const g = {};
      const housing = new T.Group();
      add(new T.CylinderGeometry(0.8, 0.8, 2.0, 44, 1, true), 'housing', housing, [0, 0, 0], [0, 0, Math.PI / 2]);
      add(new T.CylinderGeometry(0.8, 0.8, 0.06, 44), 'housing', housing, [-1.0, 0, 0], [0, 0, Math.PI / 2]);
      add(new T.CylinderGeometry(0.28, 0.28, 0.7, 24), 'housing', housing, [-0.4, 0.95, 0]);
      g.outer = new T.Group();
      add(new T.CylinderGeometry(0.7, 0.7, 1.8, 44, 1, true), 'outer', g.outer, [0, 0, 0], [0, 0, Math.PI / 2]);
      for (let i = 0; i < 28; i++) {
        const a = (i / 28) * Math.PI * 2;
        add(new T.BoxGeometry(1.76, 0.05, 0.02), 'outer', g.outer, [0, Math.cos(a) * 0.71, Math.sin(a) * 0.71], [a, 0, 0]);
      }
      add(new T.TorusGeometry(0.62, 0.07, 10, 40), 'outer', g.outer, [0.9, 0, 0], [0, Math.PI / 2, 0]);
      g.inner = new T.Group();
      add(new T.CylinderGeometry(0.42, 0.42, 1.85, 36), 'inner', g.inner, [0, 0, 0], [0, 0, Math.PI / 2]);
      add(new T.TorusGeometry(0.38, 0.05, 8, 32), 'inner', g.inner, [0.93, 0, 0], [0, Math.PI / 2, 0]);
      g.cover = new T.Group();
      add(new T.CylinderGeometry(0.86, 0.86, 0.16, 44), 'cover', g.cover, [0, 0, 0], [0, 0, Math.PI / 2]);
      add(new T.CylinderGeometry(0.12, 0.18, 0.3, 16), 'cover', g.cover, [0, -0.85, 0]);
      for (const a of [0.5, 2.6, 4.7]) add(new T.BoxGeometry(0.3, 0.1, 0.12), 'cover', g.cover, [-0.15, Math.cos(a) * 0.88, Math.sin(a) * 0.88], [a, 0, 0]);
      g.cover.position.x = 1.08;
      return {
        root: [housing, g.outer, g.inner, g.cover],
        moves: {
          cover: { obj: g.cover, by: [1.0, 0, 0] },
          outer: { obj: g.outer, by: [2.4, 0, 0] },
          inner: { obj: g.inner, by: [3.5, 0, 0] },
        },
        anchors: {
          outer: () => g.outer.localToWorld(new T.Vector3(0.2, 0.74, 0.2)),
          inner: () => g.inner.localToWorld(new T.Vector3(0.5, 0.44, 0.1)),
          cover: () => g.cover.localToWorld(new T.Vector3(0, 0.9, 0.2)),
          housing: () => new T.Vector3(-0.5, 0.84, 0.4),
        },
      };
    },
  },
};

/**
 * Which 3D model shows this part, and which piece of it is the part.
 * Null when there's no model yet: the page falls back to the 2D diagram.
 */
export function modelFor(part) {
  const t = `${part.partNumber} ${part.description ?? ''} ${part.guide?.title ?? ''}`.toLowerCase();
  if (/bearing/.test(t) && /^dh/i.test(part.partNumber)) return { key: 'flail', focus: 'bearing' };
  if (/hammer|flail/.test(t)) return { key: 'flail', focus: 'hammer' };
  if (/air filter|air cleaner|air element/.test(t)) return { key: 'airFilter', focus: /inner|safety/.test(t) ? 'inner' : 'outer' };
  if (/filter/.test(t)) return { key: 'spinOn', focus: 'filter' };
  return null;
}

export function modelParts(key) {
  return MODELS[key]?.parts ?? [];
}

const REMOVE = /\b(remove|undo|unscrew|loosen|take off|withdraw|drain|pull|lift out|knock out|release)\b/i;
const FIT = /\b(fit|refit|install|screw on|tighten|torque|reassemble|replace the|push|seat)\b/i;

/**
 * Mount the viewer. Returns a controller:
 *   explode(t 0..1), highlight(key), step(instruction) -> key, setStyle('shaded'|'manual'), dispose()
 */
export async function mount(container, model, { partNumber, onPick } = {}) {
  const T = await import('three');
  const { OrbitControls } = await import('three/addons/controls/OrbitControls.js');
  const { RoomEnvironment } = await import('three/addons/environments/RoomEnvironment.js');
  const def = MODELS[model.key];
  const parts = def.parts.map((p, i) => ({ ...p, n: i + 1, pn: p.key === model.focus && partNumber ? partNumber : p.pn ?? null }));

  container.classList.add('m3d');
  container.innerHTML = '<div class="m3d-stage"></div><div class="m3d-labels" aria-hidden="true"></div>';
  const stage = container.querySelector('.m3d-stage');
  const labels = container.querySelector('.m3d-labels');

  const renderer = new T.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFSoftShadowMap;
  stage.appendChild(renderer.domElement);
  renderer.domElement.setAttribute('aria-label', `${def.title}. Drag to turn, scroll to zoom.`);
  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(35, 1, 0.1, 100);
  camera.position.set(...def.camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.target.set(...def.target);
  controls.enableDamping = true;
  controls.minDistance = 2.5;
  controls.maxDistance = 14;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 0.6;
  controls.addEventListener('start', () => { controls.autoRotate = false; });

  // Studio lighting: an environment for reflections, a soft key light that casts shadows, a cool rim.
  const pmrem = new T.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTex;
  scene.add(new T.HemisphereLight(0xffffff, 0x2a3530, 0.35));
  const key = new T.DirectionalLight(0xfff4e6, 2.4);
  key.position.set(4, 9, 5);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  key.shadow.camera.left = -6; key.shadow.camera.right = 6; key.shadow.camera.top = 6; key.shadow.camera.bottom = -6;
  key.shadow.camera.near = 1; key.shadow.camera.far = 30;
  key.shadow.radius = 6;
  key.shadow.bias = -0.0004;
  key.target.position.set(...def.target);
  scene.add(key, key.target);
  const rim = new T.DirectionalLight(0x9fe8c8, 1.1);
  rim.position.set(-6, 3, -5);
  scene.add(rim);

  const meshes = [];
  const lineMat = new T.LineBasicMaterial({ color: 0x14201b, transparent: true, opacity: 0.35 });
  function add(geom, k, parent, pos = [0, 0, 0], rot = [0, 0, 0]) {
    const mesh = new T.Mesh(geom, new T.MeshPhysicalMaterial({ color: 0xb9c2bd, roughness: 0.35, metalness: 0.85, envMapIntensity: 1.1 }));
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(...pos);
    mesh.rotation.set(...rot);
    mesh.userData.key = k;
    const edges = new T.LineSegments(new T.EdgesGeometry(geom, 30), lineMat);
    mesh.add(edges);
    if (parent) parent.add(mesh);
    meshes.push({ mesh, key: k, edges });
    return mesh;
  }
  const built = def.build(T, add);
  for (const r of built.root) scene.add(r);
  const base = Object.fromEntries(Object.entries(built.moves).map(([k, m]) => [k, m.obj.position.clone()]));

  // Soft floor shadow.
  const shadowTex = (() => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const x = c.getContext('2d');
    const gr = x.createRadialGradient(64, 64, 4, 64, 64, 62);
    gr.addColorStop(0, 'rgba(20,32,27,0.28)');
    gr.addColorStop(1, 'rgba(20,32,27,0)');
    x.fillStyle = gr;
    x.fillRect(0, 0, 128, 128);
    return new T.CanvasTexture(c);
  })();
  const floor = new T.Mesh(new T.PlaneGeometry(9, 5), new T.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2;
  floor.position.set(def.target[0], def.floor ?? -1.9, def.target[2]);
  scene.add(floor);
  // Real cast shadows on an invisible ground.
  const ground = new T.Mesh(new T.PlaneGeometry(40, 40), new T.ShadowMaterial({ opacity: 0.38 }));
  ground.rotation.x = -Math.PI / 2;
  ground.position.set(def.target[0], (def.floor ?? -1.9) + 0.001, def.target[2]);
  ground.receiveShadow = true;
  scene.add(ground);

  labels.innerHTML = parts.map((p) => `<button type="button" class="m3d-callout${p.key === model.focus ? ' is-focus' : ''}" data-key="${p.key}" tabindex="-1"><span class="m3d-n">${p.n}</span><span class="m3d-tag">${p.pn ? `<b>${p.pn}</b> ` : ''}${p.name}</span></button>`).join('');

  let style = 'shaded';
  let picked = model.focus;
  let explode = 0;
  let explodeTarget = 0;
  let only = null;
  let spin = 0;

  function paint() {
    for (const m of meshes) {
      const focus = m.key === picked || (m.key === model.focus && !picked);
      const hot = focus;
      const mat = m.mesh.material;
      if (style === 'manual') {
        mat.color.set(hot ? 0xcfe8de : 0xf6f6f2);
        mat.metalness = 0;
        mat.roughness = 1;
        m.edges.material = lineMatManual;
        mat.clearcoat = 0;
        m.edges.visible = true;
        mat.emissive.set(0x000000);
      } else {
        // Finishes: the part in gloss paint, castings dark and satin, painted frame, bright steel for fasteners.
        const cast = m.key === 'block' || m.key === 'housing' || m.key === 'head';
        const frame = m.key === 'rotor' || m.key === 'other' || m.key === 'lug' || m.key === 'bearing' || m.key === 'cover';
        if (hot) { mat.color.set(0x0f9a63); mat.metalness = 0.25; mat.roughness = 0.3; mat.clearcoat = 1; mat.clearcoatRoughness = 0.06; }
        else if (cast) { mat.color.set(0x56605b); mat.metalness = 0.65; mat.roughness = 0.55; mat.clearcoat = 0; }
        else if (frame) { mat.color.set(0x6b736f); mat.metalness = 0.35; mat.roughness = 0.42; mat.clearcoat = 0.6; mat.clearcoatRoughness = 0.25; }
        else { mat.color.set(0xc9d0cc); mat.metalness = 0.95; mat.roughness = 0.22; mat.clearcoat = 0; }
        mat.emissive.set(hot ? 0x021a10 : 0x000000);
        m.edges.visible = false;
      }
    }
    labels.querySelectorAll('.m3d-callout').forEach((c) => c.classList.toggle('is-on', c.dataset.key === picked));
  }
  const lineMatManual = new T.LineBasicMaterial({ color: 0x14201b });

  function highlight(k) {
    picked = k ?? model.focus;
    paint();
  }

  const ray = new T.Raycaster();
  const ptr = new T.Vector2();
  let downAt = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { downAt = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 6) return;
    const r = renderer.domElement.getBoundingClientRect();
    ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ptr, camera);
    const hit = ray.intersectObjects(meshes.map((m) => m.mesh), false).find((h) => h.object.userData.key !== 'other');
    if (hit) { highlight(hit.object.userData.key); onPick?.(parts.find((p) => p.key === hit.object.userData.key)); }
  });
  labels.querySelectorAll('.m3d-callout').forEach((c) => c.addEventListener('click', () => {
    highlight(c.dataset.key);
    onPick?.(parts.find((p) => p.key === c.dataset.key));
  }));

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
  paint();

  const clock = new T.Clock();
  const tmp = new T.Vector3();
  const rotorRoot = model.key === 'flail' ? built.root[0] : null;
  renderer.setAnimationLoop(() => {
    const dt = Math.min(0.05, clock.getDelta());
    explode += (explodeTarget - explode) * Math.min(1, dt * 5);
    for (const [k, m] of Object.entries(built.moves)) {
      const amt = only && !only.includes(k) ? 0 : explode;
      m.obj.position.copy(base[k]).add(tmp.set(...m.by).multiplyScalar(amt));
    }
    if (rotorRoot) {
      if (spin) rotorRoot.rotation.x -= spin * dt;
      else rotorRoot.rotation.x += (Math.round(rotorRoot.rotation.x / (Math.PI * 2)) * Math.PI * 2 - rotorRoot.rotation.x) * Math.min(1, dt * 3);
    }
    controls.update();
    renderer.render(scene, camera);
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    labels.querySelectorAll('.m3d-callout').forEach((c) => {
      const a = built.anchors[c.dataset.key];
      if (!a) return;
      tmp.copy(a()).project(camera);
      c.style.transform = `translate(${((tmp.x + 1) / 2) * w}px, ${((1 - tmp.y) / 2) * h}px)`;
      c.style.opacity = tmp.z < 1 ? '1' : '0';
    });
  });

  return {
    title: def.title,
    parts,
    explode(t, keys = null) { only = keys; explodeTarget = t; },
    highlight,
    setStyle(s) { style = s; paint(); },
    /** Animate for a procedure step: what it mentions lights up; removing explodes, fitting closes up. */
    step(instruction) {
      controls.autoRotate = false;
      const text = instruction.toLowerCase();
      const hit = parts.find((p) => p.key !== 'rotor' && p.words.some((w) => text.includes(w))) ?? parts.find((p) => p.words.some((w) => text.includes(w)));
      const k = hit?.key ?? model.focus;
      highlight(k);
      spin = model.key === 'flail' && /\b(run|spin|rotate)\b/.test(text) ? 3 : 0;
      // Only the pieces the step names move; a step about something else leaves the assembly closed.
      const moving = parts.filter((p) => built.moves[p.key] && p.words.some((w) => text.includes(w))).map((p) => p.key);
      if (moving.includes('filter') && built.moves.seal) moving.push('seal');
      if (REMOVE.test(text) && moving.length) this.explode(1, moving);
      else if (FIT.test(text) && moving.length) this.explode(0.15, moving);
      else this.explode(0);
      return k;
    },
    reset() { spin = 0; only = null; explodeTarget = 0; highlight(model.focus); },
    dispose() {
      renderer.setAnimationLoop(null);
      ro.disconnect();
      controls.dispose();
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}
