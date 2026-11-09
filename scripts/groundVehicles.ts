/**
 * Ground vehicle checks: the light car and the program tank never get stuck on flat ground,
 * the tank skid-steers on the spot, both cross a small Off-Grid solid without coming apart,
 * and craft spawn where they're told (runway thresholds, helipads at pad height, the nearest
 * street) and stay there through respawns and world resets. Run with `npm run ground`.
 */
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { TANK } from '../src/craft/tank.ts';
import { QUADCOPTER } from '../src/craft/builtins.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { CraftDef } from '../src/craft/types.ts';
import type { ControlInputs } from '../src/sim/controls.ts';
import { CITY, PLANET, wrapCoord } from '../src/sim/layout.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { solidCell, TERRAIN, terrainHeight } from '../src/sim/terrain.ts';
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

// --- Off-Grid: drive over a small geometric solid (a low pyramid or mesa on the small lattice).
{
  const C = PLANET.circumference;
  const n = TERRAIN.smallCells;
  const cell = C / n;
  let target: { cx: number; cz: number; H: number } | null = null;
  for (let ix = 0; ix < n && !target; ix++) for (let iz = 0; iz < n && !target; iz++) {
    const s = solidCell(ix, iz, n, 211);
    if (!s) continue;
    const H = s.height * 0.3 * TERRAIN.peak;
    if (H < 3 || H > 9) continue;
    // Flat approach and run-off along +Z/-Z (no big solid in the way): the small solid is all there is.
    let ok = true;
    for (let d = -cell * 1.5; d <= cell * 1.5 && ok; d += 4) {
      const h = terrainHeight(s.cx, s.cz + d);
      if (Math.abs(d) > cell * 0.5 && h > 0.01) ok = false;
      if (h > H + 0.01) ok = false;
    }
    // Keep the whole run inside the canonical square (no wrap mid-test).
    const wx = wrapCoord(s.cx), wz = wrapCoord(s.cz);
    if (ok && Math.abs(wz) < C / 2 - cell * 3) target = { cx: wx, cz: wz, H };
  }
  check(target !== null, 'found a small Off-Grid solid to cross', target ? `${r1(target.H)} m high at (${target.cx.toFixed(0)}, ${target.cz.toFixed(0)})` : '');
  if (target) {
    for (const [name, def] of VEHICLES) {
      const sim = new Simulation(def);
      // Start on the flat 1.2 cells south of the solid, facing north (-Z) across its apex.
      const start = { x: target.cx, z: target.cz + cell * 1.2 };
      const h = sim.craft.restingHeight();
      sim.craft.reset({ x: start.x, y: h + 0.2, z: start.z } as never, { x: 0, y: 0, z: 0, w: 1 } as never);
      sim.staticWorld.stream(start.x, start.z, true);
      run(sim, 2, hold({ brake: 1 }));
      const pilot = new GroundPilot(0, 12);
      let maxY = 0;
      let worst = 0;
      let t = sim.telemetry();
      for (let i = 0; i < 30 * 120 && t.position[2] > target.cz - cell * 0.8; i++) {
        sim.step(pilot.sample(sim.dt, t));
        t = sim.telemetry();
        maxY = Math.max(maxY, t.position[1]);
        worst = Math.max(worst, Math.abs(t.roll));
        if (i % 120 === 0) sim.staticWorld.stream(t.position[0], t.position[2]);
      }
      const crossed = t.position[2] < target.cz - cell * 0.8;
      check(crossed && !sim.exploded && sim.failures.length === 0 && worst < 50 && maxY > target.H * 0.5,
        `${name}: drives up and over the solid in one piece`,
        `crossed ${crossed}, climbed to ${r1(maxY)} m, max roll ${Math.round(worst)}°, ${sim.failures.length} parts lost, exploded ${sim.exploded}`);
    }
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
  check(near(t.position[0], pad.x, 3) && near(t.position[2], pad.z, 3) && t.onGround && worstRoll < 10 && !sim.exploded, `${name}: spawns on ${pad.name}`);

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
    const onLine = (v: number, o: number) => Math.abs(((v - o) % pitch + pitch * 1.5) % pitch - pitch / 2) < 1.5;
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
