import * as THREE from 'three/webgpu';
import { color, float, fract, max, mix, normalize, positionLocal, positionWorld, smoothstep, step, abs, vec2 } from 'three/tsl';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { glow, groundGridNode, neonFillMaterial, neonize, type TslNode } from './neon.ts';

import { HANGAR } from './hangarLayout.ts';

const { W, H, D, DOOR_W, DOOR_H, BAY } = HANGAR;

/** The 1982 palette (AGENTS.md §4): dark primary surfaces, selective light. */
const C = {
  floor: '#070b14',
  navy: '#0b1a33',
  blue: '#10284f',
  steel: '#2a4466',
  teal: '#22485a',
  seam: '#2a4466',
  cyan: '#00d4ff',
  amber: '#ffb000',
  orange: '#ff6a00',
  red: '#ff3b1f',
  pale: '#9fc4e0',
} as const;

/**
 * The hangar: where craft are designed, inspected and picked, a separate scene from the flight
 * world. Built in the 1982 language as an industrial megastructure interior (AGENTS.md §2C,
 * the solar-sailer hangar of p. 53): a tall hall of repeating structural bays, fluted walls
 * between massive pilasters, a skylight-grid roof on deep beams with red-orange edge lines,
 * a floor of large dark panes with circuit traces running to the walls, and a stepped radial
 * platform for the craft, ringed with sawtooth teeth and radial red lines (pp. 60-62) under two
 * hovering red halo rings (p. 40). Through the door: a dark sky over an amber horizon band
 * (p. 15) with monumental silhouettes on the plain. Large surfaces stay unlit; light marks
 * structure and function only.
 */
export class HangarView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly controls: OrbitControls;
  /** Height of the platform's top surface (m): craft rest on it. */
  readonly turntableTop = 0.34;
  private readonly turntable = new THREE.Group();
  /** Sky dome, kept centred on the orbit camera so its horizon lines up with the ground. */
  private readonly sky: THREE.Mesh;
  private idle = 0;
  private envReady = false;
  private readonly fills = new Map<string, THREE.MeshStandardNodeMaterial>();

  constructor(
    private readonly renderer: THREE.WebGPURenderer,
    dom: HTMLElement,
  ) {
    this.camera = new THREE.PerspectiveCamera(40, 1, 0.1, 600);
    this.camera.position.set(-11, 3.6, -12);
    this.controls = new OrbitControls(this.camera, dom);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.49;
    this.controls.minDistance = 3;
    this.controls.maxDistance = 30;
    this.controls.target.set(0, 1.4, 0);
    this.controls.autoRotateSpeed = 0.5;
    this.controls.addEventListener('start', () => {
      this.idle = 0;
      this.controls.autoRotate = false;
    });
    this.controls.enabled = false;

    const s = this.scene;
    s.background = new THREE.Color('#04070f');
    s.fog = new THREE.Fog('#060a14', 70, 420);

    this.buildFloor();
    this.buildWalls();
    this.buildRoof();
    this.buildPlatform();
    this.buildMachinery();
    this.sky = this.buildOutside();

    // Light: cool fill from the skylights, a key down through the roof, a spot on the platform.
    s.add(new THREE.HemisphereLight('#6f8aa8', '#070b14', 0.55));
    const key = new THREE.DirectionalLight('#cfe6ff', 0.9);
    key.position.set(-18, 40, 10);
    s.add(key);
    const over = new THREE.SpotLight('#dff6ff', 520, 48, Math.PI * 0.26, 0.7, 2);
    over.position.set(0, H - 2, 1);
    over.target.position.set(0, 0, 0);
    s.add(over, over.target);
    // A warm rim from the horizon through the door.
    const rim = new THREE.DirectionalLight('#ff9a4a', 0.35);
    rim.position.set(0, 6, -80);
    s.add(rim);
  }

  // ---------------------------------------------------------------- building blocks

  /** Dark fill shared per colour (secondary surfaces read a step lighter than the floor). */
  private fill(c: string): THREE.MeshStandardNodeMaterial {
    let m = this.fills.get(c);
    if (!m) {
      m = neonFillMaterial(new THREE.Color(c).multiplyScalar(0.6));
      this.fills.set(c, m);
    }
    return m;
  }

  /** An emissive (lit) material: these are the only things that bloom. */
  private lit(c: string, k: number): THREE.MeshBasicNodeMaterial {
    return new THREE.MeshBasicNodeMaterial({ color: glow(c, k) });
  }

  /** A solid with dim structural seams on its edges (or none). */
  private solid(geo: THREE.BufferGeometry, c: string, seams = 0.5): THREE.Mesh {
    const m = new THREE.Mesh(geo, this.fill(c));
    if (seams > 0) m.add(neonize(geo, new THREE.Color(C.cyan).multiplyScalar(0.22), { intensity: seams * 2, thresholdAngle: 20 }));
    return m;
  }

  /** Many copies of one shape as a single merged mesh (one draw call plus its seams). */
  private merged(geo: THREE.BufferGeometry, mats: THREE.Matrix4[], c: string, seams = 0.5): THREE.Mesh {
    const g = mergeGeometries(mats.map((m) => geo.clone().applyMatrix4(m)), false)!;
    return this.solid(g, c, seams);
  }

  private litMerged(geo: THREE.BufferGeometry, mats: THREE.Matrix4[], c: string, k: number): THREE.Mesh {
    const g = mergeGeometries(mats.map((m) => geo.clone().applyMatrix4(m)), false)!;
    return new THREE.Mesh(g, this.lit(c, k));
  }

  private buildFloor(): void {
    const s = this.scene;
    // Large dark panes (6 m) with thin recessed seams, slightly lighter toward each pane centre.
    const floorMat = new THREE.MeshBasicNodeMaterial();
    const p: TslNode = positionWorld.xz;
    const cell: TslNode = abs(fract(p.div(6)).sub(0.5)).mul(2); // 0 centre .. 1 seam
    const seam: TslNode = step(0.985, max(cell.x, cell.y));
    const pane: TslNode = float(1).sub(max(cell.x, cell.y).mul(0.35));
    floorMat.colorNode = color(C.floor).mul(pane.mul(1.4)).add(color(C.seam).mul(seam.mul(0.55)));
    s.add(new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), floorMat));

    // Circuit traces: amber lines leaving the platform and jogging out to the side walls, where
    // they feed the machinery (data and energy reaching the craft, not decoration).
    const traces: THREE.Matrix4[] = [];
    const seg = (x0: number, z0: number, x1: number, z1: number) => {
      const len = Math.hypot(x1 - x0, z1 - z0);
      const m = new THREE.Matrix4().makeRotationY(Math.atan2(x1 - x0, z1 - z0));
      m.setPosition((x0 + x1) / 2, 0.006, (z0 + z1) / 2);
      traces.push(m.multiply(new THREE.Matrix4().makeScale(1, 1, len)));
    };
    for (const sx of [-1, 1]) {
      seg(sx * 10, 4, sx * 16, 4); seg(sx * 16, 4, sx * 16, 12); seg(sx * 16, 12, sx * (W / 2 - 2.5), 12);
      seg(sx * 10, -2, sx * 19, -2); seg(sx * 19, -2, sx * 19, 8); seg(sx * 19, 8, sx * (W / 2 - 2.5), 8);
      seg(sx * 7, 9, sx * 7, D / 2 - 2.5);
    }
    s.add(this.litMerged(new THREE.BoxGeometry(0.12, 0.01, 1), traces, C.orange, 1.5));
    // Contact pads where the traces meet the platform.
    const pads: THREE.Matrix4[] = [];
    for (const [x, z] of [[-10, 4], [10, 4], [-10, -2], [10, -2], [-7, 9], [7, 9]]) pads.push(new THREE.Matrix4().makeTranslation(x, 0.008, z));
    s.add(this.litMerged(new THREE.BoxGeometry(0.5, 0.012, 0.5), pads, C.amber, 1.6));

    // The lead-out: a recessed channel with two cyan edge lines from the platform out the door.
    const lead: THREE.Matrix4[] = [];
    const len = D / 2 - 10 + 60;
    for (const x of [-2.6, 2.6]) lead.push(new THREE.Matrix4().makeTranslation(x, 0.007, -10 - len / 2));
    s.add(this.litMerged(new THREE.BoxGeometry(0.1, 0.012, len), lead, C.cyan, 1.8));
    const channel = new THREE.Mesh(new THREE.PlaneGeometry(5.0, len).rotateX(-Math.PI / 2), new THREE.MeshBasicNodeMaterial({ color: new THREE.Color('#03060c') }));
    channel.position.set(0, 0.003, -10 - len / 2);
    s.add(channel);
  }

  private buildWalls(): void {
    const s = this.scene;
    const back = new THREE.MeshBasicNodeMaterial({ color: new THREE.Color(C.floor).multiplyScalar(0.8) });
    const plane = (w: number, h: number, x: number, y: number, z: number, ry: number) => {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), back);
      m.position.set(x, y, z);
      m.rotation.y = ry;
      s.add(m);
    };
    plane(D, H, -W / 2, H / 2, 0, Math.PI / 2);
    plane(D, H, W / 2, H / 2, 0, -Math.PI / 2);
    plane(W, H, 0, H / 2, D / 2, Math.PI);
    const side = (W - DOOR_W) / 2;
    plane(side, H, -W / 2 + side / 2, H / 2, -D / 2, 0);
    plane(side, H, W / 2 - side / 2, H / 2, -D / 2, 0);
    plane(DOOR_W, H - DOOR_H, 0, DOOR_H + (H - DOOR_H) / 2, -D / 2, 0);

    // Structural bays: massive pilasters every 8 m along the side walls, on stepped plinths.
    const pil: THREE.Matrix4[] = [];
    const plinth: THREE.Matrix4[] = [];
    const seams: THREE.Matrix4[] = [];
    for (const sx of [-1, 1]) {
      for (let z = -D / 2 + 2; z <= D / 2 - 2; z += BAY) {
        const x = sx * (W / 2 - 0.9);
        pil.push(new THREE.Matrix4().makeTranslation(x, H / 2, z));
        plinth.push(new THREE.Matrix4().makeTranslation(sx * (W / 2 - 1.3), 0.6, z));
        // A lit seam up the inner face of every other pilaster (power rising to the roof).
        if (Math.round((z + D / 2 - 2) / BAY) % 2 === 0) seams.push(new THREE.Matrix4().makeTranslation(sx * (W / 2 - 1.82), H / 2 + 1, z));
      }
    }
    // Back wall pilasters, framing a central recess.
    for (const x of [-20, -12, 12, 20]) {
      pil.push(new THREE.Matrix4().makeTranslation(x, H / 2, D / 2 - 0.9).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
      plinth.push(new THREE.Matrix4().makeTranslation(x, 0.6, D / 2 - 1.3).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    }
    s.add(this.merged(new THREE.BoxGeometry(1.8, H, 1.6), pil, C.blue, 0.6));
    s.add(this.merged(new THREE.BoxGeometry(2.6, 1.2, 2.4), plinth, C.navy, 0.4));
    s.add(this.litMerged(new THREE.BoxGeometry(0.06, H - 6, 0.12), seams, C.cyan, 1.4));

    // Fluted walls between the pilasters (p. 53, p. 55): vertical slats, muted teal, unlit.
    const flutes: THREE.Matrix4[] = [];
    const fh = H - 5;
    for (const sx of [-1, 1]) {
      for (let z = -D / 2 + 3.4; z < D / 2 - 2; z += 1.1) {
        if (((z + D / 2 - 2) % BAY + BAY) % BAY < 1.4) continue; // leave room for the pilasters
        flutes.push(new THREE.Matrix4().makeTranslation(sx * (W / 2 - 0.35), fh / 2 + 1.2, z));
      }
    }
    for (let x = -W / 2 + 2; x < W / 2 - 2; x += 1.1) {
      if (Math.abs(x) < 11.5 || [-20, -12, 12, 20].some((p) => Math.abs(x - p) < 1.4)) continue;
      flutes.push(new THREE.Matrix4().makeTranslation(x, fh / 2 + 1.2, D / 2 - 0.35).multiply(new THREE.Matrix4().makeRotationY(Math.PI / 2)));
    }
    s.add(this.merged(new THREE.BoxGeometry(0.5, fh, 0.55), flutes, C.teal, 0.08)); // shading, not lines

    // The central recess in the back wall: a deep portal with an energy beam rising through it.
    const recess = this.solid(new THREE.BoxGeometry(22, H - 2, 0.6), C.navy, 0.5);
    recess.position.set(0, (H - 2) / 2, D / 2 - 0.2);
    s.add(recess);
    const lintel = this.solid(new THREE.BoxGeometry(24, 1.6, 2.6), C.blue, 0.6);
    lintel.position.set(0, H - 3, D / 2 - 1.3);
    s.add(lintel);
    const beamMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // Brightest at the core, fading across its width and toward the top.
    const across: TslNode = float(1).sub(abs(positionLocal.x).div(0.6));
    const up: TslNode = float(1).sub(smoothstep(0, H, positionLocal.y.add(H / 2)).mul(0.55));
    beamMat.colorNode = color(C.cyan).mul(across.pow(2).mul(up).mul(2.2));
    const beam = new THREE.Mesh(new THREE.PlaneGeometry(1.2, H - 2), beamMat);
    beam.position.set(0, (H - 2) / 2, D / 2 - 0.55);
    beam.rotation.y = Math.PI;
    s.add(beam);

    // The door: a massive portal frame, lit only along its inner lintel (amber: the way out).
    const frame: THREE.Matrix4[] = [
      new THREE.Matrix4().makeTranslation(-DOOR_W / 2 - 1, DOOR_H / 2, -D / 2 + 0.6),
      new THREE.Matrix4().makeTranslation(DOOR_W / 2 + 1, DOOR_H / 2, -D / 2 + 0.6),
    ];
    s.add(this.merged(new THREE.BoxGeometry(2, DOOR_H, 1.6), frame, C.blue, 0.6));
    const head = this.solid(new THREE.BoxGeometry(DOOR_W + 4, 2.2, 1.8), C.blue, 0.6);
    head.position.set(0, DOOR_H + 1.1, -D / 2 + 0.6);
    s.add(head);
    const doorLight = new THREE.Mesh(new THREE.BoxGeometry(DOOR_W - 2, 0.12, 0.1), this.lit(C.amber, 2.2));
    doorLight.position.set(0, DOOR_H - 0.06, -D / 2 + 1.42);
    s.add(doorLight);
  }

  private buildRoof(): void {
    const s = this.scene;
    // Skylight grid (p. 53): pale panes between dark mullions, dim, lighting the hall from above.
    const roofMat = new THREE.MeshBasicNodeMaterial();
    const p: TslNode = positionWorld.xz;
    const cell: TslNode = abs(fract(p.div(vec2(4, 4))).sub(0.5)).mul(2);
    const mull: TslNode = step(0.8, max(cell.x, cell.y));
    roofMat.colorNode = mix(color(C.pale).mul(0.32), color('#05080f'), mull);
    const roof = new THREE.Mesh(new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2), roofMat);
    roof.position.y = H;
    s.add(roof);
    // Deep beams spanning the hall every bay, with a red-orange edge line along each underside
    // (the carrier's edge lines, pp. 35-37).
    const beams: THREE.Matrix4[] = [];
    const edges: THREE.Matrix4[] = [];
    for (let z = -D / 2 + 2; z <= D / 2 - 2; z += BAY) {
      beams.push(new THREE.Matrix4().makeTranslation(0, H - 1, z));
      edges.push(new THREE.Matrix4().makeTranslation(0, H - 2.02, z));
    }
    s.add(this.merged(new THREE.BoxGeometry(W - 1, 2, 1.0), beams, C.navy, 0.5));
    s.add(this.litMerged(new THREE.BoxGeometry(W - 4, 0.05, 0.06), edges, C.red, 1.6));
    // Purlins along the length (no light).
    const purlins: THREE.Matrix4[] = [];
    for (let x = -W / 2 + 6; x < W / 2 - 4; x += 8) purlins.push(new THREE.Matrix4().makeTranslation(x, H - 0.4, 0));
    s.add(this.merged(new THREE.BoxGeometry(0.6, 0.8, D - 1), purlins, C.navy, 0.3));
  }

  private buildPlatform(): void {
    const t = this.turntable;
    // Three stepped concentric tiers (p. 58), the top one carrying the craft.
    const tiers: Array<[number, number, number, string]> = [[9.6, 0.12, 0.06, C.navy], [7.6, 0.12, 0.18, C.blue], [6.6, 0.1, 0.29, C.navy]];
    for (const [r, h, y, c] of tiers) {
      const geo = new THREE.CylinderGeometry(r, r, h, 96);
      const m = new THREE.Mesh(geo, neonFillMaterial(new THREE.Color(c).multiplyScalar(0.7), { roughness: 0.3, metalness: 0.85, flatShading: false }));
      m.position.y = y;
      m.add(neonize(geo, new THREE.Color(C.cyan).multiplyScalar(0.25), { thresholdAngle: 30, intensity: 1.2 }));
      t.add(m);
    }
    // The top tier's lit rim: the one bright edge (where the craft stands), and a faint inner ring.
    const rim = new THREE.Mesh(new THREE.TorusGeometry(6.6, 0.035, 8, 160).rotateX(Math.PI / 2), this.lit(C.cyan, 2.6));
    rim.position.y = this.turntableTop;
    t.add(rim);
    const inner = new THREE.Mesh(new THREE.RingGeometry(3.38, 3.44, 96).rotateX(-Math.PI / 2), this.lit(C.cyan, 0.8));
    inner.position.y = this.turntableTop + 0.002;
    t.add(inner);
    // Radial red lines on the lowest tier (pp. 60-62).
    const radial: THREE.Matrix4[] = [];
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      radial.push(new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeTranslation(0, 0.122, 8.6)));
    }
    t.add(this.litMerged(new THREE.BoxGeometry(0.06, 0.006, 1.7), radial, C.red, 1.4));
    // Sawtooth teeth around the base (pp. 60-62).
    const teeth: THREE.Matrix4[] = [];
    const tooth = new THREE.ConeGeometry(0.42, 0.55, 4).rotateY(Math.PI / 4);
    for (let i = 0; i < 64; i++) {
      const a = (i / 64) * Math.PI * 2;
      teeth.push(new THREE.Matrix4().makeRotationY(a).multiply(new THREE.Matrix4().makeTranslation(0, 0.27, 9.95)));
    }
    t.add(this.merged(tooth, teeth, C.blue, 0.12));
    this.scene.add(t);

    // Two red halo rings hovering over the platform (p. 40, p. 10).
    const halo = this.lit(C.red, 2.0);
    for (const [r, y] of [[6.2, 15.5], [4.3, 18]] as const) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r, 0.07, 8, 128).rotateX(Math.PI / 2), halo);
      ring.position.y = y;
      this.scene.add(ring);
    }
  }

  private buildMachinery(): void {
    const s = this.scene;
    // Service gantries flanking the platform: tall columns with cantilevered arms reaching over
    // it, amber lights at the tips where they work on the craft.
    const cols: THREE.Matrix4[] = [];
    const arms: THREE.Matrix4[] = [];
    const tips: THREE.Matrix4[] = [];
    const bases: THREE.Matrix4[] = [];
    for (const sx of [-1, 1]) {
      cols.push(new THREE.Matrix4().makeTranslation(sx * 15, 6.5, 9));
      bases.push(new THREE.Matrix4().makeTranslation(sx * 15, 0.5, 9));
      arms.push(new THREE.Matrix4().makeTranslation(sx * 11.5, 12.4, 9));
      tips.push(new THREE.Matrix4().makeTranslation(sx * 8.15, 11.85, 9));
    }
    s.add(this.merged(new THREE.BoxGeometry(1.4, 13, 1.4), cols, C.blue, 0.6));
    s.add(this.merged(new THREE.BoxGeometry(3.2, 1.0, 3.2), bases, C.navy, 0.4));
    s.add(this.merged(new THREE.BoxGeometry(7, 0.9, 0.9), arms, C.steel, 0.5));
    s.add(this.litMerged(new THREE.BoxGeometry(0.5, 0.12, 0.5), tips, C.amber, 2.2));
    // Data conduits: low boxed runs along the side walls, carrying the floor traces.
    const conduit: THREE.Matrix4[] = [];
    for (const sx of [-1, 1]) conduit.push(new THREE.Matrix4().makeTranslation(sx * (W / 2 - 2.3), 0.35, 4));
    s.add(this.merged(new THREE.BoxGeometry(0.8, 0.7, D - 14), conduit, C.navy, 0.4));
  }

  private buildOutside(): THREE.Mesh {
    const s = this.scene;
    // The apron and plain: dark, a dim grid fading into the haze.
    const apronMat = new THREE.MeshBasicNodeMaterial();
    apronMat.colorNode = groundGridNode(color('#05080f'), color(C.cyan).mul(0.32), { minor: 6, major: 30, fade: 260 });
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(700, 420).rotateX(-Math.PI / 2), apronMat);
    apron.position.set(0, -0.01, -D / 2 - 210);
    s.add(apron);

    // Sky (p. 15): deep navy overhead, a dark red band, an amber horizon band. No sun.
    const skyMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, fog: false });
    const y: TslNode = normalize(positionLocal).y;
    const zenith: TslNode = mix(color('#2a0e1a').mul(0.8), color('#050a1a'), smoothstep(0.04, 0.45, y));
    const band: TslNode = float(1).sub(smoothstep(0.0, 0.035, abs(y.sub(0.01))));
    skyMat.colorNode = mix(color('#03050a'), zenith.add(color(C.orange).mul(band.mul(0.6))), smoothstep(-0.02, 0.0, y));
    const sky = new THREE.Mesh(new THREE.SphereGeometry(380, 48, 24), skyMat);
    sky.renderOrder = -1;
    sky.frustumCulled = false;
    s.add(sky);

    // Monumental silhouettes on the plain: flared processing towers with a lit waist ring
    // (p. 13), pyramidal bases with needle spires and lit tips (p. 40), a stepped tier (p. 58).
    const tower = new THREE.LatheGeometry(
      [[9, 0], [7, 3], [4.2, 10], [3.2, 22], [3.0, 40], [3.6, 46], [2.4, 48]].map(([r, h]) => new THREE.Vector2(r, h)), 16);
    const pyramid = new THREE.ConeGeometry(16, 20, 4).rotateY(Math.PI / 4).translate(0, 10, 0);
    const spire = new THREE.CylinderGeometry(0.25, 0.9, 34, 6).translate(0, 37, 0);
    const tier = (r: number, h: number, y0: number) => new THREE.CylinderGeometry(r, r, h, 24).translate(0, y0 + h / 2, 0);
    const stepped = mergeGeometries([tier(26, 5, 0), tier(19, 5, 5), tier(12, 6, 10)], false)!;
    const place: Array<[THREE.BufferGeometry, number, number, number, number]> = [
      [tower, -95, -230, 1.3, 26], [tower, 120, -300, 1.7, 38], [tower, 30, -360, 1.1, 28],
      [pyramid, -40, -280, 1.2, 0], [pyramid, 70, -240, 0.9, 0], [stepped, -150, -330, 1.0, 0],
    ];
    const ringMat = this.lit(C.red, 1.8);
    const tipMat = this.lit(C.amber, 2.4);
    for (const [geo, x, z, k, ring] of place) {
      const m = this.solid(geo, C.navy, 0.35);
      m.position.set(x, 0, z);
      m.scale.setScalar(k);
      s.add(m);
      if (geo === tower) {
        const r = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.25, 6, 32).rotateX(Math.PI / 2), ringMat);
        r.position.set(x, ring * k, z);
        r.scale.setScalar(k);
        s.add(r);
      }
      if (geo === pyramid) {
        const sp = this.solid(spire, C.blue, 0.3);
        sp.position.set(x, 0, z);
        sp.scale.setScalar(k);
        s.add(sp);
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.8, 8, 6), tipMat);
        tip.position.set(x, 54.5 * k, z);
        s.add(tip);
        const halo = new THREE.Mesh(new THREE.TorusGeometry(5, 0.25, 6, 32).rotateX(Math.PI / 2), ringMat);
        halo.position.set(x, 62 * k, z);
        s.add(halo);
      }
    }
    return sky;
  }

  // ---------------------------------------------------------------- runtime

  /** Bake the image-based lighting from the hangar itself (call once the renderer is up). */
  bakeEnvironment(): void {
    if (this.envReady) return;
    this.envReady = true;
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const rt = pmrem.fromScene(this.scene, 0, 0.1, 500, { size: 256, position: new THREE.Vector3(0, 3, 0) });
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.8;
    pmrem.dispose();
  }

  setActive(on: boolean): void {
    this.controls.enabled = on;
    this.controls.autoRotate = false;
    this.idle = 0;
  }

  /** Frame a craft of this bounding radius sitting on the platform. */
  fit(radius: number, centerHeight: number): void {
    const r = Math.max(1, radius);
    this.controls.target.set(0, Math.max(0.6, centerHeight), 0);
    this.controls.minDistance = r * 1.1;
    this.controls.maxDistance = Math.min(22, r * 6);
    const dir = new THREE.Vector3(-0.62, 0.22, -0.75).normalize();
    this.camera.position.copy(this.controls.target).addScaledVector(dir, Math.min(18, r * 2.6 + 2));
    this.controls.update();
    this.sky.position.copy(this.camera.position);
  }

  resize(aspect: number): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
  }

  update(dt: number): void {
    // Slow showroom spin after 8 s without input.
    this.idle += dt;
    if (this.idle > 8) this.controls.autoRotate = true;
    this.controls.update(dt);
    this.sky.position.copy(this.camera.position);
  }
}
