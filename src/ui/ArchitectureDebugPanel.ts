import * as THREE from 'three/webgpu';
import { ARCHETYPE_IDS, ARCHETYPES } from '../arch/BuildingArchetypeRegistry.ts';
import { districtPlan } from '../arch/DistrictGenerator.ts';
import { wastelandAt } from '../arch/DigitalTerrainGenerator.ts';
import { GRID, mod } from '../arch/grid.ts';
import { ACTIVITY_STATES, LIGHT_MEANING, type ActivityState } from '../arch/palette.ts';
import { primitiveTriangles } from '../arch/grammar.ts';
import type { ArchetypeId, StructureSpec } from '../arch/types.ts';
import { CITY_REGIONS, cityRegionAt, REGION_PROFILES, regionAt, terrainMixAt, TERRAIN_ARCHETYPES, TERRAIN_PROFILES } from '../arch/WorldRegionManager.ts';
import { WORLD } from '../arch/world.ts';
import { PLANET } from '../sim/layout.ts';
import { blockSummary, BLOCK_KIND } from '../world/planetCity.ts';
import { ARCH_PARAMS } from '../render/arch/ArchitecturalMaterialLibrary.ts';
import { ARCH_LIGHTING } from '../render/arch/BuildingLightingController.ts';
import type { DigitalWorldView } from '../render/arch/DigitalWorldView.ts';
import type { InfrastructureView } from '../render/arch/InfrastructureView.ts';
import type { TerrainView } from '../render/arch/TerrainView.ts';
import type { WorldView } from '../render/WorldView.ts';

/**
 * Development / debug interface of the digital world (explorer and in-game inspector):
 * - World: where the camera is in the hierarchy (region, district), streaming and LOD stats,
 *   shader debug views (geometric hierarchy, flat surfaces, activity, normals), lighting-state
 *   override, light and pattern tuning, a region minimap; in the explorer also the world seed
 *   and region blend width (regenerate) and teleporting.
 * - Inspect: pick a structure and read its full spec: archetype, function, variant, seed,
 *   proportions, parameters, palette, illumination, connections, interior, activity and its
 *   ten validation checks; change its activity state.
 * - Lab (explorer): pick an archetype, function and variant, edit every generation parameter and
 *   the lot, toggle geometry tiers, interiors and colliders, and regenerate a single structure.
 */
export interface LabState {
  archetype: ArchetypeId;
  func: string;
  variant: string;
  seed: number;
  w: number;
  d: number;
  minH: number;
  maxH: number;
  intensity: number;
  region: string;
  params: Record<string, number>;
  tiers: [boolean, boolean, boolean];
  interior: boolean;
  colliders: boolean;
  activity: ActivityState;
}

export interface LabHooks {
  state: LabState;
  /** Rebuild the lab structure from the state; returns the generated spec. */
  apply(): StructureSpec;
  /** Show the lab (true) or the world (false). */
  show(on: boolean): void;
}

export interface PanelOptions {
  world: DigitalWorldView;
  terrain: TerrainView;
  routes: InfrastructureView;
  sky: WorldView;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  lab: LabHooks | null;
  regenerate: ((seed: number, transition: number) => void) | null;
  teleport: ((x: number, z: number, y?: number) => void) | null;
}

const REGION_COLORS: Record<string, string> = {
  control: '#36e2ff', 'machine-city': '#2f74ff', industrial: '#ff7a1a', communication: '#bfefff', transport: '#ffb347', plains: '#0b3a8a', caverns: '#1c2a6a',
  'grid-plains': '#1d5f9c', sea: '#7f9dbb', canyons: '#8a3a1a', wasteland: '#5a5a6a', 'mech-caverns': '#10183a',
};

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);

export class ArchitectureDebugPanel {
  readonly el: HTMLDivElement;
  private tab: 'world' | 'inspect' | 'lab' = 'world';
  private readonly body: HTMLDivElement;
  private timer = 0;
  private picked: { s: StructureSpec; ox: number; oz: number } | null = null;
  private picking = false;
  private map: HTMLCanvasElement | null = null;
  private mapBase: ImageData | null = null;
  private labSpec: StructureSpec | null = null;

  constructor(private readonly o: PanelOptions) {
    this.el = document.createElement('div');
    this.el.id = 'arch-panel';
    this.el.className = 'panel';
    const tabs = document.createElement('div');
    tabs.className = 'arch-tabs';
    const names: Array<['world' | 'inspect' | 'lab', string]> = [['world', 'World'], ['inspect', 'Inspect'], ...(o.lab ? [['lab', 'Archetype lab'] as ['lab', string]] : [])];
    for (const [id, label] of names) {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.tab = id;
      b.addEventListener('click', () => this.setTab(id));
      tabs.appendChild(b);
    }
    const close = document.createElement('button');
    close.textContent = '✕';
    close.title = 'Close (K)';
    close.className = 'arch-close';
    close.addEventListener('click', () => { this.visible = false; });
    tabs.appendChild(close);
    this.el.appendChild(tabs);
    this.body = document.createElement('div');
    this.body.className = 'arch-body';
    this.el.appendChild(this.body);
    document.body.appendChild(this.el);
    o.canvas.addEventListener('pointerdown', (e) => this.onPick(e));
    this.setTab('world');
  }

  get visible(): boolean {
    return !this.el.classList.contains('hidden');
  }
  set visible(v: boolean) {
    this.el.classList.toggle('hidden', !v);
    if (v) this.render();
  }

  setTab(t: 'world' | 'inspect' | 'lab'): void {
    this.tab = t;
    this.o.lab?.show(t === 'lab');
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.arch-tabs button[data-tab]')) b.classList.toggle('on', b.dataset.tab === t);
    this.render();
  }

  update(dt: number): void {
    if (!this.visible) return;
    this.timer += dt;
    if (this.timer < 0.3) return;
    this.timer = 0;
    if (this.tab === 'world') this.refreshWorld();
  }

  // --- World ---

  private render(): void {
    if (this.tab === 'world') this.renderWorld();
    else if (this.tab === 'inspect') this.renderInspect();
    else this.renderLab();
  }

  private renderWorld(): void {
    const seedRow = this.o.regenerate ? `
      <h4>World generation</h4>
      <div class="arch-row"><label>Seed <input id="ap-seed" type="number" value="${WORLD.seed}"></label>
      <label>Blend (m) <input id="ap-blend" type="number" min="200" max="4000" step="100" value="${WORLD.transition}"></label></div>
      <div class="arch-row"><button id="ap-regen">Regenerate world</button><button id="ap-rseed">Random seed</button></div>` : '';
    this.body.innerHTML = `
      <div id="ap-where"></div>
      <h4>Region map</h4>
      <canvas id="ap-map" width="240" height="240" title="${this.o.teleport ? 'Click to travel there' : 'Region identities around the planet'}"></canvas>
      <div class="arch-legend">${[...CITY_REGIONS, ...TERRAIN_ARCHETYPES].map((r) => `<span><i style="background:${REGION_COLORS[r]}"></i>${esc((REGION_PROFILES as Record<string, { label: string }>)[r]?.label ?? (TERRAIN_PROFILES as Record<string, { label: string }>)[r].label)}</span>`).join('')}</div>
      <div id="ap-stats"></div>
      <h4>View</h4>
      <div class="arch-row"><label>Debug view <select id="ap-debug">
        <option value="0">Shaded</option><option value="1">Geometric hierarchy</option><option value="2">Flat surfaces</option><option value="3">Activity states</option><option value="4">Normals</option></select></label>
      <label>Lighting <select id="ap-light"><option value="">Per structure</option>${ACTIVITY_STATES.map((s) => `<option>${s}</option>`).join('')}</select></label></div>
      ${slider('ap-glow', 'Glow gain', 0, 6, 0.1, ARCH_PARAMS.glowGain.value as number)}
      ${slider('ap-edge', 'Edge width (px)', 0.5, 3, 0.05, ARCH_PARAMS.edgeWidth.value as number)}
      ${slider('ap-pat', 'Surface patterns', 0, 2, 0.05, ARCH_PARAMS.pattern.value as number)}
      ${slider('ap-exp', 'Surface exposure', 0.3, 3, 0.05, ARCH_PARAMS.exposure.value as number)}
      ${slider('ap-lod0', 'LOD 0 range (m)', 300, 3000, 50, this.o.world.ranges.lod0)}
      ${slider('ap-lod1', 'LOD 1 range (m)', 800, 6000, 100, this.o.world.ranges.lod1)}
      ${slider('ap-lod2', 'LOD 2 range (m)', 2000, 14000, 250, this.o.world.ranges.lod2)}
      ${seedRow}
      <h4>Light roles</h4>
      <div class="arch-roles">${Object.entries(LIGHT_MEANING).map(([r, m]) => `<div><b class="role-${r}">${r}</b> ${esc(m)}</div>`).join('')}</div>`;
    const $ = <T extends HTMLElement>(id: string) => this.body.querySelector<T>(`#${id}`)!;
    const dbg = $<HTMLSelectElement>('ap-debug');
    dbg.value = String(ARCH_PARAMS.debug.value);
    dbg.addEventListener('change', () => { ARCH_PARAMS.debug.value = Number(dbg.value); });
    const light = $<HTMLSelectElement>('ap-light');
    light.addEventListener('change', () => ARCH_LIGHTING.setOverride((light.value || null) as ActivityState | null));
    const bind = (id: string, f: (v: number) => void) => {
      const i = $<HTMLInputElement>(id);
      const out = $<HTMLSpanElement>(`${id}-v`);
      i.addEventListener('input', () => { f(Number(i.value)); out.textContent = i.value; });
    };
    bind('ap-glow', (v) => { ARCH_PARAMS.glowGain.value = v; });
    bind('ap-edge', (v) => { ARCH_PARAMS.edgeWidth.value = v; });
    bind('ap-pat', (v) => { ARCH_PARAMS.pattern.value = v; });
    bind('ap-exp', (v) => { ARCH_PARAMS.exposure.value = v; });
    bind('ap-lod0', (v) => { this.o.world.ranges = { ...this.o.world.ranges, lod0: v }; this.o.terrain.ranges = this.o.world.ranges; });
    bind('ap-lod1', (v) => { this.o.world.ranges = { ...this.o.world.ranges, lod1: v }; this.o.terrain.ranges = this.o.world.ranges; });
    bind('ap-lod2', (v) => { this.o.world.ranges = { ...this.o.world.ranges, lod2: v }; this.o.terrain.ranges = this.o.world.ranges; });
    if (this.o.regenerate) {
      $('ap-regen').addEventListener('click', () => {
        this.mapBase = null;
        this.o.regenerate!(Number($<HTMLInputElement>('ap-seed').value) | 0, Number($<HTMLInputElement>('ap-blend').value));
        this.renderWorld();
      });
      $('ap-rseed').addEventListener('click', () => { $<HTMLInputElement>('ap-seed').value = String(Math.floor(Math.random() * 1e6)); });
    }
    this.map = $<HTMLCanvasElement>('ap-map');
    this.map.addEventListener('click', (e) => {
      if (!this.o.teleport) return;
      const r = this.map!.getBoundingClientRect();
      const u = (e.clientX - r.left) / r.width, v = (e.clientY - r.top) / r.height;
      this.o.teleport(GRID.x0 + u * PLANET.circumference, GRID.z0 + v * PLANET.circumference);
    });
    this.refreshWorld();
  }

  private drawMap(): void {
    const c = this.map;
    if (!c) return;
    const g = c.getContext('2d')!;
    if (!this.mapBase) {
      const n = GRID.blocks;
      const s = blockSummary();
      const img = g.createImageData(c.width, c.height);
      const col = new THREE.Color();
      for (let y = 0; y < c.height; y++) for (let x = 0; x < c.width; x++) {
        const gi = Math.floor((x / c.width) * n), gj = Math.floor((y / c.height) * n);
        const o = (gj * n + gi) * 4;
        const kind = s[o + 2], reg = s[o + 1] & 15;
        if (kind === BLOCK_KIND.sea) col.set('#020a1e');
        else if (kind === BLOCK_KIND.outlands) col.set(REGION_COLORS[TERRAIN_ARCHETYPES[reg]] ?? '#333');
        else if (kind === BLOCK_KIND.airfield) col.set('#ffffff');
        else if (kind === BLOCK_KIND.open) col.set('#0a1430');
        else col.set(REGION_COLORS[CITY_REGIONS[reg]] ?? '#333').multiplyScalar(kind === BLOCK_KIND.plain ? 0.6 : 0.85);
        const p = (y * c.width + x) * 4;
        img.data[p] = col.r * 255; img.data[p + 1] = col.g * 255; img.data[p + 2] = col.b * 255; img.data[p + 3] = 255;
      }
      this.mapBase = img;
    }
    g.putImageData(this.mapBase, 0, 0);
    const cam = this.o.camera.position;
    const u = mod(cam.x - GRID.x0, PLANET.circumference) / PLANET.circumference, v = mod(cam.z - GRID.z0, PLANET.circumference) / PLANET.circumference;
    g.strokeStyle = '#ffffff';
    g.lineWidth = 2;
    g.beginPath();
    g.arc(u * c.width, v * c.height, 5, 0, Math.PI * 2);
    g.stroke();
    // View direction.
    const dir = new THREE.Vector3();
    this.o.camera.getWorldDirection(dir);
    g.beginPath();
    g.moveTo(u * c.width, v * c.height);
    g.lineTo(u * c.width + dir.x * 14, v * c.height + dir.z * 14);
    g.stroke();
  }

  private refreshWorld(): void {
    const where = this.body.querySelector('#ap-where');
    const stats = this.body.querySelector('#ap-stats');
    if (!where || !stats) return;
    const cam = this.o.camera.position;
    const ra = regionAt(cam.x, cam.z);
    const city = cityRegionAt(cam.x, cam.z);
    const w = wastelandAt(cam.x, cam.z);
    const mix = terrainMixAt(cam.x, cam.z);
    const ci = Math.floor(mod(cam.x - GRID.x0, PLANET.circumference) / GRID.chunkSize), cj = Math.floor(mod(cam.z - GRID.z0, PLANET.circumference) / GRID.chunkSize);
    const d = districtPlan(ci, cj);
    const fam: Record<string, number> = {};
    for (const s of d.structures) fam[s.archetype] = (fam[s.archetype] ?? 0) + 1;
    const open = d.layout.lots.filter((l) => l.kind === 'open').length;
    const prof = REGION_PROFILES[city.primary];
    where.innerHTML = `
      <h4>Where</h4>
      <table class="arch-kv">
        <tr><td>Region site</td><td>${esc(ra.site.name)} (${ra.site.kind})${ra.secondary && ra.blend > 0.05 ? ` → ${esc(ra.secondary.name)} ${(ra.blend * 100).toFixed(0)}%` : ''}</td></tr>
        <tr><td>Identity</td><td>${w > 0.5 ? 'Outlands' : esc(prof.label)}</td></tr>
        <tr><td>Outlands</td><td>${(w * 100).toFixed(0)}% · ${Object.entries(mix).filter(([, v]) => v > 0.01).map(([k, v]) => `${TERRAIN_PROFILES[k as keyof typeof TERRAIN_PROFILES].label} ${(v * 100).toFixed(0)}%`).join(', ') || '—'}</td></tr>
        <tr><td>District</td><td>${d.key} · ${esc(REGION_PROFILES[d.layout.region].label)} · ${d.structures.length} structures, ${open} open lots, ${d.rejected} rejected · ${d.ms.toFixed(1)} ms</td></tr>
        <tr><td>Families</td><td>${Object.entries(fam).map(([k, v]) => `${k} ${v}`).join(', ') || '—'}</td></tr>
        <tr><td>Position</td><td>${cam.x.toFixed(0)}, ${cam.y.toFixed(0)}, ${cam.z.toFixed(0)}</td></tr>
      </table>`;
    const st = this.o.world.stats(), ts = this.o.terrain.stats();
    stats.innerHTML = `
      <h4>Streaming</h4>
      <table class="arch-kv">
        <tr><td>Districts</td><td>${st.districts} (LOD0 ${st.byLod[0]} · LOD1 ${st.byLod[1]} · LOD2 ${st.byLod[2]}), ${st.pending} queued</td></tr>
        <tr><td>Structures</td><td>${st.structures} loaded · ${ARCH_LIGHTING.count} lighting slots</td></tr>
        <tr><td>Triangles</td><td>architecture ${(st.triangles / 1000).toFixed(0)}k · terrain ${(ts.triangles / 1000).toFixed(0)}k (${ts.chunks} chunks)</td></tr>
        <tr><td>Draw calls</td><td>${st.drawCalls} architecture meshes visible</td></tr>
        <tr><td>Sailer routes</td><td>${this.o.routes.routes}</td></tr>
        <tr><td>Sky</td><td>${esc(this.o.sky.atmosphere.label)}</td></tr>
      </table>`;
    this.drawMap();
  }

  // --- Inspect ---

  private renderInspect(): void {
    const s = this.picked?.s ?? null;
    this.body.innerHTML = `
      <div class="arch-row"><button id="ap-pick" class="${this.picking ? 'on' : ''}">${this.picking ? 'Click a structure…' : 'Pick a structure'}</button><button id="ap-near">Nearest to camera</button>${s && this.o.lab ? '<button id="ap-tolab">Open in lab</button>' : ''}</div>
      ${s ? specHtml(s) : '<p class="arch-hint">Pick a structure in the view to read its specification and validation report.</p>'}`;
    const $ = <T extends HTMLElement>(id: string) => this.body.querySelector<T>(`#${id}`);
    $('ap-pick')?.addEventListener('click', () => { this.picking = !this.picking; this.renderInspect(); });
    $('ap-near')?.addEventListener('click', () => {
      const cam = this.o.camera.position;
      let best: typeof this.picked = null, bd = Infinity;
      for (const e of this.o.world.structures()) {
        const d = Math.hypot(e.s.x + e.ox - cam.x, e.s.z + e.oz - cam.z);
        if (d < bd) { bd = d; best = { s: e.s, ox: e.ox, oz: e.oz }; }
      }
      this.picked = best;
      this.renderInspect();
    });
    $('ap-tolab')?.addEventListener('click', () => {
      if (!s || !this.o.lab) return;
      const L = this.o.lab.state;
      Object.assign(L, { archetype: s.archetype, func: s.function, variant: s.variant, seed: s.seed, w: s.w, d: s.d, params: { ...s.params } });
      this.setTab('lab');
    });
    for (const b of this.body.querySelectorAll<HTMLButtonElement>('button[data-state]')) b.addEventListener('click', () => {
      if (!s) return;
      ARCH_LIGHTING.setState(s.id, b.dataset.state as ActivityState);
      s.activity = b.dataset.state as ActivityState;
      this.renderInspect();
    });
  }

  private onPick(e: PointerEvent): void {
    if (!this.picking || !this.visible || this.tab !== 'inspect') return;
    const r = this.o.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.o.camera);
    let best: typeof this.picked = null, bd = Infinity;
    const box = new THREE.Box3();
    const hit = new THREE.Vector3();
    for (const en of this.o.world.structures()) {
      for (const c of en.s.colliders) {
        box.min.set(c.x + en.ox - c.sx / 2, c.y - c.sy / 2, c.z + en.oz - c.sz / 2);
        box.max.set(c.x + en.ox + c.sx / 2, c.y + c.sy / 2, c.z + en.oz + c.sz / 2);
        if (ray.ray.intersectBox(box, hit)) {
          const d = hit.distanceTo(ray.ray.origin);
          if (d < bd) { bd = d; best = { s: en.s, ox: en.ox, oz: en.oz }; }
        }
      }
    }
    if (best) {
      this.picked = best;
      this.picking = false;
      this.renderInspect();
    }
  }

  // --- Lab ---

  private renderLab(): void {
    const lab = this.o.lab;
    if (!lab) return;
    const L = lab.state;
    const gen = ARCHETYPES[L.archetype];
    if (!gen.functions.includes(L.func)) L.func = gen.functions[0];
    if (!gen.variants.includes(L.variant)) L.variant = gen.variantFor[L.func];
    for (const p of gen.params) if (L.params[p.key] === undefined) L.params[p.key] = p.def;
    const regions = [...CITY_REGIONS, 'outlands'];
    this.body.innerHTML = `
      <div class="arch-row"><label>Archetype <select id="lb-arch">${ARCHETYPE_IDS.map((a) => `<option value="${a}" ${a === L.archetype ? 'selected' : ''}>${esc(ARCHETYPES[a].label)}</option>`).join('')}</select></label></div>
      <p class="arch-hint">${esc(gen.description)} <i>${esc(gen.reference)}</i></p>
      <div class="arch-row"><label>Function <select id="lb-func">${gen.functions.map((f) => `<option ${f === L.func ? 'selected' : ''}>${f}</option>`).join('')}</select></label>
      <label>Variant <select id="lb-var">${gen.variants.map((v) => `<option ${v === L.variant ? 'selected' : ''}>${v}</option>`).join('')}</select></label></div>
      <div class="arch-row"><label>Seed <input id="lb-seed" type="number" value="${L.seed}"></label><button id="lb-rnd">New seed</button></div>
      <div class="arch-row"><label>Region <select id="lb-region">${regions.map((r) => `<option ${r === L.region ? 'selected' : ''}>${r}</option>`).join('')}</select></label>
      <label>Activity <select id="lb-act">${ACTIVITY_STATES.map((s) => `<option ${s === L.activity ? 'selected' : ''}>${s}</option>`).join('')}</select></label></div>
      <h4>Lot</h4>
      ${slider('lb-w', 'Width (m)', 60, 520, 5, L.w)}
      ${slider('lb-d', 'Depth (m)', 60, 520, 5, L.d)}
      ${slider('lb-minh', 'Min height (m)', 5, 200, 5, L.minH)}
      ${slider('lb-maxh', 'Max height (m)', 20, 600, 5, L.maxH)}
      ${slider('lb-int', 'Monumentality', 0, 1, 0.05, L.intensity)}
      <h4>Parameters</h4>
      ${gen.params.map((p) => slider(`lb-p-${p.key}`, p.label, p.min, p.max, p.step, L.params[p.key])).join('')}
      <h4>Inspect</h4>
      <div class="arch-row">
        <label><input type="checkbox" id="lb-t1" ${L.tiers[0] ? 'checked' : ''}> Primary</label>
        <label><input type="checkbox" id="lb-t2" ${L.tiers[1] ? 'checked' : ''}> Secondary</label>
        <label><input type="checkbox" id="lb-t3" ${L.tiers[2] ? 'checked' : ''}> Tertiary</label>
      </div>
      <div class="arch-row"><label><input type="checkbox" id="lb-int2" ${L.interior ? 'checked' : ''}> Interior</label><label><input type="checkbox" id="lb-col" ${L.colliders ? 'checked' : ''}> Colliders</label></div>
      <div id="lb-out">${this.labSpec ? specHtml(this.labSpec, true) : ''}</div>`;
    const $ = <T extends HTMLElement>(id: string) => this.body.querySelector<T>(`#${id}`)!;
    const regen = () => { this.labSpec = lab.apply(); $('lb-out').innerHTML = specHtml(this.labSpec, true); };
    $<HTMLSelectElement>('lb-arch').addEventListener('change', (e) => { L.archetype = (e.target as HTMLSelectElement).value as ArchetypeId; L.params = {}; L.func = ''; L.variant = ''; this.renderLab(); regen(); });
    $<HTMLSelectElement>('lb-func').addEventListener('change', (e) => { L.func = (e.target as HTMLSelectElement).value; L.variant = gen.variantFor[L.func]; this.renderLab(); regen(); });
    $<HTMLSelectElement>('lb-var').addEventListener('change', (e) => { L.variant = (e.target as HTMLSelectElement).value; regen(); });
    $<HTMLSelectElement>('lb-region').addEventListener('change', (e) => { L.region = (e.target as HTMLSelectElement).value; regen(); });
    $<HTMLSelectElement>('lb-act').addEventListener('change', (e) => { L.activity = (e.target as HTMLSelectElement).value as ActivityState; regen(); });
    $<HTMLInputElement>('lb-seed').addEventListener('change', (e) => { L.seed = Number((e.target as HTMLInputElement).value) | 0; regen(); });
    $('lb-rnd').addEventListener('click', () => { L.seed = Math.floor(Math.random() * 1e9); $<HTMLInputElement>('lb-seed').value = String(L.seed); regen(); });
    const bind = (id: string, f: (v: number) => void) => {
      const i = $<HTMLInputElement>(id);
      i.addEventListener('input', () => { f(Number(i.value)); $<HTMLSpanElement>(`${id}-v`).textContent = i.value; regen(); });
    };
    bind('lb-w', (v) => { L.w = v; });
    bind('lb-d', (v) => { L.d = v; });
    bind('lb-minh', (v) => { L.minH = v; });
    bind('lb-maxh', (v) => { L.maxH = v; });
    bind('lb-int', (v) => { L.intensity = v; });
    for (const p of gen.params) bind(`lb-p-${p.key}`, (v) => { L.params[p.key] = v; });
    const check = (id: string, f: (v: boolean) => void) => $<HTMLInputElement>(id).addEventListener('change', (e) => { f((e.target as HTMLInputElement).checked); regen(); });
    check('lb-t1', (v) => { L.tiers[0] = v; });
    check('lb-t2', (v) => { L.tiers[1] = v; });
    check('lb-t3', (v) => { L.tiers[2] = v; });
    check('lb-int2', (v) => { L.interior = v; });
    check('lb-col', (v) => { L.colliders = v; });
    regen();
  }
}

function slider(id: string, label: string, min: number, max: number, step: number, value: number): string {
  return `<div class="arch-slider"><label for="${id}">${esc(label)}</label><input id="${id}" type="range" min="${min}" max="${max}" step="${step}" value="${value}"><span id="${id}-v">${+value.toFixed(3)}</span></div>`;
}

/** A structure's specification and validation report as HTML. */
export function specHtml(s: StructureSpec, lab = false): string {
  const tiers = [0, 0, 0];
  let tris = 0;
  for (const c of s.components) { tiers[c.tier - 1]++; tris += primitiveTriangles(c.prim); }
  const v = s.validation;
  const states = ACTIVITY_STATES.map((st) => `<button data-state="${st}" class="${s.activity === st ? 'on' : ''}">${st}</button>`).join('');
  return `
    <h4>${esc(s.landmark ?? `${ARCHETYPES[s.archetype].label}`)}</h4>
    <table class="arch-kv">
      <tr><td>Id · seed</td><td>${s.id} · ${s.seed}</td></tr>
      <tr><td>Family</td><td>${s.archetype} / ${s.variant}</td></tr>
      <tr><td>Function</td><td>${s.function}</td></tr>
      <tr><td>Lot</td><td>${s.w.toFixed(0)} × ${s.d.toFixed(0)} m, rotated ${s.rotation * 90}°, height ${s.height.toFixed(0)} m</td></tr>
      <tr><td>Position</td><td>${s.x.toFixed(0)}, ${s.z.toFixed(0)}</td></tr>
      <tr><td>Palette</td><td>${s.palette.primary} / ${s.palette.secondary}, light ${s.palette.accent} + ${s.palette.secondaryLight}</td></tr>
      <tr><td>Illumination</td><td>${s.illumination.roles.join(', ')} · pulse ${s.illumination.pulse.toFixed(2)} Hz · ${(s.illumination.edgeDensity * 100).toFixed(0)}% lit elements</td></tr>
      <tr><td>Geometry</td><td>${tiers[0]} primary · ${tiers[1]} secondary · ${tiers[2]} tertiary · ${tris} triangles · ${s.colliders.length} colliders</td></tr>
      <tr><td>Connections</td><td>${s.connections.map((c) => c.kind).join(', ') || '—'}</td></tr>
      <tr><td>Interior</td><td>${s.interior ? `${s.interior.program}, ${(s.interior.x1 - s.interior.x0).toFixed(0)} × ${(s.interior.z1 - s.interior.z0).toFixed(0)} × ${(s.interior.y1 - s.interior.y0).toFixed(0)} m, ${s.interior.entrances.length} entrances` : 'none'}</td></tr>
      <tr><td>Parameters</td><td>${Object.entries(s.params).map(([k, x]) => `${k} ${+x.toFixed(2)}`).join(', ')}</td></tr>
    </table>
    ${lab ? '' : `<div class="arch-row arch-states">Activity ${states}</div>`}
    <h4>Validation ${v ? (v.pass ? '<b class="ok">passed</b>' : '<b class="bad">failed</b>') : ''} ${v ? `· ${v.attempts} attempt${v.attempts > 1 ? 's' : ''}` : ''}</h4>
    <ol class="arch-checks">${(v?.checks ?? []).map((c) => `<li class="${c.pass ? 'ok' : 'bad'}"><b>${c.pass ? '✓' : '✗'} ${esc(c.name)}</b> <span>${esc(c.detail)}</span></li>`).join('')}</ol>`;
}
