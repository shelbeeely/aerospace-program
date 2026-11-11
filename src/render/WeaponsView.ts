import * as THREE from 'three/webgpu';
import { abs, float, max, positionLocal, smoothstep } from 'three/tsl';
import type { Projectile, WeaponSystem } from '../sim/weapons.ts';
import type { TslNode } from './neon.ts';

const MAX = 512;
/** Trail points kept per missile/bomb, and how many trails at once. */
const TRAIL_POINTS = 48;
const TRAILS = 48;
const BEAM_LIFE = 0.12;

/**
 * Rounds in flight (the player's weapon system and every hostile aircraft's), in the shooter's
 * circuit colour and the 1982 palette.
 * Gun tracers are thin streaks along their velocity; cannon shells amber-cored bolts; pulse bolts
 * glowing orbs; identity discs spinning rings of light; laser beams bright lines that fade in a
 * blink. Bombs are drawn as bombs (a fat body tapering to a heavy nose, a lit band, a ring tail
 * with four fins) and missiles as missiles (body, nose, fins, a flickering plume); both draw a
 * light trail behind them. Parts are instanced: light (additive) and solid (dark, lit edges).
 */
export class WeaponsView {
  private readonly light: THREE.InstancedMesh;
  private readonly solid: THREE.InstancedMesh;
  private readonly ring: THREE.InstancedMesh;
  private readonly trailLines: THREE.LineSegments;
  private readonly trailPos = new Float32Array(TRAILS * (TRAIL_POINTS - 1) * 2 * 3);
  private readonly trailCol = new Float32Array(TRAILS * (TRAIL_POINTS - 1) * 2 * 3);
  private readonly trails = new Map<number, { pts: THREE.Vector3[]; color: THREE.Color; last: number }>();
  private readonly beams: THREE.LineSegments;
  private readonly beamPos = new Float32Array(32 * 2 * 3);
  private readonly beamCol = new Float32Array(32 * 2 * 3);
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _q2 = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _d = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private readonly fwd = new THREE.Vector3(0, 0, 1);
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);
  private shown = { light: 0, solid: 0, ring: 0 };

  constructor(scene: THREE.Scene, private readonly systems: () => Iterable<WeaponSystem>) {
    const box = new THREE.BoxGeometry(1, 1, 1);
    const glow = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    // Brightest toward the tail (+z local), fading to the head.
    glow.colorNode = float(0.25).add(smoothstep(-0.5, 0.5, positionLocal.z).mul(2.4)) as TslNode;
    this.light = new THREE.InstancedMesh(box, glow, MAX);
    const body = new THREE.MeshBasicNodeMaterial();
    const p: TslNode = abs(positionLocal).mul(2);
    const e: TslNode = max(smoothstep(0.82, 0.98, p.x).mul(smoothstep(0.82, 0.98, p.y)), smoothstep(0.9, 1, p.z));
    body.colorNode = float(0.06).add(e.mul(2.2)) as TslNode;
    this.solid = new THREE.InstancedMesh(box, body, MAX);
    const ringMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide });
    ringMat.colorNode = float(2.2) as TslNode;
    this.ring = new THREE.InstancedMesh(new THREE.TorusGeometry(0.5, 0.06, 6, 24).rotateX(Math.PI / 2), ringMat, 64);
    for (const m of [this.light, this.solid, this.ring]) {
      for (let i = 0; i < m.count; i++) {
        m.setMatrixAt(i, this.zero);
        m.setColorAt(i, this._c.set('#00eaff'));
      }
      m.frustumCulled = false;
      m.count = 0;
      scene.add(m);
    }
    const lineMat = () => new THREE.LineBasicNodeMaterial({ vertexColors: true, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(this.trailPos, 3).setUsage(THREE.DynamicDrawUsage));
    tg.setAttribute('color', new THREE.BufferAttribute(this.trailCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.trailLines = new THREE.LineSegments(tg, lineMat());
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.BufferAttribute(this.beamPos, 3).setUsage(THREE.DynamicDrawUsage));
    bg.setAttribute('color', new THREE.BufferAttribute(this.beamCol, 3).setUsage(THREE.DynamicDrawUsage));
    this.beams = new THREE.LineSegments(bg, lineMat());
    for (const l of [this.trailLines, this.beams]) {
      l.frustumCulled = false;
      scene.add(l);
    }
  }

  update(time = 0): void {
    let nl = 0, ns = 0, nr = 0;
    const dir = this._d;
    /** Place a box: centre along the projectile axis at `back` metres behind `pos`. */
    const put = (mesh: THREE.InstancedMesh, i: number, pos: THREE.Vector3, d: THREE.Vector3, w: number, h: number, len: number, back: number, color: string, gain: number, roll = 0) => {
      this._q.setFromUnitVectors(this.fwd, this._p.copy(d).negate());
      if (roll) this._q.multiply(this._q2.setFromAxisAngle(this.fwd, roll));
      this._p.copy(pos).addScaledVector(d, -back);
      this._m.compose(this._p, this._q, this._s.set(w, h, len));
      mesh.setMatrixAt(i, this._m);
      mesh.setColorAt(i, this._c.set(color).multiplyScalar(gain));
    };
    const live = new Set<number>();
    for (const weapons of this.systems()) for (const pr of weapons.projectiles) {
      if (nl >= MAX - 6 || ns >= MAX - 8) break;
      const speed = pr.vel.length();
      dir.copy(pr.kind === 'missile' || pr.kind === 'bomb' ? pr.heading : pr.vel).normalize();
      if (!Number.isFinite(dir.x)) dir.set(0, -1, 0);
      switch (pr.kind) {
        case 'gun': {
          const len = Math.min(14, Math.max(2, speed / 60));
          put(this.light, nl++, pr.pos, dir, 0.09, 0.09, len, len / 2, pr.color, 1.6);
          break;
        }
        case 'cannon':
          put(this.light, nl++, pr.pos, dir, 0.32, 0.32, 3.2, 1.6, '#ffb000', 1.4);
          put(this.light, nl++, pr.pos, dir, 0.14, 0.14, 2.0, 0.8, pr.color, 2);
          break;
        case 'pulse':
          put(this.light, nl++, pr.pos, dir, 0.7, 0.7, 2.2, 0.6, pr.color, 1.8);
          put(this.light, nl++, pr.pos, dir, 0.3, 0.3, 1.0, 0.2, '#ffffff', 1.2);
          break;
        case 'disc':
          if (nr < 64) {
            // A spinning ring of light, flat to its flight.
            this._q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), pr.age * 30);
            this._m.compose(pr.pos, this._q, this._s.setScalar(0.9));
            this.ring.setMatrixAt(nr, this._m);
            this.ring.setColorAt(nr++, this._c.set(pr.color));
          }
          break;
        case 'bomb':
          // Body, heavy nose (dark, lit edges), a lit band, a ring tail and four fins.
          put(this.solid, ns++, pr.pos, dir, 0.42, 0.42, 1.0, 0.1, pr.color, 1);
          put(this.solid, ns++, pr.pos, dir, 0.3, 0.3, 0.35, -0.55, pr.color, 1);
          put(this.light, nl++, pr.pos, dir, 0.44, 0.44, 0.06, -0.25, pr.color, 1.6);
          put(this.solid, ns++, pr.pos, dir, 0.26, 0.26, 0.3, 0.75, pr.color, 1);
          put(this.solid, ns++, pr.pos, dir, 0.7, 0.03, 0.26, 0.85, pr.color, 1);
          put(this.solid, ns++, pr.pos, dir, 0.7, 0.03, 0.26, 0.85, pr.color, 1, Math.PI / 2);
          this.trail(pr, time, live);
          break;
        case 'missile': {
          put(this.solid, ns++, pr.pos, dir, 0.24, 0.24, 2.0, 0, pr.color, 1);
          put(this.light, nl++, pr.pos, dir, 0.16, 0.16, 0.3, -1.1, pr.color, 1.4); // lit seeker nose
          put(this.solid, ns++, pr.pos, dir, 0.6, 0.03, 0.3, 0.85, pr.color, 1);
          put(this.solid, ns++, pr.pos, dir, 0.6, 0.03, 0.3, 0.85, pr.color, 1, Math.PI / 2);
          const flick = 0.85 + 0.3 * Math.sin(pr.age * 90 + pr.id);
          put(this.light, nl++, pr.pos, dir, 0.34, 0.34, 4.5 * flick, 3.4, '#fff4d8', 1.2);
          this.trail(pr, time, live);
          break;
        }
      }
    }
    this.flush(this.light, nl, 'light');
    this.flush(this.solid, ns, 'solid');
    this.flush(this.ring, nr, 'ring');
    this.drawTrails(time, live);
    this.drawBeams(time);
  }

  private flush(mesh: THREE.InstancedMesh, n: number, key: 'light' | 'solid' | 'ring'): void {
    const was = this.shown[key];
    for (let i = n; i < was; i++) mesh.setMatrixAt(i, this.zero);
    if (n || was) {
      mesh.count = Math.max(n, 1);
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    }
    this.shown[key] = n;
  }

  /** Record a light-trail point for a missile or bomb (every ~3 m). */
  private trail(pr: Projectile, time: number, live: Set<number>): void {
    live.add(pr.id);
    let t = this.trails.get(pr.id);
    if (!t) {
      if (this.trails.size >= TRAILS) return;
      t = { pts: [], color: new THREE.Color(pr.color), last: time };
      this.trails.set(pr.id, t);
    }
    t.last = time;
    const tail = t.pts.at(-1);
    if (!tail || tail.distanceToSquared(pr.pos) > 9) {
      t.pts.push(pr.pos.clone());
      if (t.pts.length > TRAIL_POINTS) t.pts.shift();
    }
  }

  /** Trails fade toward their tails; a finished round's trail lingers a second, then goes. */
  private drawTrails(time: number, live: Set<number>): void {
    let o = 0;
    for (const [id, t] of this.trails) {
      const age = live.has(id) ? 0 : time - t.last;
      if (age > 1.2) { this.trails.delete(id); continue; }
      const fade = 1 - age / 1.2;
      for (let i = 1; i < t.pts.length; i++) {
        const a = t.pts[i - 1], b = t.pts[i];
        const ka = (i - 1) / t.pts.length * fade, kb = i / t.pts.length * fade;
        this.trailPos.set([a.x, a.y, a.z, b.x, b.y, b.z], o * 3);
        this.trailCol.set([t.color.r * ka, t.color.g * ka, t.color.b * ka, t.color.r * kb, t.color.g * kb, t.color.b * kb], o * 3);
        o += 2;
      }
    }
    const geo = this.trailLines.geometry;
    geo.setDrawRange(0, o);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  private drawBeams(time: number): void {
    let o = 0;
    for (const weapons of this.systems()) for (const b of weapons.beams) {
      if (o >= 64) break;
      const age = time - b.time;
      if (age < 0 || age > BEAM_LIFE) continue;
      const k = 1.6 * (1 - age / BEAM_LIFE);
      this._c.set(b.color);
      this.beamPos.set([b.a.x, b.a.y, b.a.z, b.b.x, b.b.y, b.b.z], o * 3);
      this.beamCol.set([this._c.r * k, this._c.g * k, this._c.b * k, this._c.r * k, this._c.g * k, this._c.b * k], o * 3);
      o += 2;
      if (o >= 64) break;
    }
    const geo = this.beams.geometry;
    geo.setDrawRange(0, o);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }
}
