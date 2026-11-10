import * as THREE from 'three';
import { partQuaternion } from './massProperties.ts';
import { BODY_COOL, BODY_WARM, circuitOf } from './style1982.ts';
import type { CraftDef, EngineDef, PartDef, ShapeDef, Vec3Tuple } from './types.ts';

/**
 * The vehicle grammar: the architecture rules (AGENTS.md §3, §5) applied to vehicles. A craft's
 * parts are its primary geometry (the silhouette); this reads what each part DOES (hull, wing,
 * fin, cockpit, engine, wheel, trail emitter) and derives secondary geometry (spines, armour
 * plates, wingtip caps, nozzle rings and petals, intake cowls, canopy frames, fender arcs) and
 * tertiary geometry (panel seams, chine light lines, intake lips, nozzle glow), seeded by the
 * craft's name so every design varies but the same craft always looks the same.
 *
 * Purely visual: the pieces are drawn by the renderer and never reach the physics, so they
 * cannot change how a tested design flies. Light is selective and functional: lit pieces are
 * tagged with what drives them (running lights follow the craft's activity, nozzle glow follows
 * the engine's spool and afterburner, damaged parts flicker), and their surface stays a small
 * share of the craft's.
 *
 * Math only (three.js vectors and quaternions); no scene objects.
 */

export type PieceShape =
  | { type: 'box'; size: Vec3Tuple }
  /** A (truncated) cone along local Z: rFront at -Z, rBack at +Z. */
  | { type: 'frustum'; rFront: number; rBack: number; length: number }
  /** A ring in the local XY plane (facing Z), optionally an arc of `arc` radians from +X. */
  | { type: 'ring'; radius: number; tube: number; arc?: number }
  /** A thin disc in the local XY plane (facing +Z). */
  | { type: 'disc'; radius: number };

export type PieceTone = 'body' | 'seam' | 'light';

export interface VehiclePiece {
  /** The part it belongs to (hidden with it when it breaks off; flickers when it's damaged). */
  partId: string;
  tier: 'secondary' | 'tertiary';
  /** The function it expresses: 'hull.spine', 'engine.nozzle', 'wheel.fender', ... */
  func: string;
  shape: PieceShape;
  /** Craft frame. */
  position: Vec3Tuple;
  quaternion: [number, number, number, number];
  tone: PieceTone;
  /** Colour (hex): a body shade for body/seam tones, a light colour for light. */
  color: string;
  /** What drives a lit piece: running lights follow activity; a nozzle follows its engine. */
  light?: { kind: 'running' } | { kind: 'nozzle'; engine: number; afterburner: boolean };
}

/** FNV-1a: a small, stable hash for seeding. */
function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Deterministic generator (mulberry32) for one part's choices. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function halfExtents(s: ShapeDef): THREE.Vector3 {
  if (s.type === 'box') return new THREE.Vector3(s.size[0] / 2, s.size[1] / 2, s.size[2] / 2);
  if (s.type === 'sphere') return new THREE.Vector3(s.radius, s.radius, s.radius);
  const r = s.radius, h = s.length / 2;
  const ax = s.axis ?? 'y';
  return ax === 'x' ? new THREE.Vector3(h, r, r) : ax === 'z' ? new THREE.Vector3(r, r, h) : new THREE.Vector3(r, h, r);
}

/** Distance along a ray (craft frame, from inside or behind) to where it leaves a part's box, or null if it misses. */
function leave(p: PartDef, o: THREE.Vector3, d: THREE.Vector3): { enter: number; exit: number } | null {
  const qi = partQuaternion(p).invert();
  const lo = o.clone().sub(new THREE.Vector3(...p.position)).applyQuaternion(qi);
  const ld = d.clone().applyQuaternion(qi);
  const h = halfExtents(p.shape);
  let t0 = -Infinity, t1 = Infinity;
  for (const [oo, dd, hh] of [[lo.x, ld.x, h.x], [lo.y, ld.y, h.y], [lo.z, ld.z, h.z]] as const) {
    if (Math.abs(dd) < 1e-9) { if (Math.abs(oo) > hh) return null; continue; }
    const a = (-hh - oo) / dd, b = (hh - oo) / dd;
    t0 = Math.max(t0, Math.min(a, b));
    t1 = Math.min(t1, Math.max(a, b));
  }
  return t1 >= Math.max(0, t0) ? { enter: t0, exit: t1 } : null;
}

const vol = (p: PartDef) => { const h = halfExtents(p.shape); return h.x * h.y * h.z * 8; };

/** A shade one step lighter than the part's body colour (secondary masses read against it). */
function lighterBody(color: string): string {
  const c = color.toLowerCase();
  for (const pal of [BODY_COOL, BODY_WARM] as const) {
    const i = (pal as readonly string[]).indexOf(c);
    if (i >= 0) return pal[Math.min(pal.length - 1, i + 1)];
  }
  return BODY_WARM.some((w) => w === c) ? BODY_WARM[2] : BODY_COOL[2];
}

/** Is the craft a warm (red-team) design? Then its pieces use the warm body ramp. */
function warmCraft(def: CraftDef): boolean {
  return def.parts.some((p) => (BODY_WARM as readonly string[]).includes(p.color.toLowerCase()));
}

const NOZZLE_COLOR: Record<string, string> = {
  turbofan: '#ff6a00', turbojet: '#ff6a00', rocket: '#ffb000', solid: '#ffb000', ramjet: '#3d7cff', scramjet: '#3d7cff',
};

/** Writer for one part's pieces in its own frame (positions/rotations converted to the craft frame). */
class PartFrame {
  readonly q: THREE.Quaternion;
  readonly c: THREE.Vector3;
  readonly h: THREE.Vector3;
  constructor(readonly part: PartDef, readonly out: VehiclePiece[]) {
    this.q = partQuaternion(part);
    this.c = new THREE.Vector3(...part.position);
    this.h = halfExtents(part.shape);
  }
  add(p: Omit<VehiclePiece, 'partId' | 'position' | 'quaternion'>, at: Vec3Tuple, rot?: THREE.Quaternion): void {
    const pos = new THREE.Vector3(...at).applyQuaternion(this.q).add(this.c);
    const q = this.q.clone();
    if (rot) q.multiply(rot);
    this.out.push({ ...p, partId: this.part.id, position: [pos.x, pos.y, pos.z], quaternion: [q.x, q.y, q.z, q.w] });
  }
}

const qAxis = (x: number, y: number, z: number, a: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(x, y, z), a);

/**
 * Secondary and tertiary geometry for a craft, from what its parts do. Deterministic for a
 * given craft; robust to partial or odd designs (a part it can't read gets nothing).
 */
export function vehicleGrammar(def: CraftDef): VehiclePiece[] {
  const out: VehiclePiece[] = [];
  if (!def.parts.length) return out;
  const circuit = circuitOf(def);
  const warm = warmCraft(def);
  const seed = hash(def.name ?? 'craft');
  const solid = def.parts.filter((p) => p.collider !== false);
  const main = [...(solid.length ? solid : def.parts)].sort((a, b) => vol(b) - vol(a))[0];
  const mainVol = vol(main);
  const hasWheels = def.parts.some((p) => p.modules?.some((m) => m.type === 'wheel'));
  const flies = def.parts.some((p) => p.modules?.some((m) => m.type === 'aero' || m.type === 'rotor' || m.type === 'buoyancy'));
  const covered = (pt: THREE.Vector3, except: PartDef) => def.parts.some((p) => {
    if (p === except || p.mass < 1 || /wheel|tyre|tire|hub/.test(p.kind)) return false; // a track housing covers its wheels too
    const h = halfExtents(p.shape);
    const l = pt.clone().sub(new THREE.Vector3(...p.position)).applyQuaternion(partQuaternion(p).invert());
    return Math.abs(l.x) <= h.x && Math.abs(l.y) <= h.y && Math.abs(l.z) <= h.z;
  });

  let engineIndex = 0;
  for (const part of def.parts) {
    const f = new PartFrame(part, out);
    const r = rng(seed ^ hash(part.id));
    const h = f.h;
    const body = (part.color && part.color.startsWith('#')) ? part.color : (warm ? BODY_WARM[1] : BODY_COOL[1]);
    const shade = lighterBody(body);
    const lit = part.collider !== false && part.mass > 1; // tiny/visual parts get nothing
    const isBox = part.shape.type === 'box';
    const kind = part.kind.toLowerCase();
    const aero = part.modules?.find((m) => m.type === 'aero');
    const isHull = part === main || (lit && /fuselage|hull|body|chassis|cabin|gondola/.test(kind) && vol(part) > mainVol * 0.25);
    const isWing = lit && isBox && !!aero && h.x > h.y * 4 && h.x > 0.6;
    const isFin = lit && isBox && !!aero && !isWing && h.y > h.x * 2.5 && h.y > 0.3;
    const isCockpit = /cockpit|canopy|cab\b|cabin/.test(kind) && part !== main;

    // ---- hulls: spine, layered armour plates, panel seams, chine light lines
    if (isHull && lit && h.z > 0.15 && h.y > 0.04) {
      const L = h.z * 2;
      // Spine: one to three stepped masses along the top (seeded), the silhouette's ridge.
      const steps = 1 + Math.floor(r() * 3);
      const w0 = Math.max(0.08, h.x * (0.35 + r() * 0.2));
      for (let i = 0; i < steps; i++) {
        const len = L * (0.66 - i * 0.18);
        const w = w0 * (1 - i * 0.28);
        const t = Math.min(h.y * 0.3, Math.max(0.035, Math.min(0.14, h.y * 0.08)));
        f.add({ tier: 'secondary', func: 'hull.spine', shape: { type: 'box', size: [w, t, len] }, tone: 'body', color: shade }, [0, h.y + t * (i + 0.5), L * 0.04 * i]);
      }
      // Armour plates down each flank: 2-4, standing proud of the side, slightly varied.
      const n = 2 + Math.floor(r() * 3);
      const span = L * 0.78;
      const seg = span / n;
      const ph = h.y * (0.45 + r() * 0.25);
      const py = -h.y * (0.05 + r() * 0.2);
      for (const s of [-1, 1]) for (let i = 0; i < n; i++) {
        const z = -span / 2 + seg * (i + 0.5);
        f.add({ tier: 'secondary', func: 'hull.plate', shape: { type: 'box', size: [0.04, ph * (i % 2 ? 0.86 : 1), seg * 0.86] }, tone: 'body', color: shade }, [s * (h.x + 0.02), py, z]);
      }
      // Chine light line: one thin circuit line along each flank, below the plates.
      const cy = py - ph / 2 - Math.min(0.08, h.y * 0.1);
      const lw = Math.min(0.03, Math.max(0.008, h.y * 0.06)); // light lines scale with the craft
      if (cy > -h.y) for (const s of [-1, 1]) {
        f.add({ tier: 'tertiary', func: 'hull.chine', shape: { type: 'box', size: [lw, lw, span * 0.92] }, tone: 'light', color: circuit, light: { kind: 'running' } }, [s * (h.x + 0.02), cy, 0]);
      }
      // Panel seams: transverse bands over the top every 1.2-2 m (dark, slightly proud).
      const pitch = 1.2 + r() * 0.8;
      const bands = Math.min(8, Math.floor(L / pitch));
      for (let i = 1; i <= bands; i++) {
        const z = -h.z + (L * i) / (bands + 1);
        f.add({ tier: 'tertiary', func: 'hull.seam', shape: { type: 'box', size: [h.x * 2 + 0.01, 0.015, 0.035] }, tone: 'seam', color: shade }, [0, h.y + 0.004, z]);
      }
      // Nose sensor ring for flying hulls: a dark collar a little behind the nose.
      if (flies && part === main) {
        const rr = Math.min(h.x, h.y) * 1.02;
        f.add({ tier: 'secondary', func: 'hull.collar', shape: { type: 'ring', radius: rr, tube: Math.max(0.025, rr * 0.06) }, tone: 'body', color: shade }, [0, 0, -h.z * 0.82]);
      }
    }

    // ---- wings: tip caps with a tip light, a boundary-layer fence, chordwise seams
    if (isWing) {
      const tips = Math.abs(part.position[0]) < h.x * 0.5 ? [-1, 1] : [Math.sign(part.position[0]) || 1];
      for (const s of tips) {
        f.add({ tier: 'secondary', func: 'wing.tip', shape: { type: 'box', size: [0.08, h.y * 2 + 0.08, h.z * 1.7] }, tone: 'body', color: shade }, [s * (h.x + 0.04), 0, h.z * 0.1]);
        f.add({ tier: 'tertiary', func: 'wing.tiplight', shape: { type: 'box', size: [0.05, 0.05, h.z * 0.9] }, tone: 'light', color: circuit, light: { kind: 'running' } }, [s * (h.x + 0.09), 0, -h.z * 0.2]);
        if (r() < 0.7) f.add({ tier: 'secondary', func: 'wing.fence', shape: { type: 'box', size: [0.03, Math.max(0.08, h.y * 1.6), h.z * 1.6] }, tone: 'body', color: shade }, [s * h.x * (0.35 + r() * 0.2), h.y + Math.max(0.04, h.y * 0.8), 0]);
      }
      const seams = 2 + Math.floor(r() * 2);
      for (let i = 1; i <= seams; i++) {
        const x = -h.x + (2 * h.x * i) / (seams + 1);
        f.add({ tier: 'tertiary', func: 'wing.seam', shape: { type: 'box', size: [0.03, 0.012, h.z * 1.9] }, tone: 'seam', color: shade }, [x, h.y + 0.003, 0]);
      }
    }

    // ---- fins: a lit cap along the top edge, a root fairing
    if (isFin) {
      f.add({ tier: 'tertiary', func: 'fin.cap', shape: { type: 'box', size: [h.x * 2 + 0.04, 0.04, h.z * 1.5] }, tone: 'light', color: circuit, light: { kind: 'running' } }, [0, h.y + 0.02, 0]);
      f.add({ tier: 'secondary', func: 'fin.root', shape: { type: 'box', size: [h.x * 2 + 0.12, 0.08, h.z * 1.9] }, tone: 'body', color: shade }, [0, -h.y + 0.04, 0]);
    }

    // ---- cockpits: canopy frame bars, a lit sill around the base
    if (isCockpit && part.shape.type === 'box' && h.z > 0.2) {
      for (const z of [-h.z * 0.35, h.z * 0.3]) {
        f.add({ tier: 'secondary', func: 'cockpit.frame', shape: { type: 'box', size: [h.x * 2 + 0.04, 0.04, 0.05] }, tone: 'body', color: warm ? BODY_WARM[2] : BODY_COOL[2] }, [0, h.y + 0.01, z]);
      }
      for (const s of [-1, 1]) {
        f.add({ tier: 'tertiary', func: 'cockpit.sill', shape: { type: 'box', size: [0.025, 0.025, h.z * 1.8] }, tone: 'light', color: circuit, light: { kind: 'running' } }, [s * (h.x + 0.015), -h.y * 0.6, 0]);
      }
    }

    // ---- modules: engines (nozzle, petals, glow, intake), wheels (fenders), trail emitters
    for (const m of part.modules ?? []) {
      if (m.type === 'engine') {
        const idx = engineIndex++;
        const e = m as EngineDef;
        const prop = e.kind === 'prop' || (!e.kind && e.propMaxSpeed !== undefined);
        const o = new THREE.Vector3(...(e.offset ?? [0, 0, 0]));
        if (prop) {
          // A cowl ring behind the spinner.
          f.add({ tier: 'secondary', func: 'engine.cowl', shape: { type: 'ring', radius: 0.32, tube: 0.06 }, tone: 'body', color: shade }, [o.x, o.y, o.z + 0.2]);
          continue;
        }
        // Thrust is along the part's -Z; the exhaust plane is where +Z leaves the part.
        const back = new THREE.Vector3(0, 0, 1);
        const exit = (dir: THREE.Vector3) => {
          // Distance from o along dir to the part's box surface.
          let t = Infinity;
          for (const [d, oo, hh] of [[dir.x, o.x, h.x], [dir.y, o.y, h.y], [dir.z, o.z, h.z]] as const) {
            if (Math.abs(d) < 1e-6) continue;
            const tt = ((d > 0 ? hh : -hh) - oo) / d;
            if (tt >= 0) t = Math.min(t, tt);
          }
          return Number.isFinite(t) ? t : 0;
        };
        // Cross-section radius: the part's extent across the thrust axis.
        const across = Math.abs(back.z) > 0.7 ? Math.min(h.x, h.y) : Math.abs(back.x) > 0.7 ? Math.min(h.y, h.z) : Math.min(h.x, h.z);
        const R = Math.max(0.12, Math.min(3, across * 0.82));
        const pAt = (d: number) => o.clone().addScaledVector(back, d);
        let face = exit(back);
        // An exhaust that leaves into another part (a tailcone, a nacelle fairing) runs on
        // through it: the nozzle goes where the jet actually leaves the craft.
        {
          const oc = o.clone().applyQuaternion(f.q).add(f.c);
          const dc = back.clone().applyQuaternion(f.q);
          for (let k = 0; k < 4; k++) {
            let next = face;
            for (const other of def.parts) {
              if (other === part || other.collider === false || other.mass < 1) continue;
              const hit = leave(other, oc, dc);
              if (hit && hit.enter <= face + 0.05 && hit.exit > next) next = hit.exit;
            }
            if (next <= face + 1e-3) break;
            face = next;
          }
        }
        const rot = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), back);
        const nz = pAt(face + 0.02);
        f.add({ tier: 'secondary', func: 'engine.nozzle', shape: { type: 'ring', radius: R, tube: R * 0.12 }, tone: 'body', color: shade }, [nz.x, nz.y, nz.z], rot);
        // Petals: a short converging frustum behind the ring (rockets: a bell flaring out).
        const rocket = e.kind === 'rocket' || e.kind === 'solid';
        const pl = R * (rocket ? 0.9 : 0.45);
        const pc = pAt(face + pl / 2);
        f.add({ tier: 'secondary', func: rocket ? 'engine.bell' : 'engine.petals', shape: { type: 'frustum', rFront: R * (rocket ? 0.55 : 1.0), rBack: R * (rocket ? 1.05 : 0.78), length: pl }, tone: 'body', color: warm ? BODY_WARM[3] : BODY_COOL[3] }, [pc.x, pc.y, pc.z], rot);
        // The glow: a lit disc set just inside the petals, driven by spool and afterburner.
        const gp = pAt(face + 0.04);
        f.add({ tier: 'tertiary', func: 'engine.glow', shape: { type: 'disc', radius: R * 0.74 }, tone: 'light', color: NOZZLE_COLOR[e.kind ?? ''] ?? '#ff6a00', light: { kind: 'nozzle', engine: idx, afterburner: !!e.afterburner } }, [gp.x, gp.y, gp.z], rot);
        // Air-breathers: an intake cowl ring at the front with a thin lit lip.
        if (!rocket) {
          const front = exit(back.clone().negate());
          if (front > 0.3) {
            const ip = pAt(-front - 0.02);
            f.add({ tier: 'secondary', func: 'engine.intake', shape: { type: 'ring', radius: R * 0.92, tube: R * 0.1 }, tone: 'body', color: shade }, [ip.x, ip.y, ip.z], rot);
            f.add({ tier: 'tertiary', func: 'engine.lip', shape: { type: 'ring', radius: R * 0.92, tube: Math.max(0.012, R * 0.025) }, tone: 'light', color: circuit, light: { kind: 'running' } }, [ip.x, ip.y, ip.z], rot);
          }
        }
      } else if (m.type === 'wheel' && !flies && hasWheels) {
        // Fender arcs over exposed road wheels (ground vehicles), a lit line on the outer edge.
        const o = new THREE.Vector3(...(m.offset ?? [0, 0, 0]));
        const centre = o.clone().add(new THREE.Vector3(0, -m.restLength * 0.7, 0));
        const world = centre.clone().applyQuaternion(f.q).add(f.c);
        if (covered(world, part)) continue; // inside a track housing or body
        const side = Math.sign(world.x) || 1;
        const rot = qAxis(0, 1, 0, Math.PI / 2);
        const rr = m.radius + 0.1;
        const at: Vec3Tuple = [centre.x + side * 0.02, centre.y, centre.z];
        f.add({ tier: 'secondary', func: 'wheel.fender', shape: { type: 'ring', radius: rr, tube: Math.max(0.04, m.radius * 0.12), arc: Math.PI }, tone: 'body', color: shade }, at, rot);
        f.add({ tier: 'tertiary', func: 'wheel.fenderlight', shape: { type: 'ring', radius: rr + Math.max(0.04, m.radius * 0.12), tube: 0.015, arc: Math.PI * 0.8 }, tone: 'light', color: circuit, light: { kind: 'running' } }, [at[0] + side * 0.03, at[1], at[2]], rot.clone().multiply(qAxis(0, 0, 1, Math.PI * 0.1)));
      } else if (m.type === 'rotor') {
        // A hub cap over the mast; small rotors get a guard ring with a lit rim.
        const o = m.offset ?? [0, 0, 0];
        const flat = qAxis(1, 0, 0, Math.PI / 2);
        const hub = Math.max(0.04, m.radius * 0.08);
        f.add({ tier: 'secondary', func: 'rotor.hub', shape: { type: 'frustum', rFront: hub, rBack: hub * 0.5, length: hub * 1.2 }, tone: 'body', color: shade }, [o[0], o[1] + hub * 0.6, o[2]], qAxis(1, 0, 0, -Math.PI / 2));
        if (m.radius < 1.5) {
          f.add({ tier: 'secondary', func: 'rotor.guard', shape: { type: 'ring', radius: m.radius * 1.06, tube: Math.max(0.012, m.radius * 0.035) }, tone: 'body', color: shade }, [o[0], o[1], o[2]], flat);
          f.add({ tier: 'tertiary', func: 'rotor.rim', shape: { type: 'ring', radius: m.radius * 1.06, tube: Math.max(0.006, m.radius * 0.012), arc: Math.PI * 0.6 }, tone: 'light', color: circuit, light: { kind: 'running' } }, [o[0], o[1] + Math.max(0.012, m.radius * 0.035), o[2]], flat);
        }
      } else if (m.type === 'trail') {
        // The emitter: a short fin at the trail's root with a lit trailing edge.
        const o = m.offset ?? [0, 0, 0];
        const ht = Math.min(0.5, Math.max(0.15, (m.height ?? 1) * 0.12));
        f.add({ tier: 'secondary', func: 'trail.emitter', shape: { type: 'box', size: [0.06, ht, 0.3] }, tone: 'body', color: shade }, [o[0], o[1] + ht / 2, o[2] - 0.1]);
        f.add({ tier: 'tertiary', func: 'trail.emitterlight', shape: { type: 'box', size: [0.07, ht, 0.03] }, tone: 'light', color: circuit, light: { kind: 'running' } }, [o[0], o[1] + ht / 2, o[2] + 0.05]);
      }
    }
  }
  return out;
}

/** Visible surface (m², approximate) of a piece, for the light-share rule. */
export function pieceArea(s: PieceShape): number {
  switch (s.type) {
    case 'box': { const [a, b, c] = s.size; return 2 * (a * b + b * c + a * c); }
    case 'frustum': return Math.PI * (s.rFront + s.rBack) * s.length;
    case 'ring': return 4 * Math.PI * Math.PI * s.radius * s.tube * ((s.arc ?? Math.PI * 2) / (Math.PI * 2));
    case 'disc': return Math.PI * s.radius * s.radius;
  }
}
