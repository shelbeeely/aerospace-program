import * as THREE from 'three';
import type { CraftDef } from '../craft/types.ts';
import { partQuaternion } from '../craft/massProperties.ts';
import { wrapDelta } from '../sim/contacts.ts';
import type { Simulation } from '../sim/Simulation.ts';
import type { Telemetry } from '../sim/telemetry.ts';
import { TRAFFIC } from '../sim/traffic.ts';
import { STYLE_LIGHT, STYLE_SIZE } from '../people/bitStyle.ts';
import { BIT_LOOK } from '../people/bit.ts';
import { hostile, sideLight, TEAMS } from '../sim/teams.ts';
import { BIT_STATES, CAP, FRAME_RANGE, FRAME_VERSION, luminance, type CraftShape, type PartShape, type TvFrame, type TvHud } from './format.ts';

export * from './format.ts';

/**
 * What the TV draws, as plain data: the player's pose and craft, every moving thing within
 * FRAME_RANGE of it, and the HUD. Built from a Simulation (here, DOM- and scene-free) and drawn
 * by the Canvas 2D renderer (src/tv/TvRenderer.ts). The same frame is built wherever the game
 * runs: in a worker on the TV (posted to its page) or on the phone (sent over the cast channel).
 *
 * Entities are flat number arrays with a fixed stride (compact JSON); colours are indices into
 * `pal`. Static architecture is not in the frame: the TV plans it itself from the seed and only
 * hears which structures are broken (`broken`) and which planet chunks are registered (`chunks`).
 */

const SHAPE_CODE = { box: 0, cylinder: 1, cone: 2, sphere: 3, capsule: 4 } as const;
const AXIS = { x: 0, y: 1, z: 2 } as const;
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;

/** The craft as the TV draws it. */
export function craftShape(def: CraftDef, key: string, radius: number): CraftShape {
  const q = new THREE.Quaternion();
  const parts: PartShape[] = def.parts.map((part) => {
    const sh = part.shape;
    let d: [number, number, number];
    if (sh.type === 'box') d = [r2(sh.size[0]), r2(sh.size[1]), r2(sh.size[2])];
    else if (sh.type === 'sphere') d = [r2(sh.radius), 0, 0];
    else d = [r2(sh.radius), r2(sh.length), AXIS[sh.axis ?? 'z']];
    partQuaternion(part, q);
    return {
      id: part.id,
      s: SHAPE_CODE[sh.type],
      d,
      ...(sh.type === 'cone' && sh.tip === 1 ? { tip: 1 as const } : {}),
      p: [r2(part.position[0]), r2(part.position[1]), r2(part.position[2])],
      q: [r2(q.x), r2(q.y), r2(q.z), r2(q.w)],
      c: part.color,
      lit: luminance(part.color) > 0.42 ? 1 : 0,
    };
  });
  return { key, name: def.name, radius: r1(radius), parts };
}

/** Builds frames from one simulation; keeps the palette and what was last sent. */
export class FrameBuilder {
  private n = 0;
  private sentCraft = '';
  private sentCraftAt = -Infinity;
  private sentChunks = -1;
  private sentChunksAt = -Infinity;
  /** Resend the craft shape and the chunk list this often (s) for a TV that joined late. */
  resendEvery = 2;
  private readonly _q = new THREE.Quaternion();
  private readonly _p = new THREE.Vector3();
  private readonly _v = { x: 0, y: 0, z: 0 };
  private readonly craftKeys = new WeakMap<object, string>();
  private craftSerial = 0;

  /** Forget what was sent (a new TV joined): the next frame carries everything. */
  resync(): void {
    this.sentCraft = '';
    this.sentChunks = -1;
  }

  build(sim: Simulation, t: Telemetry, extra: { alpha: number; nav: string | null; notes: string[]; ui: string[]; bitLight: string }): TvFrame {
    const pal: string[] = [];
    const palIndex = new Map<string, number>();
    const col = (c: string) => {
      let i = palIndex.get(c);
      if (i === undefined) {
        i = pal.length;
        pal.push(c);
        palIndex.set(c, i);
      }
      return i;
    };
    const now = sim.time;
    const a = Math.max(0, Math.min(1, extra.alpha));
    const p = this._p.lerpVectors(sim.prevPosition, sim.position, a);
    const q = this._q.slerpQuaternions(sim.prevRotation, sim.rotation, a);
    const px = sim.walker.active ? sim.walker.x : p.x, pz = sim.walker.active ? sim.walker.z : p.z;
    const R2 = FRAME_RANGE * FRAME_RANGE;
    /** Bring a world x/z next to the player (wrap-aware); null when out of range. */
    const near = (x: number, z: number, range2 = R2): { x: number; z: number; d2: number } | null => {
      const dx = wrapDelta(px, x), dz = wrapDelta(pz, z);
      const d2 = dx * dx + dz * dz;
      return d2 > range2 ? null : { x: px + dx, z: pz + dz, d2 };
    };
    /** Keep the `cap` nearest rows of a stride-`k` list built with distances. */
    const nearest = (rows: Array<{ d2: number; v: number[] }>, cap: number): number[] => {
      if (rows.length > cap) rows.sort((x, y) => x.d2 - y.d2).length = cap;
      const out: number[] = [];
      for (const r of rows) out.push(...r.v);
      return out;
    };

    // The craft: a key per craft object (a new craft, or one rebuilt on reset).
    let key = this.craftKeys.get(sim.craft);
    if (!key) {
      key = `c${++this.craftSerial}`;
      this.craftKeys.set(sim.craft, key);
    }
    let craft: CraftShape | undefined;
    if (key !== this.sentCraft || now - this.sentCraftAt > this.resendEvery || now < this.sentCraftAt) {
      craft = craftShape(sim.craft.def, key, sim.craft.boundingRadius());
      this.sentCraft = key;
      this.sentCraftAt = now;
    }

    // Road traffic and its jetwalls.
    const riders: Array<{ d2: number; v: number[] }> = [];
    const walls: Array<{ d2: number; v: number[] }> = [];
    const HX = [1, 0, -1, 0], HZ = [0, 1, 0, -1];
    for (const r of sim.traffic.riders) {
      const at = near(r.x, r.z);
      if (!at) continue;
      const c = col(r.hackColor ?? TRAFFIC.colors[r.team]);
      const fade = r.derezAt === null ? 1 : Math.max(0, 1 - (now - r.derezAt) / 1.2);
      const yaw = Math.atan2(-HX[r.heading], -HZ[r.heading]);
      riders.push({ d2: at.d2, v: [r1(at.x), r1(at.z), r2(yaw), c, r2(fade)] });
      if (fade <= 0.01 || at.d2 > 600 * 600) continue;
      const pts = [...r.trail, sim.traffic.tail(r)];
      let arc = 0;
      for (let k = pts.length - 1; k >= 1; k--) {
        const s0 = pts[k - 1], s1 = pts[k];
        const len = Math.hypot(s1.x - s0.x, s1.z - s0.z);
        if (len < 0.05) continue;
        const k1 = Math.max(0, 1 - arc / TRAFFIC.trailLength);
        arc += len;
        if (k1 <= 0) break;
        const b = near(s0.x, s0.z)!, e = near(s1.x, s1.z)!;
        walls.push({ d2: at.d2, v: [r1(b.x), r1(b.z), r1(e.x), r1(e.z), 0, TRAFFIC.trailHeight, c, r2(k1 * fade)] });
      }
    }
    // Light walls and ribbons (the player's, AI's): segments merged to about 6 m.
    for (const tr of sim.trails.trails) {
      const pts = tr.points;
      if (pts.length < 2) continue;
      const c = col(tr.color);
      const fade = tr.derezAt === null ? 1 : Math.max(0, 1 - (now - tr.derezAt) / 1.5);
      if (fade <= 0) continue;
      let i0 = 0;
      for (let i = 1; i < pts.length; i++) {
        const s0 = pts[i0], s1 = pts[i];
        const last = i === pts.length - 1;
        if (!last && Math.hypot(s1.x - s0.x, s1.z - s0.z) < 6) continue;
        i0 = i;
        const b = near(s0.x, s0.z), e = near(s1.x, s1.z);
        if (!b || !e) continue;
        // Ribbons fade along their length (older points first).
        const age = tr.kind === 'wall' ? 0 : Math.max(0, now - s1.time);
        const alpha = fade * (tr.kind === 'wall' ? 1 : Math.max(0.15, 1 - age / 12));
        walls.push({ d2: Math.min(b.d2, e.d2), v: [r1(b.x), r1(b.z), r1(e.x), r1(e.z), r1(Math.min(s0.y0, s1.y0)), r1(Math.max(s0.y1, s1.y1)), c, r2(alpha)] });
      }
    }

    // Aircraft.
    const flyers: Array<{ d2: number; v: number[] }> = [];
    for (const f of sim.airTraffic.flyers) {
      if (f.derezAt !== null) continue;
      const at = near(f.pos.x, f.pos.z);
      if (!at) continue;
      const foe = f.side !== null && f.side !== undefined && hostile(sim.team, f.side);
      const flags = (foe ? 1 : 0) | (f.combat && f.combat !== 'patrol' ? 2 : 0);
      flyers.push({ d2: at.d2, v: [r1(at.x), r1(f.pos.y), r1(at.z), r2(f.heading), r2(f.pitch), r2(f.bank), col(f.color), 6, flags] });
    }

    // People: the Bits and the street programs.
    const bits: Array<{ d2: number; v: number[] }> = [];
    const B2 = 320 * 320;
    for (const person of sim.bits.people) {
      const at = near(person.x, person.z, B2);
      if (!at) continue;
      const style = person.genome.style;
      const state = sim.bits.stateOf(person, now);
      const si = BIT_STATES.indexOf(state);
      const answering = state === 'yes' || state === 'no';
      const c = answering ? BIT_LOOK[state].color : STYLE_LIGHT[style.light];
      bits.push({ d2: at.d2, v: [r1(at.x), r2(person.y), r1(at.z), r2(person.yaw), si, col(c), r2(BIT_LOOK[state].radius * STYLE_SIZE[style.size])] });
    }
    const progs: Array<{ d2: number; v: number[] }> = [];
    for (const g of sim.programs.people) {
      const at = near(g.x, g.z, B2);
      if (!at) continue;
      const answered = g.answer && now - g.answeredAt < 2 ? (g.answer === 'yes' ? 1 : 2) : 0;
      const light = g.side === 'merc' ? '#3d7cff' : sideLight(g.side);
      progs.push({ d2: at.d2, v: [r1(at.x), r2(g.y), r1(at.z), r2(g.yaw), answered, col(light)] });
    }

    // Tower turrets.
    const turrets: Array<{ d2: number; v: number[] }> = [];
    for (const tu of sim.groundTurrets.live()) {
      const at = near(tu.pos.x, tu.pos.z);
      if (!at) continue;
      turrets.push({ d2: at.d2, v: [r1(at.x), r1(tu.pos.y), r1(at.z), col(tu.color), tu.state === 'firing' || tu.state === 'charging' ? 1 : 0] });
    }

    // Weapons in flight.
    const shots: Array<{ d2: number; v: number[] }> = [];
    for (const w of sim.allWeapons()) for (const pr of w.projectiles) {
      const at = near(pr.pos.x, pr.pos.z);
      if (!at) continue;
      shots.push({ d2: at.d2, v: [r1(at.x), r1(pr.pos.y), r1(at.z), r1(pr.vel.x), r1(pr.vel.y), r1(pr.vel.z), col(pr.color)] });
    }

    // Explosions and strategic blasts (expanding rings), craters.
    const booms: Array<{ d2: number; v: number[] }> = [];
    for (const e of sim.explosions) {
      const age = now - e.time;
      if (age < 0 || age > 2.5) continue;
      const at = near(e.x, e.z, 3000 * 3000);
      if (at) booms.push({ d2: at.d2, v: [r1(at.x), r1(e.y), r1(at.z), r2(age), r1(e.radius), col(e.color ?? '#ff9a3c')] });
    }
    for (const b of sim.blasts) {
      const age = now - b.time;
      if (age < 0 || age > 8) continue;
      const at = near(b.x, b.z, 9000 * 9000);
      if (at) booms.push({ d2: 0, v: [r1(at.x), r1(b.y), r1(at.z), r2(age), b.kind === 'nuke' ? 900 : 400, col(b.kind === 'nuke' ? '#fff3d6' : '#7fe8ff')] });
    }
    const craters: Array<{ d2: number; v: number[] }> = [];
    for (const c of sim.craters) {
      const at = near(c.x, c.z);
      if (at) craters.push({ d2: at.d2, v: [r1(at.x), r1(at.z), r1(c.radius), col(c.color)] });
    }

    // Broken structures: the blocks still standing.
    const broken: number[] = [];
    const blocks: Array<{ d2: number; v: number[] }> = [];
    const groups = sim.staticWorld.structures.groups;
    for (const [g, building] of sim.staticWorld.fractured) {
      broken.push(g);
      const c = col(groups[g]?.color ?? '#36e2ff');
      for (const b of building.list) {
        if (!b.alive || !b.collider) continue;
        const w = building.worldCentre(b, this._v);
        const at = near(w.x, w.z);
        if (at) blocks.push({ d2: at.d2, v: [r1(at.x), r1(w.y), r1(at.z), r2(building.blockSize), c] });
      }
    }

    // Planet chunks, in registration order (the TV plans the same structures from them).
    const nchunks = sim.staticWorld.outerChunks.size;
    let chunks: number[] | undefined;
    if (nchunks !== this.sentChunks || now - this.sentChunksAt > this.resendEvery || now < this.sentChunksAt) {
      chunks = [];
      for (const c of sim.staticWorld.outerChunks.values()) chunks.push(c.ci, c.cj, c.ox, c.oz); // offsets exactly: whole planet turns
      this.sentChunks = nchunks;
      this.sentChunksAt = now;
    }

    const ammo = sim.weapons.ammo();
    const kinds = Object.keys(ammo) as Array<keyof typeof ammo>;
    let hostiles = 0;
    for (const f of sim.airTraffic.hostileFlyers()) if (f.pos.distanceTo(sim.position) < 6000) hostiles++;
    const hud: TvHud = {
      spd: r1(t.onGround || sim.walker.active ? t.groundSpeed : t.airspeed),
      spdLabel: t.onGround ? 'SPEED' : 'AIRSPEED',
      alt: r1(t.altitude),
      vs: r1(t.verticalSpeed),
      hdg: Math.round(t.heading),
      pitch: r1(t.pitch),
      roll: r1(t.roll),
      thr: r2(t.throttle),
      fuel: t.fuel === null ? null : r2(t.fuel),
      mach: r2(t.mach ?? 0),
      g: r2(t.gForce),
      stall: r2(t.stall),
      gnd: t.onGround,
      profile: 'airplane',
      nav: extra.nav,
      weapons: kinds.length ? kinds.map((k) => `${k.slice(0, 3).toUpperCase()} ${ammo[k]}`).join(' ') : null,
      hostiles,
      underFire: now - sim.lastHitAt < 2,
      credits: Math.round(sim.credits),
      team: TEAMS[sim.team].light,
    };

    this.n++;
    return {
      v: FRAME_VERSION,
      t: r2(now),
      n: this.n,
      me: {
        p: [r2(p.x), r2(p.y), r2(p.z)],
        q: [r2(q.x), r2(q.y), r2(q.z), r2(q.w)].map((v) => Math.round(v * 1000) / 1000) as [number, number, number, number],
        vel: [r1(t.velocity[0]), r1(t.velocity[1]), r1(t.velocity[2])],
        foot: sim.walker.active ? [r2(sim.walker.x), r2(sim.walker.y), r2(sim.walker.z), r2(sim.walker.yaw)] : null,
        dead: sim.exploded,
        craft: key,
        bit: extra.bitLight,
      },
      ...(craft ? { craft } : {}),
      hide: [...sim.craft.detached],
      hud,
      pal,
      riders: nearest(riders, CAP.rider),
      walls: nearest(walls, CAP.wall),
      flyers: nearest(flyers, CAP.flyer),
      bits: nearest(bits, CAP.bit),
      progs: nearest(progs, CAP.prog),
      turrets: nearest(turrets, CAP.turret),
      shots: nearest(shots, CAP.shot),
      booms: nearest(booms, CAP.boom),
      craters: nearest(craters, CAP.crater),
      blocks: nearest(blocks, CAP.block),
      broken,
      ...(chunks ? { chunks } : {}),
      nchunks,
      notes: extra.notes,
      ui: extra.ui,
    };
  }
}
