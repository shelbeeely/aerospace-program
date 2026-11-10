/**
 * Ground vehicle checks: the light car and the program tank never get stuck on flat ground,
 * the tank skid-steers on the spot, every ground vehicle drives an Outlands highway, the
 * Outlands vehicles cross a rubble field without coming apart,
 * and craft spawn where they're told (runway thresholds, helipads at pad height, the nearest
 * street) and stay there through respawns and world resets. Run with `npm run ground`.
 */
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { TANK } from '../src/craft/tank.ts';
import { LIGHT_CYCLE } from '../src/craft/lightCycle.ts';
import { LIGHT_CRAWLER, LIGHT_RUNNER, LIGHT_SNOWMOBILE, OUTLANDS_CYCLE } from '../src/craft/outlands.ts';
import { QUADCOPTER } from '../src/craft/builtins.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { CraftDef } from '../src/craft/types.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { CITY, PLANET, wrapCoord } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { highwayDistance, OUTLANDS, TERRAIN, terrainHeight, wastelandAt } from '../src/sim/terrain.ts';
import { bigCellForms } from '../src/arch/DigitalTerrainGenerator.ts';
import { GroundPilot } from '../src/sim/vehicleTests.ts';
import { landingSite, landingSites } from '../src/world/landingSites.ts';
import { STREET_SITE } from '../src/world/spawnSites.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const run = (sim: Simulation, seconds: number, pilot: (t: ReturnType<Simulation['telemetry']>) => ControlInputs) => {
  let t = sim.telemetry();
  let worstRoll = 0;
  for (let i = 0; i < seconds * 120; i++) {
    sim.step(pilot(t));
    t = sim.telemetry();
    worstRoll = Math.max(worstRoll, Math.abs(t.roll), Math.abs(t.pitch) > 60 ? 90 : 0);
  }
  return { t, worstRoll };
};
const hold = (c: Partial<ControlInputs>) => () => ({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 0, ...c });
const r1 = (x: number) => x.toFixed(1);

const VEHICLES: Array<[string, CraftDef]> = [['light car', LIGHT_CAR], ['tank', TANK]];
const OUTLAND_VEHICLES: Array<[string, CraftDef]> = [['light crawler', LIGHT_CRAWLER], ['light runner', LIGHT_RUNNER], ['light snowmobile', LIGHT_SNOWMOBILE], ['outlands light cycle', OUTLANDS_CYCLE]];

// --- Flat ground: go, stop, go again; never stuck.
for (const [name, def] of VEHICLES) {
  const sim = new Simulation(def);
  run(sim, 2, hold({ brake: 1 }));
  let { t } = run(sim, 8, hold({ throttle: 1 }));
  check(t.groundSpeed > 15, `${name}: pulls away from rest on flat ground`, `${r1(t.groundSpeed)} m/s after 8 s`);
  ({ t } = run(sim, 10, hold({ brake: 1 })));
  check(t.groundSpeed < 0.5, `${name}: brakes to a stop`, `${r1(t.groundSpeed)} m/s`);
  ({ t } = run(sim, 6, hold({ throttle: 1, yaw: 0.4 })));
  check(t.groundSpeed > 8 && !sim.exploded, `${name}: drives off again turning`, `${r1(t.groundSpeed)} m/s`);
}

// --- Skid steering: the tank pivots on the spot; letting go stops the turn.
{
  const sim = new Simulation(TANK);
  run(sim, 2, hold({ brake: 1 }));
  const t0 = sim.telemetry();
  const { t } = run(sim, 4, hold({ yaw: 1 }));
  const turned = ((t.heading - t0.heading + 360) % 360);
  const moved = Math.hypot(t.position[0] - t0.position[0], t.position[2] - t0.position[2]);
  check(turned > 45 && turned < 180 && moved < 2, 'tank: full right yaw pivots it to the right on the spot', `${r1(turned)}° in 4 s, centre moved ${r1(moved)} m`);
  const h1 = sim.telemetry().heading;
  const after = run(sim, 2, hold({})).t;
  check(Math.abs(((after.heading - h1 + 540) % 360) - 180) < 8, 'tank: releasing yaw stops the pivot', `${r1(((after.heading - h1 + 540) % 360) - 180)}° more`);
  const left = run(sim, 3, hold({ yaw: -1 })).t;
  check(((after.heading - left.heading + 360) % 360) > 30, 'tank: left yaw pivots it back left');
  const car = new Simulation(LIGHT_CAR);
  run(car, 2, hold({ brake: 1 }));
  const c0 = car.telemetry().heading;
  const c1 = run(car, 3, hold({ yaw: 1 })).t.heading;
  check(Math.abs(((c1 - c0 + 540) % 360) - 180) < 1, 'light car: steering alone does not turn it in place (front steer, rear drive)');
}

// --- The Outlands: highways run clean through them; the Outlands vehicles cross rubble fields.
const C = PLANET.circumference;
/** Drive `def` from (x, z) along heading (0 north = -Z, 90 east = +X) for `dist` m at `speed`. */
function drive(def: CraftDef, x: number, z: number, heading: number, dist: number, speed: number) {
  const sim = new Simulation(def);
  sim.traffic.enabled = false;
  const yaw = (-heading * Math.PI) / 180;
  sim.craft.reset({ x, y: sim.craft.restingHeight() + 0.2, z } as never, { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) } as never);
  sim.staticWorld.stream(x, z, true);
  run(sim, 2, hold({ brake: 1 }));
  const pilot = new GroundPilot(heading, speed);
  let t = sim.telemetry();
  let worst = 0;
  const along = () => (t.position[0] - x) * Math.sin((heading * Math.PI) / 180) - (t.position[2] - z) * Math.cos((heading * Math.PI) / 180);
  for (let i = 0; i < (dist / speed + 40) * 120 && along() < dist; i++) {
    sim.step(pilot.sample(sim.dt, t));
    t = sim.telemetry();
    worst = Math.max(worst, Math.abs(t.roll));
    if (i % 120 === 0) sim.staticWorld.stream(t.position[0], t.position[2]);
  }
  return { done: along() >= dist, intact: !sim.exploded && sim.failures.length === 0 && worst < 60, worst, sim, t };
}
{
  // A highway corridor deep in the Outlands, buttes on both sides, 600 m of it.
  const big = C / TERRAIN.bigCells;
  let site: { x: number; z: number } | null = null;
  for (let j = 0; j < 370 && !site; j += OUTLANDS.highwayEvery) {
    const lx = wrapCoord(CITY.x0 + j * (C / 370));
    for (let z = -C / 2 + 2000; z < C / 2 - 2000 && !site; z += big) {
      if (wastelandAt(lx, z) < 0.9 || wastelandAt(lx, z + 600) < 0.9) continue;
      let walls = 0, clear = true;
      for (let d = 0; d <= 600; d += 5) {
        if (terrainHeight(lx, z + d) > 0 || terrainHeight(lx + 12, z + d) > 0 || terrainHeight(lx - 12, z + d) > 0) clear = false;
        if (terrainHeight(lx + 60, z + d) > 40 || terrainHeight(lx - 60, z + d) > 40) walls++;
      }
      if (clear && walls > 40) site = { x: lx, z };
    }
  }
  check(site !== null, 'found an Outlands highway between landform walls', site ? `x ${site.x.toFixed(0)}, z ${site.z.toFixed(0)}` : '');
  if (site) for (const [name, def] of [...VEHICLES, ['light cycle', LIGHT_CYCLE], ...OUTLAND_VEHICLES] as Array<[string, CraftDef]>) {
    // Lane on the right of the centre line, heading south (+Z).
    const r = drive(def, site.x - 3.5, site.z, 180, 550, 15);
    check(r.done && r.intact, `${name}: drives 550 m down an Outlands highway`, `done ${r.done}, max roll ${Math.round(r.worst)}°, ${r.sim.failures.length} parts lost`);
  }
}
{
  // A basin (no butte) deep in the Outlands, strewn with rubble: cross 250 m of it.
  const n = TERRAIN.bigCells, big = C / n, fine = C / TERRAIN.fineCells;
  let site: { x: number; z: number; rocks: number } | null = null;
  for (let i = 0; i < n && !site; i++) for (let j = 0; j < n && !site; j++) {
    const cx = (i + 0.5) * big, cz = (j + 0.5) * big;
    if (bigCellForms(i, j).length || wastelandAt(cx, cz) < 0.6) continue;
    const wz = wrapCoord(cz);
    if (Math.abs(wz) > C / 2 - 2000 || highwayDistance(cx, CITY.x0) < 60 || highwayDistance(cz, CITY.z0) < 160) continue;
    // Count shards the 3 m wide track runs over; the start must be on bare ground.
    const x = cx + fine / 2 + 1.5, rocks = new Set<string>(); // through rubble cell centres, not along their edges
    for (let d = -125; d <= 125; d += 1) if (terrainHeight(x, cz + d) > 0.3) rocks.add(`${Math.floor(x / fine)},${Math.floor((cz + d) / fine)}`);
    if (terrainHeight(x, cz + 125) === 0 && rocks.size >= 3) site = { x: wrapCoord(x), z: wz + 125, rocks: rocks.size };
  }
  check(site !== null, 'found a rubble basin in the Outlands', site ? `${site.rocks} rocks on a 250 m line at (${site.x.toFixed(0)}, ${site.z.toFixed(0)})` : '');
  if (site) {
    for (const [name, def] of OUTLAND_VEHICLES) {
      const r = drive(def, site.x, site.z, 0, 250, 9);
      check(r.done && r.intact, `${name}: crosses 250 m of Outlands rubble at 9 m/s in one piece`, `done ${r.done}, max roll ${Math.round(r.worst)}°, ${r.sim.failures.length} parts lost, exploded ${r.sim.exploded}`);
    }
    const street = drive(LIGHT_CYCLE, site.x, site.z, 0, 250, 9);
    console.log(`     advisory: the street light cycle over the same rubble: done ${street.done}, max roll ${Math.round(street.worst)}°, exploded ${street.sim.exploded}`);
  }
}

// --- Spawn anywhere.
const near = (a: number, b: number, tol: number) => Math.abs(a - b) < tol;
const settle = (sim: Simulation, s = 3) => run(sim, s, hold({ brake: 1 }));
{
  // Runways: from the + threshold, facing down the strip.
  const sim = new Simulation(TEST_PLANE);
  const north = landingSite('north')!;
  sim.spawnSite = north;
  sim.respawn();
  let { t, worstRoll } = settle(sim);
  check(near(t.position[2], north.z, 3) && near(t.position[0], north.x + north.length / 2 - 40, 5) && near(t.heading, 270, 2) && t.onGround && worstRoll < 10,
    'plane at North Field: on the east threshold, facing west down the strip', `(${t.position[0].toFixed(0)}, ${t.position[2].toFixed(0)}) heading ${t.heading}`);
  sim.spawnSite = landingSite('grid')!;
  sim.respawn();
  check(near(sim.position.z, 360, 1.5) && near(sim.telemetry().heading, 0, 0.5), 'Grid International site matches the classic runway spawn', `z ${r1(sim.position.z)}`);
  // A street choice with an aircraft: falls back to the runway.
  sim.spawnSite = STREET_SITE;
  sim.respawn();
  check(near(sim.position.z, 360, 1.5), 'a plane with "Nearest street" chosen still spawns on the runway');

  // Helipads: rooftop, at pad height.
  const roof = landingSites().find((s) => s.kind === 'helipad' && s.y > 50)!;
  const quad = new Simulation(QUADCOPTER);
  quad.spawnSite = roof;
  quad.respawn();
  ({ t } = run(quad, 3, hold({})));
  check(near(t.position[0], roof.x, 2) && near(t.position[2], roof.z, 2) && near(t.position[1], roof.y + quad.craft.restingHeight(), 1) && !quad.exploded,
    `quadcopter on ${roof.name}: sits on the roof`, `y ${r1(t.position[1])} (pad ${r1(roof.y)})`);
  // World reset keeps the choice.
  quad.resetToRunway();
  ({ t } = run(quad, 2, hold({})));
  check(near(t.position[0], roof.x, 2) && near(t.position[1], roof.y + quad.craft.restingHeight(), 1), 'a world reset keeps the spawn site');
}
for (const [name, def] of VEHICLES) {
  const sim = new Simulation(def);
  sim.traffic.enabled = false; // spawn placement checks, not traffic (riders would collide at random)
  const pad = landingSite('pad-apron')!;
  sim.spawnSite = pad;
  sim.respawn();
  let { t, worstRoll } = settle(sim);
  // Ground vehicles never start on a landing site: on the road nearest it instead (AGENTS.md §14).
  const fromPad = Math.hypot(t.position[0] - pad.x, t.position[2] - pad.z);
  check(fromPad > pad.width && fromPad < 700 && t.onGround && worstRoll < 10 && !sim.exploded, `${name}: chosen ${pad.name}, starts on the nearest road instead`, `${fromPad.toFixed(0)} m from the pad`);

  // Nearest street, from a few places around the Grid.
  for (const [x, z] of [[0, 360], [-1000, -300], [-3000, -1200], [1500, 3000], [4000, 0]]) {
    sim.spawnSite = null;
    sim.respawn();
    sim.craft.reset({ x, y: 50, z } as never, { x: 0, y: 0, z: 0, w: 1 } as never);
    sim.step(hold({})());
    sim.spawnSite = STREET_SITE;
    sim.respawn();
    const p0 = sim.telemetry().position;
    const pitch = CITY.block + CITY.street;
    // On a street: within its right-hand lane (the lane is 6 m off the centreline).
    const onLine = (v: number, o: number) => Math.abs(((v - o) % pitch + pitch * 1.5) % pitch - pitch / 2) < 8;
    ({ t, worstRoll } = settle(sim, 2));
    const pilot = new GroundPilot(t.heading, 12);
    const drove = run(sim, 5, (tt) => pilot.sample(sim.dt, tt));
    const dist = Math.hypot(drove.t.position[0] - p0[0], drove.t.position[2] - p0[2]);
    check((onLine(p0[0], CITY.x0) || onLine(p0[2], CITY.z0)) && t.onGround && worstRoll < 10 && !sim.exploded && sim.failures.length === 0 && dist > 25,
      `${name}: nearest street to (${x}, ${z}) is clear to drive`, `at (${p0[0].toFixed(0)}, ${p0[2].toFixed(0)}) heading ${t.heading}, drove ${dist.toFixed(0)} m`);
  }
}

if (failures) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('all ground vehicle checks passed');
