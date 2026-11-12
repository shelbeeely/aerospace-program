/**
 * AI air traffic, headless. Run with `npm run air`.
 *
 * 1. The traffic keeps its count around the player, from the pool (ground vehicles never fly).
 * 2. Civil aircraft fly flights: off a stand, down a runway, across, round the pattern and
 *    down the slope onto another runway; rotorcraft from pad to pad.
 * 3. In the air they stay clear of terrain and structures; a runway carries one at a time; an
 *    aircraft goes around rather than land on a runway the player's craft is standing on.
 * 4. A gun hit derezzes one (flash and voxels), and the count is topped back up.
 */
import * as THREE from 'three';
import { BUILTINS } from '../src/craft/builtins.ts';
import { JET } from '../src/craft/jet.ts';
import { flyerKind, GROUND_PHASES, type AiFlyer } from '../src/sim/aiTraffic.ts';
import { runwayFrame, wrapCoord } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { terrainHeight } from '../src/sim/terrain.ts';
import { obstacleTop } from '../src/world/structures.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};
const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };

// The player's jet stands on Grid International's runway the whole time.
const sim = new Simulation(JET);
sim.traffic.enabled = false;
sim.airTraffic.pool = BUILTINS.map((b) => b.craft);
sim.airTraffic.count = 12;
let minClear = Infinity, worst = '';
let takeoffs = 0, landings = 0, padLandings = 0, badTouchdowns = 0, shared = 0, onGrid = 0, steep = 0, fastTaxi = 0, sunk = 0;
let touchdown = '';
const phases = new Map<number, string>();
const flown = new Set<number>();
const SECONDS = 900;
for (let i = 0; i < 120 * SECONDS; i++) {
  sim.step(idle);
  if (i % 30 !== 0) continue;
  const using = new Map<string, number>();
  for (const f of sim.airTraffic.flyers) {
    if (f.derezAt !== null) continue;
    const prev = phases.get(f.id);
    phases.set(f.id, f.phase);
    const grounded = GROUND_PHASES.has(f.phase);
    if (prev === 'takeoff' && f.phase === 'climb') takeoffs++;
    if (prev === 'descend' && f.phase === 'park') { padLandings++; flown.add(f.id); }
    if ((prev === 'final' || prev === 'approach') && f.phase === 'rollout') {
      // Down on the runway it was going to: inside the strip, along it.
      landings++;
      flown.add(f.id);
      const s = f.site!;
      const fr = runwayFrame(s, f.pos.x, f.pos.z);
      const ok = Math.abs(fr.across) < s.width / 2 && Math.abs(fr.along) < s.length / 2 && f.speed < f.vApp * 1.1;
      if (!ok) badTouchdowns++;
      if (s.id === 'grid') onGrid++;
      touchdown ||= `${f.name} on ${s.name} at ${f.speed.toFixed(0)} m/s, ${fr.across.toFixed(1)} m off the centreline`;
    }
    // One aircraft on a runway at a time (rolling for take-off, or down and still on it).
    if (f.kind === 'airplane' && (f.phase === 'takeoff' || f.phase === 'rollout')) {
      const s = (f.phase === 'takeoff' ? f.from : f.site)!;
      using.set(s.id, (using.get(s.id) ?? 0) + 1);
    }
    const ground = Math.max(terrainHeight(f.pos.x, f.pos.z), obstacleTop(f.pos.x, f.pos.z));
    if (grounded) {
      // On the ground it stands on it, and taxis at a taxi's pace.
      const s = (f.phase === 'rollout' || f.phase === 'vacate' ? f.site : f.from ?? f.site)!;
      if (Math.abs(f.pos.y - (s.y + f.gear)) > 0.2) sunk++;
      if ((f.phase === 'taxi' || f.phase === 'vacate' || f.phase === 'lineup') && f.speed > 16) fastTaxi++;
      continue;
    }
    if (Math.abs(f.pitch) > 0.5) steep++;
    // Clear of everything, except on the last of the approach and the first of the climb
    // (inside the runway's funnels) and straight above a pad.
    if (f.phase === 'final' || f.phase === 'descend' || f.phase === 'lift' || (f.phase === 'approach' && f.inbound) || (f.phase === 'climb' && f.pos.y < f.until)) continue;
    const nearPad = f.kind === 'rotorcraft' && f.site && Math.hypot(wrapCoord(f.site.x - f.pos.x), wrapCoord(f.site.z - f.pos.z)) < 400;
    if (nearPad) continue;
    if (f.pos.y - ground < minClear) {
      minClear = f.pos.y - ground;
      worst = `${f.name} ${f.phase} at ${f.pos.y.toFixed(0)} m over ${ground.toFixed(0)} m, ${f.speed.toFixed(0)} m/s, t=${sim.time.toFixed(0)}`;
    }
  }
  for (const n of using.values()) if (n > 1) shared++;
}
const flyers = sim.airTraffic.flyers.filter((f) => f.derezAt === null);
const goArounds = sim.airTraffic.flyers.reduce((n, f) => n + f.goArounds, 0);
check(flyers.length === 12, 'twelve AI aircraft fly around the player', flyers.map((f) => `${f.name} (${f.kind}, ${f.phase})`).join(', '));
check(!sim.airTraffic.flyers.some((f) => flyerKind(f.def) === 'ground'), 'ground vehicles in the pool never take to the air');
check(takeoffs >= 4, 'aeroplanes taxi out, line up and take off', `${takeoffs} take-offs in ${SECONDS / 60} minutes`);
check(landings >= 4 && badTouchdowns === 0, 'they fly the pattern and land on the runway they were going to', `${landings} landings, ${badTouchdowns} off the strip or too fast (first: ${touchdown})`);
check(padLandings >= 4, 'rotorcraft fly from pad to pad', `${padLandings} landings on pads`);
check(flown.size >= 5, 'different aircraft complete flights', `${flown.size} aircraft landed`);
check(minClear > 15, 'in the air they stay clear of the ground and the structures', `closest ${minClear.toFixed(0)} m: ${worst}`);
check(shared === 0, 'a runway carries one aircraft at a time', `${shared} samples with two on a runway`);
check(onGrid === 0 && goArounds > 0, 'nobody lands on the runway the player is standing on: they go around', `${goArounds} go-arounds, ${onGrid} landings on Grid International`);
check(sunk === 0 && fastTaxi === 0 && steep === 0, 'on the ground they stand on it and taxi slowly; in the air no wild attitudes', `${sunk} off the ground, ${fastTaxi} fast taxis, ${steep} steep`);
const speedsOk = flyers.every((f) => f.speed >= 0 && f.speed < 300 && (GROUND_PHASES.has(f.phase) || f.phase === 'lift' || f.phase === 'descend' || f.speed > 2));
check(speedsOk, 'each flies at a sensible speed for its kind');

// The same seed flies the same flights.
{
  const run = () => {
    const s2 = new Simulation(JET);
    s2.traffic.enabled = false;
    s2.airTraffic.pool = BUILTINS.map((b) => b.craft);
    s2.airTraffic.count = 8;
    for (let i = 0; i < 120 * 60; i++) s2.step(idle);
    return s2.airTraffic.flyers.map((f: AiFlyer) => `${f.name}:${f.phase}:${f.pos.x.toFixed(2)},${f.pos.y.toFixed(2)},${f.pos.z.toFixed(2)}`).join(';');
  };
  check(run() === run(), 'air traffic is deterministic');
}

// A gun hit derezzes one.
{
  const f = [...flyers].sort((a, b) => b.radius - a.radius)[0]; // the biggest: between the guns
  // Park it 150 m ahead of the jet, on the guns' line.
  sim.weapons.arm(JET, 'guns');
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(sim.rotation);
  const gunY = sim.weapons.mounts[0].offset.y;
  f.pos.copy(sim.position).addScaledVector(fwd, 150).add(new THREE.Vector3(0, gunY, 0));
  f.phase = 'wander';
  f.state = 'loiter';
  f.speed = 0;
  f.cruise = 0;
  f.altitude = f.pos.y;
  const before = sim.airTraffic.derezzed;
  for (let k = 0; k < 8; k++) {
    sim.step(idle);
    sim.fireWeapon('primary');
    for (let j = 0; j < 12; j++) sim.step(idle);
    f.pos.copy(sim.position).addScaledVector(fwd, 150).add(new THREE.Vector3(0, gunY, 0));
    if (sim.airTraffic.derezzed > before) break;
  }
  check(sim.airTraffic.derezzed > before && sim.explosions.some((e) => e.color === f.color), 'gunfire derezzes an AI aircraft in its circuit colour', `${sim.airTraffic.derezzed - before} derezzed`);
  for (let i = 0; i < 120 * 3; i++) sim.step(idle);
  check(sim.airTraffic.flyers.filter((x) => x.derezAt === null).length === 12, 'and a new one takes its place');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
