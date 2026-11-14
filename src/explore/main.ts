import * as THREE from 'three/webgpu';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { generateStructure } from '../arch/ArchitectureGenerator.ts';
import { districtLayout, districtPlan } from '../arch/DistrictGenerator.ts';
import { outlandsLandmarks, terrainHeight, terrainTop } from '../arch/DigitalTerrainGenerator.ts';
import { GRID, mod } from '../arch/grid.ts';
import type { ColliderPiece, StructureSpec } from '../arch/types.ts';
import { REGION_PROFILES, regionSites, TERRAIN_PROFILES } from '../arch/WorldRegionManager.ts';
import { setWorld, WORLD } from '../arch/world.ts';
import { PLANET } from '../sim/layout.ts';
import { resetCityPlan } from '../world/City.ts';
import { drawAtLod, emitComponent, GeometryWriter } from '../render/arch/ArchitectureMeshBuilder.ts';
import { archMaterial } from '../render/arch/ArchitecturalMaterialLibrary.ts';
import { ARCH_LIGHTING } from '../render/arch/BuildingLightingController.ts';
import { DESKTOP_RANGES, DigitalWorldView, finish, MOBILE_RANGES } from '../render/arch/DigitalWorldView.ts';
import { InfrastructureView } from '../render/arch/InfrastructureView.ts';
import { TerrainView } from '../render/arch/TerrainView.ts';
import { refreshGroundTextures } from '../render/cityGround.ts';
import { applyCurvature, curveOn, curveOrigin } from '../render/curvature.ts';
import { updateSkyPlanet } from '../render/neon.ts';
import { PostFX, QUALITIES, type Quality } from '../render/postfx.ts';
import { WorldView } from '../render/WorldView.ts';
import { ArchitectureDebugPanel, type LabState } from '../ui/ArchitectureDebugPanel.ts';
import { BitsView } from '../render/BitsView.ts';
import { EvolutionLabView } from '../render/EvolutionLabView.ts';
import { EvolutionLab, LAB } from '../sim/evolutionLab.ts';
import { kerbPoint } from '../sim/bits.ts';
import { EvolutionView, type LabSpeed } from '../ui/EvolutionPanel.ts';

/**
 * The Digital World Explorer: the same procedural world as the flight game (same seeds, same
 * generators, same streaming views), explored with a free camera, plus the archetype lab and
 * the full debug panel, and the Evolution Lab (a downtown district's Bits run fast under
 * pressures you set). `?seed=`, `?x=&z=&y=&yaw=&pitch=`, `?view=lab`, `?view=evo`, `?quality=`.
 */
const C = PLANET.circumference;
const params = new URLSearchParams(location.search);
const mobile = matchMedia('(pointer: coarse)').matches;

async function start() {
  if (params.has('seed')) setWorld({ seed: Number(params.get('seed')) | 0 });
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: !mobile, forceWebGL: params.get('renderer') === 'webgl' });
  await renderer.init();
  renderer.setPixelRatio(Math.min(devicePixelRatio, mobile ? 1.5 : 2));
  renderer.setSize(innerWidth, innerHeight, false);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  // --- World scene
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, innerWidth / innerHeight, 0.3, 20000);
  const worldView = new WorldView(scene, renderer, { ocean: false });
  const ranges = mobile ? MOBILE_RANGES : DESKTOP_RANGES;
  const archView = new DigitalWorldView(scene, null, { ...ranges });
  const terrainView = new TerrainView(scene, archView.ranges);
  const routeView = new InfrastructureView(scene);
  const q = params.get('quality') as Quality | null;
  const fx = new PostFX(renderer, scene, camera);
  fx.setQuality(q && QUALITIES.includes(q) ? q : mobile ? 'low' : 'medium');

  // --- Lab scene: one structure on a substrate pad under an orbit camera.
  const lab = new THREE.Scene();
  const labCam = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.5, 8000);
  labCam.position.set(260, 180, 320);
  const orbit = new OrbitControls(labCam, canvas);
  orbit.target.set(0, 60, 0);
  orbit.enabled = false;
  const labWorld = new WorldView(lab, renderer, { runways: false, ocean: false });
  const labFX = new PostFX(renderer, lab, labCam);
  labFX.setQuality(q && QUALITIES.includes(q) ? q : mobile ? 'low' : 'medium');
  let labGroup: THREE.Group | null = null;
  const labState: LabState = {
    archetype: 'tower', func: 'control-tower', variant: 'trumpet', seed: 1982, w: 246, d: 246, minH: 60, maxH: 320, intensity: 0.8,
    region: 'control', params: {}, tiers: [true, true, true], interior: true, colliders: false, activity: 'active',
  };
  let labOn = params.get('view') === 'lab';
  const labApply = (): StructureSpec => {
    const s = generateStructure({
      archetype: labState.archetype, seed: labState.seed, x: 0, z: 0, w: labState.w, d: labState.d, minHeight: labState.minH, maxHeight: labState.maxH,
      intensity: labState.intensity, region: labState.region, func: labState.func, variant: labState.variant, params: labState.params, rotation: 0,
    });
    s.activity = labState.activity;
    if (labGroup) { labGroup.removeFromParent(); labGroup.traverse((o) => (o as THREE.Mesh).geometry?.dispose()); }
    ARCH_LIGHTING.release('lab');
    const sid = ARCH_LIGHTING.acquire('lab', labState.activity, s.seed);
    ARCH_LIGHTING.setState('lab', labState.activity);
    const w = new GeometryWriter(), l = new GeometryWriter();
    for (const g of [w, l]) { g.sid = sid; g.hgtScale = 1 / Math.max(20, s.height); }
    for (const c of s.components) {
      if (!labState.tiers[c.tier - 1]) continue;
      if (c.interior && !labState.interior) continue;
      if (!drawAtLod(c, 0)) continue;
      emitComponent(c.surface === 'translucent' ? l : w, c, { ox: 0, oz: 0, rot: 0 }, 0);
    }
    labGroup = finish(w, l).group;
    if (labState.colliders) labGroup.add(colliderLines(s.colliders));
    lab.add(labGroup);
    orbit.target.set(0, Math.min(s.height, 400) * 0.4, 0);
    return s;
  };
  const showLab = (on: boolean) => {
    labOn = on;
    orbit.enabled = on;
    document.getElementById('ex-lab')!.classList.toggle('on', on);
    if (on && !labGroup) labApply();
  };

  // --- Free camera
  const cam = {
    pos: new THREE.Vector3(Number(params.get('x') ?? -3000), Number(params.get('y') ?? 160), Number(params.get('z') ?? -400)),
    yaw: Number(params.get('yaw') ?? Math.PI), pitch: Number(params.get('pitch') ?? -0.12),
    speed: 60, walk: false, vy: 0,
  };
  const keys = new Set<string>();
  window.addEventListener('keydown', (e) => {
    const t = e.target as HTMLElement;
    if (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return;
    keys.add(e.code);
    if (e.code === 'KeyF') setWalk(!cam.walk);
    if (e.code === 'KeyK') panel.visible = !panel.visible;
  });
  window.addEventListener('keyup', (e) => keys.delete(e.code));
  window.addEventListener('blur', () => keys.clear());
  let drag: { x: number; y: number; id: number } | null = null;
  canvas.addEventListener('pointerdown', (e) => {
    if (labOn || e.pointerType === 'touch') return;
    drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
  });
  window.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    cam.yaw -= (e.clientX - drag.x) * 0.004;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - (e.clientY - drag.y) * 0.004));
    drag.x = e.clientX; drag.y = e.clientY;
  });
  window.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('wheel', (e) => { if (!labOn) cam.speed = Math.max(5, Math.min(2000, cam.speed * (e.deltaY > 0 ? 0.85 : 1.18))); }, { passive: true });
  // Touch: left stick moves, right stick looks.
  const sticks = { l: { x: 0, y: 0 }, r: { x: 0, y: 0 } };
  for (const [id, s] of [['ex-stick-l', sticks.l], ['ex-stick-r', sticks.r]] as const) {
    const el = document.getElementById(id)!;
    const set = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      s.x = Math.max(-1, Math.min(1, ((e.clientX - r.left) / r.width) * 2 - 1));
      s.y = Math.max(-1, Math.min(1, ((e.clientY - r.top) / r.height) * 2 - 1));
    };
    el.addEventListener('pointerdown', (e) => { el.setPointerCapture(e.pointerId); set(e); });
    el.addEventListener('pointermove', (e) => { if (el.hasPointerCapture(e.pointerId)) set(e); });
    el.addEventListener('pointerup', () => { s.x = 0; s.y = 0; });
  }
  const setWalk = (w: boolean) => {
    cam.walk = w;
    cam.vy = 0;
    document.getElementById('ex-mode')!.textContent = w ? 'Walk' : 'Fly';
    document.getElementById('ex-mode')!.classList.toggle('on', w);
    if (w) cam.speed = 12;
    else cam.speed = 60;
  };
  document.getElementById('ex-mode')!.addEventListener('click', () => setWalk(!cam.walk));

  /** Solids near (x, z): structure and infrastructure colliders of the districts around (image-shifted). */
  const solidsNear = (x: number, z: number): ColliderPiece[] => {
    const out: ColliderPiece[] = [];
    const ci = Math.floor(mod(x - GRID.x0, C) / GRID.chunkSize), cj = Math.floor(mod(z - GRID.z0, C) / GRID.chunkSize);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
      const d = districtPlan(ci + a, cj + b);
      const ox = Math.round((x - (d.x + GRID.chunkSize / 2)) / C) * C, oz = Math.round((z - (d.z + GRID.chunkSize / 2)) / C) * C;
      const add = (c: ColliderPiece) => { if (Math.abs(c.x + ox - x) < c.sx / 2 + 40 && Math.abs(c.z + oz - z) < c.sz / 2 + 40) out.push({ ...c, x: c.x + ox, z: c.z + oz }); };
      for (const s of d.structures) for (const c of s.colliders) add(c);
      for (const c of d.infra.colliders) add(c);
    }
    return out;
  };
  /** Walking: stand on the highest surface within a step, slide along walls. */
  const R = 0.5, EYE = 1.75, STEP = 1.2;
  const walk = (next: THREE.Vector3, dt: number) => {
    const solids = solidsNear(next.x, next.z);
    const feet = cam.pos.y - EYE;
    for (const c of solids) {
      const y0 = c.y - c.sy / 2, y1 = c.y + c.sy / 2;
      if (y1 <= feet + STEP || y0 >= feet + EYE) continue; // underfoot or overhead
      const hx = c.sx / 2 + R, hz = c.sz / 2 + R;
      const dx = next.x - c.x, dz = next.z - c.z;
      if (Math.abs(dx) < hx && Math.abs(dz) < hz) {
        // Push out along the shallower axis.
        const px = hx - Math.abs(dx), pz = hz - Math.abs(dz);
        if (px < pz) next.x = c.x + Math.sign(dx || 1) * hx; else next.z = c.z + Math.sign(dz || 1) * hz;
      }
    }
    let ground = terrainHeight(next.x, next.z);
    for (const c of solids) {
      const y1 = c.y + c.sy / 2;
      if (y1 > feet + STEP) continue;
      if (Math.abs(next.x - c.x) < c.sx / 2 && Math.abs(next.z - c.z) < c.sz / 2) ground = Math.max(ground, y1);
    }
    cam.vy -= 9.81 * dt;
    let y = cam.pos.y + cam.vy * dt;
    if (y - EYE <= ground) { y = ground + EYE; cam.vy = 0; }
    next.y = y;
  };

  // --- Travel destinations
  const go = document.getElementById('ex-go') as HTMLSelectElement;
  type Dest = { label: string; x: number; z: number; y: number; yaw?: number };
  const dests: Array<[string, Dest[]]> = [];
  const buildDests = () => {
    dests.length = 0;
    const examples: Dest[] = [];
    const seen = new Set<string>();
    for (const s of regionSites()) {
      const key = s.kind === 'outlands' ? `t:${s.terrain}` : s.kind === 'city' ? `c:${s.city}` : '';
      if (!key || seen.has(key)) continue;
      seen.add(key);
      const label = s.kind === 'outlands' ? `Outlands: ${TERRAIN_PROFILES[s.terrain].label}` : `${REGION_PROFILES[s.city].label}`;
      examples.push({ label: `${label} (${s.name})`, x: s.x, z: s.z, y: s.kind === 'outlands' ? 180 : 140 });
    }
    examples.sort((a, b) => a.label.localeCompare(b.label));
    const landmarks: Dest[] = [];
    for (let i = 0; i < GRID.chunks; i++) for (let j = 0; j < GRID.chunks; j++) for (const l of districtLayout(i, j).lots) {
      if (l.kind !== 'landmark' || !l.landmark) continue;
      landmarks.push({ label: l.landmark, x: (l.rect.x0 + l.rect.x1) / 2, z: (l.rect.z0 + l.rect.z1) / 2 + 700, y: 220 });
    }
    landmarks.sort((a, b) => (a.label === 'Grid Spire' ? -1 : b.label === 'Grid Spire' ? 1 : a.label.localeCompare(b.label, undefined, { numeric: true })));
    const outl: Dest[] = outlandsLandmarks().slice(0, 30).map((l, i) => ({ label: `Outlands landmark ${i + 1} (${TERRAIN_PROFILES[l.arch].label})`, x: l.x, z: l.z + 650, y: 200 }));
    dests.push(['Regions and terrain', examples], ['Landmarks', landmarks.slice(0, 40)], ['Outlands landmarks', outl]);
    go.innerHTML = '<option value="">Travel to…</option>' + dests.map(([g, list], gi) => `<optgroup label="${g}">${list.map((d, i) => `<option value="${gi}:${i}">${d.label}</option>`).join('')}</optgroup>`).join('');
  };
  const teleport = (x: number, z: number, y?: number) => {
    cam.pos.set(x, y ?? Math.max(120, terrainTop(x, z) + 120), z);
    cam.vy = 0;
    worldView.atmosphere.snap();
  };
  go.addEventListener('change', () => {
    const [gi, i] = go.value.split(':').map(Number);
    const d = dests[gi]?.[1][i];
    if (d) { teleport(d.x, d.z, d.y); cam.yaw = d.yaw ?? Math.PI; cam.pitch = -0.18; showLab(false); panel.setTab('world'); }
    go.value = '';
    go.blur();
  });

  // --- Panel
  const panel = new ArchitectureDebugPanel({
    world: archView, terrain: terrainView, routes: routeView, sky: worldView, camera, canvas,
    lab: { state: labState, apply: labApply, show: showLab },
    regenerate: (seed, transition) => {
      setWorld({ seed, transition });
      resetCityPlan();
      refreshGroundTextures();
      archView.clear();
      terrainView.clear();
      routeView.clear();
      buildDests();
      const u = new URL(location.href);
      u.searchParams.set('seed', String(seed));
      history.replaceState(null, '', u);
    },
    teleport,
  });
  panel.visible = !mobile && params.get('panel') !== '0';
  document.getElementById('ex-panel')!.addEventListener('click', () => { panel.visible = !panel.visible; });
  document.getElementById('ex-lab')!.addEventListener('click', () => { panel.visible = true; panel.setTab(labOn ? 'world' : 'lab'); });

  // --- Evolution Lab: the real district, its Bits evolving fast, charted.
  let evo: { lab: EvolutionLab; bits: BitsView; hazards: EvolutionLabView; panel: HTMLDivElement; view: EvolutionView; speed: LabSpeed; acc: number; shown: number } | null = null;
  let evoOn = false;
  const showEvo = (on: boolean) => {
    evoOn = on;
    document.getElementById('ex-evo')!.classList.toggle('on', on);
    if (on && !evo) {
      const lab = new EvolutionLab();
      const el = document.createElement('div');
      el.id = 'evo-panel';
      const h = document.createElement('h3');
      h.textContent = 'EVOLUTION LAB';
      el.append(h);
      const view = new EvolutionView(() => lab.history, { lab, speed: () => evo?.speed ?? 0, setSpeed: (sp) => { if (evo) evo.speed = sp; } });
      el.append(view.root);
      document.body.append(el);
      evo = { lab, bits: new BitsView(scene, lab.bits, null), hazards: new EvolutionLabView(scene, lab), panel: el, view, speed: 10, acc: 0, shown: 0 };
    }
    if (!evo) return;
    evo.panel.classList.toggle('hidden', !on);
    evo.bits.setVisible(on);
    evo.hazards.visible = on;
    if (on) {
      // From the street, onto the busiest stretch of kerb (fly about from there).
      const kerb = evo.lab.bits.people.filter((p) => p.place === 'kerb');
      const near = (p: (typeof kerb)[number]) => kerb.filter((q) => Math.hypot(q.x - p.x, q.z - p.z) < 25).length;
      const at = kerb.reduce<(typeof kerb)[number] | null>((a, p) => (!a || near(p) > near(a) ? p : a), null);
      const k = { x: evo.lab.centre.x, z: evo.lab.centre.z, tx: 1, tz: 0 };
      if (at) kerbPoint(at.home, at.s, 0, k);
      const nx = k.tz, nz = -k.tx; // out from the lot, over the street
      teleport(k.x + nx * 30, k.z + nz * 30, terrainHeight(k.x + nx * 30, k.z + nz * 30) + 14);
      cam.yaw = Math.atan2(nx, nz);
      cam.pitch = -0.36;
      if (labOn) { showLab(false); panel.setTab('world'); }
      evo.view.refresh();
    }
  };
  document.getElementById('ex-evo')!.addEventListener('click', () => showEvo(!evoOn));
  const stepEvo = (dt: number) => {
    if (!evo || !evoOn) return;
    const lab = evo.lab;
    if (evo.speed === 'turbo') {
      const t0 = performance.now();
      while (performance.now() - t0 < 14) for (let i = 0; i < 20; i++) lab.step();
    } else if (evo.speed > 0) {
      evo.acc = Math.min(evo.acc + dt * evo.speed, LAB.dt * 400);
      while (evo.acc >= LAB.dt) { lab.step(); evo.acc -= LAB.dt; }
    }
    evo.bits.update(lab.time, 1);
    evo.hazards.update();
    evo.shown += dt;
    if (evo.shown > 0.5) { evo.shown = 0; evo.view.refresh(); }
  };

  buildDests();
  document.getElementById('ex-loading')?.remove();
  if (params.get('view') === 'evo') showEvo(true);
  if (labOn) { panel.visible = true; panel.setTab('lab'); }

  window.addEventListener('resize', () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = labCam.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    labCam.updateProjectionMatrix();
  });

  // --- Loop
  let last = performance.now();
  let tick = 0;
  const fwd = new THREE.Vector3(), right = new THREE.Vector3(), next = new THREE.Vector3();
  const frame = () => {
    requestAnimationFrame(frame);
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (labOn) {
      orbit.update();
      curveOn.value = 0;
      curveOrigin.value.copy(labCam.position);
      updateSkyPlanet(0, PLANET.radius);
      labWorld.update(labCam, orbit.target, dt);
      ARCH_LIGHTING.flush();
      if (++tick % 60 === 1) applyCurvature(lab);
      labFX.render();
      panel.update(dt);
      return;
    }
    curveOn.value = 1;
    // Movement.
    cam.yaw -= sticks.r.x * dt * 1.6;
    cam.pitch = Math.max(-1.5, Math.min(1.5, cam.pitch - sticks.r.y * dt * 1.2));
    fwd.set(-Math.sin(cam.yaw) * Math.cos(cam.walk ? 0 : cam.pitch), cam.walk ? 0 : Math.sin(cam.pitch), -Math.cos(cam.yaw) * Math.cos(cam.walk ? 0 : cam.pitch)).normalize();
    right.set(Math.cos(cam.yaw), 0, -Math.sin(cam.yaw));
    const boost = keys.has('ShiftLeft') || keys.has('ShiftRight') ? 5 : 1;
    const v = cam.speed * boost * dt;
    next.copy(cam.pos);
    const f = (keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0) - (keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0) - sticks.l.y;
    const s = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0) + sticks.l.x;
    next.addScaledVector(fwd, f * v).addScaledVector(right, s * v);
    if (cam.walk) {
      if (keys.has('Space') && cam.vy === 0) cam.vy = 5;
      walk(next, dt);
    } else {
      next.y += ((keys.has('KeyE') || keys.has('Space') ? 1 : 0) - (keys.has('KeyQ') || keys.has('KeyC') ? 1 : 0)) * v;
      next.y = Math.max(next.y, terrainTop(next.x, next.z) + 2);
    }
    cam.pos.copy(next);
    // Stay in the canonical image (the world wraps).
    if (Math.abs(cam.pos.x) > C / 2) cam.pos.x -= Math.sign(cam.pos.x) * C;
    if (Math.abs(cam.pos.z) > C / 2) cam.pos.z -= Math.sign(cam.pos.z) * C;
    camera.position.copy(cam.pos);
    camera.rotation.set(cam.pitch, cam.yaw, 0, 'YXZ');
    camera.updateMatrixWorld();
    const alt = Math.max(0, camera.position.y);
    const far = Math.max(20000, Math.min(PLANET.radius * 12, 6000 + Math.sqrt(2 * PLANET.radius * alt + alt * alt) * 1.15));
    const near = Math.min(20, Math.max(0.1, alt / 4000));
    if (Math.abs(camera.far - far) > far * 0.05 || camera.near !== near) { camera.far = far; camera.near = near; camera.updateProjectionMatrix(); }
    curveOrigin.value.copy(camera.position);
    updateSkyPlanet(camera.position.y, PLANET.radius);
    worldView.update(camera, camera.position, dt);
    archView.update(camera);
    terrainView.update(camera);
    routeView.update(camera.position);
    if (++tick % 60 === 1) applyCurvature(scene);
    stepEvo(dt);
    fx.render();
    panel.update(dt);
  };
  requestAnimationFrame(frame);

  Object.assign(window, {
    explorer: {
      renderer, scene, camera, cam, archView, terrainView, routeView, worldView, panel, labState, WORLD,
      goto: (x: number, z: number, y: number, yaw = cam.yaw, pitch = cam.pitch) => { teleport(x, z, y); cam.yaw = yaw; cam.pitch = pitch; },
      lab: (on = true) => { panel.visible = true; panel.setTab(on ? 'lab' : 'world'); },
      evo: (on = true) => showEvo(on),
      evolution: () => evo?.lab ?? null,
      labCamera: labCam,
      orbit,
      setWalk,
      ready: () => archView.stats().pending === 0 && terrainView.stats().pending === 0,
    },
  });
}

/** Collider boxes as lines (lab inspection). */
function colliderLines(cols: ColliderPiece[]): THREE.LineSegments {
  const pos: number[] = [];
  for (const c of cols) {
    const x0 = c.x - c.sx / 2, x1 = c.x + c.sx / 2, y0 = c.y - c.sy / 2, y1 = c.y + c.sy / 2, z0 = c.z - c.sz / 2, z1 = c.z + c.sz / 2;
    const P = [[x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]];
    for (const [a, b] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) pos.push(...P[a], ...P[b]);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  return new THREE.LineSegments(g, new THREE.LineBasicNodeMaterial({ color: new THREE.Color('#ff7a1a').multiplyScalar(2) }));
}

void archMaterial;
start().catch((err) => {
  console.error(err);
  const el = document.getElementById('ex-loading');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
