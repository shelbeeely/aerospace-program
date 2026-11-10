import * as THREE from 'three/webgpu';
import { abs, float, max, min, normalView, positionLocal, positionViewDirection, pow, smoothstep } from 'three/tsl';
import type { ChipEmitter } from '../sim/chips.ts';
import type { TslNode } from './neon.ts';

const MAX = 12000;
/** Energy-splash droplets in flight. */
const SPLASH = 6000;
/** Share of derez voxels that go rogue: red/orange fragments still derezzing, flickering out. */
const ROGUE = 0.04;
const ROGUE_COLORS = ['#ff2a12', '#ff6a00', '#ffa000'];

/**
 * Flying voxel chips (visual only): every burst from the simulation's ChipEmitter becomes small
 * cubes with glowing edges that fly with the impactor, scatter outward, tumble, bounce on the
 * street and fade out. One InstancedMesh, CPU-integrated (no physics bodies).
 */
export class ChipsView {
  readonly mesh: THREE.InstancedMesh;
  private readonly pos = new Float32Array(MAX * 3);
  private readonly vel = new Float32Array(MAX * 3);
  private readonly spin = new Float32Array(MAX * 3);
  private readonly rot = new Float32Array(MAX * 3);
  private readonly size = new Float32Array(MAX);
  private readonly life = new Float32Array(MAX);
  private readonly age = new Float32Array(MAX);
  /** 1 = derez voxel that stays on the Grid once it lands. */
  private readonly keep = new Uint8Array(MAX);
  /** Rogue fragment: its colour index + 1 (0 = an ordinary chip), and its flicker phase. */
  private readonly rogue = new Uint8Array(MAX);
  private readonly phase = new Float32Array(MAX);
  private rogueLive = 0;
  // Splash droplets: position, velocity, floor (the grid at the impact site), colour, life.
  readonly splash: THREE.InstancedMesh;
  private readonly sPos = new Float32Array(SPLASH * 3);
  private readonly sVel = new Float32Array(SPLASH * 3);
  private readonly sFloor = new Float32Array(SPLASH);
  private readonly sCol = new Float32Array(SPLASH * 3);
  private readonly sSize = new Float32Array(SPLASH);
  private readonly sLife = new Float32Array(SPLASH);
  private readonly sAge = new Float32Array(SPLASH);
  private sNext = 0;
  private sLive = 0;
  private readonly _d = new THREE.Vector3();
  private readonly _z = new THREE.Vector3(0, 0, 1);
  private next = 0;
  private live = 0;
  private seenSeq = 0;
  private readonly _m = new THREE.Matrix4();
  private readonly _q = new THREE.Quaternion();
  private readonly _e = new THREE.Euler();
  private readonly _p = new THREE.Vector3();
  private readonly _s = new THREE.Vector3();
  private readonly _c = new THREE.Color();
  private readonly _c2 = new THREE.Color();
  private readonly zero = new THREE.Matrix4().makeScale(0, 0, 0);

  constructor(scene: THREE.Scene, private readonly emitter: ChipEmitter) {
    const mat = new THREE.MeshBasicNodeMaterial();
    // Glowing cube edges: brightest where two faces meet, dark-ish faces in between.
    const p: TslNode = abs(positionLocal).mul(2); // 0 at centre, 1 at the faces
    const a: TslNode = smoothstep(0.78, 0.98, p.x);
    const b: TslNode = smoothstep(0.78, 0.98, p.y);
    const c: TslNode = smoothstep(0.78, 0.98, p.z);
    const edge: TslNode = max(max(min(a, b), min(b, c)), min(a, c));
    // Glass-like: faint body, bright edges, and a sheen where faces turn away from the eye.
    const sheen: TslNode = pow(float(1).sub(abs(normalView.dot(positionViewDirection))), 2.5);
    mat.colorNode = float(0.14).add(edge.mul(3.2)).add(sheen.mul(0.9)) as TslNode; // × the instance colour
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, MAX);
    // InstancedMesh colours multiply the material colour; the node above scales brightness.
    for (let i = 0; i < MAX; i++) {
      this.mesh.setMatrixAt(i, this.zero);
      this.mesh.setColorAt(i, this._c.set('#00eaff'));
    }
    this.mesh.frustumCulled = false;
    scene.add(this.mesh);

    // Splash droplets: additive streaks stretched along their velocity, bright at the head.
    const smat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending });
    smat.colorNode = float(0.35).add(smoothstep(-0.5, 0.5, positionLocal.z).mul(1.6)) as TslNode; // × instance colour (faded)
    this.splash = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), smat, SPLASH);
    for (let i = 0; i < SPLASH; i++) {
      this.splash.setMatrixAt(i, this.zero);
      this.splash.setColorAt(i, this._c.set(0, 0, 0));
    }
    this.splash.frustumCulled = false;
    scene.add(this.splash);
  }

  /**
   * A high-energy derez splash: droplets of the vehicle's energy erupt from the grid at the
   * impact site in a crown, each on its own parabolic arc (launch elevation 48-84°, gravity
   * 9.81 m/s², a little drag), and dissipate where they fall back to the grid.
   */
  private emitSplash(b: { x: number; y: number; z: number; radius: number; vx: number; vz: number; speed: number; count: number; size: number; color: string }): void {
    this._c.set(b.color).multiplyScalar(1.8);
    for (let k = 0; k < b.count; k++) {
      const i = this.sNext;
      this.sNext = (this.sNext + 1) % SPLASH;
      const az = Math.random() * Math.PI * 2;
      // Most droplets go steeply up (the column); a third spray out low (the crown).
      const el = (Math.random() < 0.65 ? 64 + Math.random() * 20 : 48 + Math.random() * 16) * (Math.PI / 180);
      const sp = b.speed * (0.45 + Math.random() * 0.75);
      const r0 = b.radius * Math.sqrt(Math.random());
      this.sPos[i * 3] = b.x + Math.cos(az) * r0;
      this.sPos[i * 3 + 1] = b.y + 0.05;
      this.sPos[i * 3 + 2] = b.z + Math.sin(az) * r0;
      this.sVel[i * 3] = Math.cos(az) * Math.cos(el) * sp + b.vx * 0.12;
      this.sVel[i * 3 + 1] = Math.sin(el) * sp;
      this.sVel[i * 3 + 2] = Math.sin(az) * Math.cos(el) * sp + b.vz * 0.12;
      this.sFloor[i] = b.y;
      this.sCol[i * 3] = this._c.r; this.sCol[i * 3 + 1] = this._c.g; this.sCol[i * 3 + 2] = this._c.b;
      this.sSize[i] = b.size * (0.6 + Math.random() * 0.8);
      // The energy rises, crests and dissipates on the way down: low crown droplets complete
      // their arc to the grid; the tall column fades out about half way back down.
      const vy = Math.sin(el) * sp;
      this.sLife[i] = Math.min((2 * vy) / 9.81 + 0.4, (1.5 * vy) / 9.81 + 0.3 + Math.random() * 0.4);
      this.sAge[i] = 0;
    }
  }

  private updateSplash(dt: number): void {
    let live = 0;
    for (let i = 0; i < SPLASH; i++) {
      if (this.sLife[i] <= 0) continue;
      this.sAge[i] += dt;
      if (this.sAge[i] >= this.sLife[i]) {
        this.sLife[i] = 0;
        this.splash.setMatrixAt(i, this.zero);
        continue;
      }
      live++;
      const o = i * 3;
      const v = this.sVel;
      const landed = this.sPos[o + 1] <= this.sFloor[i] + 0.02 && v[o + 1] <= 0;
      if (!landed) {
        // Ballistic: gravity plus light drag (energy, not water, but it arcs the same).
        const drag = Math.exp(-0.08 * dt);
        v[o] *= drag; v[o + 2] *= drag;
        v[o + 1] = v[o + 1] * drag - 9.81 * dt;
        this.sPos[o] += v[o] * dt;
        this.sPos[o + 1] += v[o + 1] * dt;
        this.sPos[o + 2] += v[o + 2] * dt;
        if (this.sPos[o + 1] <= this.sFloor[i]) {
          // Hit the grid: stop, spread flat and dissipate within ~0.4 s.
          this.sPos[o + 1] = this.sFloor[i] + 0.02;
          v[o] *= 0.2; v[o + 2] *= 0.2; v[o + 1] = 0;
          this.sLife[i] = Math.min(this.sLife[i], this.sAge[i] + 0.4);
        }
      } else {
        this.sPos[o] += v[o] * dt;
        this.sPos[o + 2] += v[o + 2] * dt;
      }
      const left = this.sLife[i] - this.sAge[i];
      // The energy dissipates along the arc: bright at the eruption, thinning as it falls.
      const fade = Math.min(1, left / 0.5) * Math.min(1, this.sAge[i] / 0.05) * Math.pow(1 - this.sAge[i] / this.sLife[i], 1.2);
      const s = this.sSize[i];
      const speed = Math.hypot(v[o], v[o + 1], v[o + 2]);
      if (landed || speed < 0.5) {
        // A flat glowing splat on the grid.
        this._q.identity();
        this._s.set(s * 2.4, s * 0.15, s * 2.4);
      } else {
        this._q.setFromUnitVectors(this._z, this._d.set(v[o], v[o + 1], v[o + 2]).divideScalar(speed));
        this._s.set(s, s, s + Math.min(2.2, speed * 0.05));
      }
      this._m.compose(this._p.set(this.sPos[o], this.sPos[o + 1], this.sPos[o + 2]), this._q, this._s);
      this.splash.setMatrixAt(i, this._m);
      this.splash.setColorAt(i, this._c.setRGB(this.sCol[o] * fade, this.sCol[o + 1] * fade, this.sCol[o + 2] * fade));
    }
    if (live || this.sLive) {
      this.splash.instanceMatrix.needsUpdate = true;
      if (this.splash.instanceColor) this.splash.instanceColor.needsUpdate = true;
    }
    this.sLive = live;
  }

  /** Flush on reset. */
  clear(): void {
    this.life.fill(0);
    this.age.fill(0);
    this.rogue.fill(0);
    this.sLife.fill(0);
    for (let i = 0; i < MAX; i++) this.mesh.setMatrixAt(i, this.zero);
    for (let i = 0; i < SPLASH; i++) this.splash.setMatrixAt(i, this.zero);
    this.mesh.instanceMatrix.needsUpdate = true;
    this.splash.instanceMatrix.needsUpdate = true;
    this.live = 0;
    this.sLive = 0;
  }

  update(dt: number): void {
    // New bursts.
    if (this.emitter.seq < this.seenSeq) {
      this.seenSeq = 0; // the emitter was reset
      this.clear();
    }
    for (const b of this.emitter.bursts) {
      if (b.seq <= this.seenSeq) continue;
      this.seenSeq = b.seq;
      if (b.splash) {
        this.emitSplash(b);
        continue;
      }
      this._c.set(b.color).multiplyScalar(1.4);
      for (let k = 0; k < b.count; k++) {
        const i = this.next;
        this.next = (this.next + 1) % MAX;
        const dx = Math.random() * 2 - 1, dy = Math.random() * 2 - 1, dz = Math.random() * 2 - 1;
        const len = Math.hypot(dx, dy, dz) || 1;
        this.pos[i * 3] = b.x + (dx / len) * b.radius * Math.random();
        this.pos[i * 3 + 1] = b.y + (dy / len) * b.radius * Math.random();
        this.pos[i * 3 + 2] = b.z + (dz / len) * b.radius * Math.random();
        const sp = b.speed * (0.4 + Math.random() * 0.8);
        this.vel[i * 3] = b.vx + (dx / len) * sp;
        this.vel[i * 3 + 1] = b.vy + Math.abs(dy / len) * sp * 0.7 + 1;
        this.vel[i * 3 + 2] = b.vz + (dz / len) * sp;
        this.spin[i * 3] = (Math.random() - 0.5) * 14;
        this.spin[i * 3 + 1] = (Math.random() - 0.5) * 14;
        this.spin[i * 3 + 2] = (Math.random() - 0.5) * 14;
        this.size[i] = b.size * (0.6 + Math.random() * 0.7);
        this.keep[i] = b.persist ? 1 : 0;
        // Derez voxels remain on the Grid (until the pool recycles them or the world resets);
        // rogue fragments flicker out over a minute; impact chips fade in 5-10 s.
        this.life[i] = b.persist ? 150 + Math.random() * 60 : 5 + Math.random() * 5;
        this.age[i] = 0;
        this.rogue[i] = 0;
        if (b.persist && Math.random() < ROGUE) {
          // Rogue: a red/orange fragment that keeps derezzing, flickering until it winks out.
          this.rogue[i] = 1 + Math.floor(Math.random() * ROGUE_COLORS.length);
          this.phase[i] = Math.random() * 100;
          this.life[i] = 20 + Math.random() * 50;
          this.mesh.setColorAt(i, this._c2.set(ROGUE_COLORS[this.rogue[i] - 1]).multiplyScalar(1.6));
        } else this.mesh.setColorAt(i, this._c);
      }
      if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    }

    // Integrate: gravity, drag, ground bounce, fade by shrinking.
    let live = 0;
    let rogues = 0;
    for (let i = 0; i < MAX; i++) {
      if (this.life[i] <= 0) continue;
      this.age[i] += dt;
      if (this.age[i] >= this.life[i]) {
        this.life[i] = 0;
        this.mesh.setMatrixAt(i, this.zero);
        continue;
      }
      live++;
      const o = i * 3;
      const s = this.size[i];
      this.vel[o + 1] -= 9.81 * dt;
      const drag = Math.exp(-0.15 * dt);
      this.vel[o] *= drag;
      this.vel[o + 2] *= drag;
      this.pos[o] += this.vel[o] * dt;
      this.pos[o + 1] += this.vel[o + 1] * dt;
      this.pos[o + 2] += this.vel[o + 2] * dt;
      if (this.pos[o + 1] < s / 2) {
        this.pos[o + 1] = s / 2;
        if (this.vel[o + 1] < 0) this.vel[o + 1] *= -0.3;
        this.vel[o] *= 0.6;
        this.vel[o + 2] *= 0.6;
        this.spin[o] *= 0.7;
        this.spin[o + 1] *= 0.7;
        this.spin[o + 2] *= 0.7;
        if (this.keep[i] && Math.abs(this.vel[o + 1]) < 0.6) {
          // Settled: lie flat on the Grid like broken glass, and stay.
          this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
          this.spin[o] = this.spin[o + 1] = this.spin[o + 2] = 0;
          this.rot[o] = Math.round(this.rot[o] / (Math.PI / 2)) * (Math.PI / 2);
          this.rot[o + 2] = Math.round(this.rot[o + 2] / (Math.PI / 2)) * (Math.PI / 2);
        }
      }
      this.rot[o] += this.spin[o] * dt;
      this.rot[o + 1] += this.spin[o + 1] * dt;
      this.rot[o + 2] += this.spin[o + 2] * dt;
      let fade = Math.min(1, (this.life[i] - this.age[i]) / (this.keep[i] ? 4 : 1.2));
      if (this.rogue[i]) {
        // Still derezzing: it flickers, brightness and size, and shrinks as it goes.
        rogues++;
        const t = this.age[i] * 9 + this.phase[i];
        const flick = 0.55 + 0.45 * Math.sin(t) * Math.sin(t * 2.3 + 1.7);
        const gone = 1 - this.age[i] / this.life[i];
        fade *= 0.35 + 0.65 * gone;
        this.mesh.setColorAt(i, this._c2.set(ROGUE_COLORS[this.rogue[i] - 1]).multiplyScalar(0.4 + 1.8 * flick * gone));
      }
      this._q.setFromEuler(this._e.set(this.rot[o], this.rot[o + 1], this.rot[o + 2]));
      this._m.compose(this._p.set(this.pos[o], this.pos[o + 1], this.pos[o + 2]), this._q, this._s.setScalar(s * fade));
      this.mesh.setMatrixAt(i, this._m);
    }
    if (live || this.live) this.mesh.instanceMatrix.needsUpdate = true;
    if ((rogues || this.rogueLive) && this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.live = live;
    this.rogueLive = rogues;
    this.updateSplash(dt);
  }
}
