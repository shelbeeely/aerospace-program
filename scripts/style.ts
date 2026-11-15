/**
 * The enemy learns your style. Run with `npm run style`.
 *
 * 1. A pilot with a habit (breaks left when shot at, climbs with a missile on it) is learned:
 *    within two minutes of fighting the side predicts the break and the climb, its confidence
 *    rises, and it writes down what it saw ("Red has seen you break left 9 of 10 times").
 * 2. A pilot without habits (jinks at random, faster than the side can judge) is not:
 *    confidence stays near zero, so nothing that reads it changes.
 * 3. Leading into the predicted break: against the habitual pilot, a turret's aim point lands
 *    nearer where the pilot really is when the rounds arrive; against the random pilot the
 *    aim is unchanged.
 * 4. Kept between sessions: a model saved and loaded predicts the same.
 * 5. In the game: a pilot who breaks left when hit, making attack runs on a tower turret, is
 *    learned by that turret's side (moments, records), the turret leads into the break, and the
 *    same flight teaches the same thing.
 * 6. Seasons: four weeks from a fixed epoch, the same for everyone.
 */
import * as THREE from 'three';
import { seededRand } from '../src/people/genome.ts';
import { StyleModel, type StyleSituation } from '../src/brain/style.ts';
import { SEASON_DAYS, SEASON_EPOCH, seasonOf } from '../src/brain/season.ts';
import { JET } from '../src/craft/jet.ts';
import { lineOfSight, turretSites, TURRET_HEAD_Y, type TurretSite } from '../src/sim/groundTurrets.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { baseOwner } from '../src/sim/territory.ts';
import { allAtWar, type Team } from '../src/sim/teams.ts';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;

/** A pilot on a flat plane (x east, z south, heading clockwise from north) near a turret at the origin. */
interface Pilot { x: number; z: number; y: number; heading: number; speed: number; turn: number; climb: number; until: number }
type Habit = 'habit' | 'random';

/**
 * Fly `seconds` of a fight: the turret fires in bursts, sometimes with a missile. The habitual
 * pilot breaks left (and climbs with a missile on it) when the shooting starts, else cruises
 * with gentle turns; the random pilot turns and climbs at random, whatever happens.
 */
function fly(model: StyleModel, habit: Habit, seconds: number, seed: number, onStep?: (t: number, p: Pilot, s: StyleSituation) => void) {
  const rand = seededRand(seed);
  const p: Pilot = { x: 1400, z: 0, y: habit === 'random' ? 1500 : 400, heading: -Math.PI / 2, speed: 130, turn: 0, climb: 0, until: 0 };
  const dt = 1 / 30;
  let fireUntil = -1, nextBurst = 4, missileUntil = -1, prevHeading = p.heading, prevY = p.y;
  for (let t = 0; t < seconds; t += dt) {
    let started = false;
    if (t >= nextBurst) { fireUntil = t + 1.5; started = true; if (rand() < 0.4) missileUntil = t + 4; nextBurst = t + 6 + rand() * 6; }
    const underFire = t < fireUntil ? 1 : 0, missile = t < missileUntil ? 1 : 0;
    if (habit === 'habit') {
      if (started && rand() < 0.9) { p.turn = -0.45; p.climb = missile ? 14 : 0; p.until = t + 2.5; }
      else if (t >= p.until) { p.turn = (rand() - 0.5) * 0.12; p.climb = 0; p.until = t + 2 + rand() * 3; }
    } else if (t >= p.until) {
      // Jinking: a new turn and climb at random every half second or so, whatever is happening.
      p.turn = [-0.45, 0, 0.45][Math.floor(rand() * 3)]; p.climb = [14, 0, -14][Math.floor(rand() * 3)]; p.until = t + 0.3 + rand() * 0.6;
    }
    // Stay in the turret's reach: steer back gently when far.
    const r = Math.hypot(p.x, p.z);
    if (r > 2200 && t >= p.until - 0.01) { const back = Math.atan2(-p.x, p.z); p.turn = Math.sign(Math.atan2(Math.sin(back - p.heading), Math.cos(back - p.heading))) * 0.3; }
    p.heading += p.turn * dt;
    p.x += Math.sin(p.heading) * p.speed * dt;
    p.z -= Math.cos(p.heading) * p.speed * dt;
    p.y = Math.max(150, Math.min(3000, p.y + p.climb * dt));
    const toTurret = Math.atan2(-p.x, p.z);
    const s: StyleSituation = {
      bearing: Math.atan2(Math.sin(toTurret - p.heading), Math.cos(toTurret - p.heading)), aspect: 0, range: Math.hypot(p.x, p.z, p.y), speed: p.speed, agl: p.y,
      missile, underFire, hit: 0, turnRate: (p.heading - prevHeading) / dt, climbRate: (p.y - prevY) / dt,
    };
    prevHeading = p.heading; prevY = p.y;
    model.step(t, p.heading, p.y, s);
    onStep?.(t, p, s);
  }
  return p;
}

console.log('--- learning a habit, not learning noise');
const habitual = new StyleModel('Red', 7);
fly(habitual, 'habit', 120, 1);
const random = new StyleModel('Red', 7);
fly(random, 'random', 120, 2);
{
  // The moment the shooting starts (and a missile with it): what does the side expect?
  const shotAt: StyleSituation = { bearing: 1.2, aspect: 0, range: 1300, speed: 130, agl: 400, missile: 0, underFire: 1, hit: 0, turnRate: 0, climbRate: 0 };
  const missiled: StyleSituation = { ...shotAt, missile: 1 };
  const t0 = 1000;
  habitual.step(t0, 0, 400, missiled);
  const ph = habitual.predict(shotAt), pm = habitual.predict(missiled), c = habitual.confidence();
  check(ph.turn[0] > 0.8, 'two minutes in, the side predicts the habitual pilot breaks left under fire', `left ${pct(ph.turn[0])}`);
  check(pm.vertical[0] > 0.6, 'and climbs with a missile on it', `climb ${pct(pm.vertical[0])}`);
  check(c.turn > 0.3, 'and is confident of the turn', `turn skill ${c.turn.toFixed(2)}, vertical ${c.vertical.toFixed(2)}`);
  const rec = habitual.records.map((r) => r.text);
  check(rec.some((t) => /break left \d+ of \d+ times under fire/.test(t)), 'it writes down what it saw', rec.join(' / '));
  const cr = random.confidence();
  check(cr.turn < 0.15 && cr.vertical < 0.15, 'a pilot without habits leaves it unsure', `turn skill ${cr.turn.toFixed(2)}, vertical ${cr.vertical.toFixed(2)}`);
  check(habitual.retrained >= 30, 'it retrains as the fight goes on', `${habitual.retrained} times in two minutes`);
}

console.log('\n--- leading into the predicted break');
/** Mean miss (m) of an aim point at the moment the shooting starts, judged where the pilot is when the rounds arrive. */
function aimMiss(habit: Habit, lean: boolean): number {
  const m = new StyleModel('Red', 3);
  fly(m, habit, 120, habit === 'habit' ? 11 : 12); // learn first
  const GUN = 620;
  const shots: Array<{ t: number; aim: THREE.Vector3 }> = [];
  let miss = 0, n = 0, wasFire = false;
  fly(m, habit, 240, habit === 'habit' ? 13 : 14, (t, p, s) => {
    const pos = new THREE.Vector3(p.x, p.y, p.z);
    for (let i = shots.length - 1; i >= 0; i--) if (t >= shots[i].t) { miss += shots[i].aim.distanceTo(pos); n++; shots.splice(i, 1); }
    const start = s.underFire === 1 && !wasFire;
    wasFire = s.underFire === 1;
    if (!start) return;
    // Straight-line lead (what the turrets do), plus the side's expected acceleration.
    const vel = new THREE.Vector3(Math.sin(p.heading) * p.speed, 0, -Math.cos(p.heading) * p.speed);
    const tof = pos.length() / GUN;
    const aim = pos.clone().addScaledVector(vel, tof);
    if (lean) {
      const a = m.lean(s);
      const right = new THREE.Vector3(Math.cos(p.heading), 0, Math.sin(p.heading));
      aim.addScaledVector(right, 0.5 * a.lateral * tof * tof).add(new THREE.Vector3(0, 0.5 * a.vertical * tof * tof, 0));
    }
    shots.push({ t: t + tof, aim });
  });
  return miss / Math.max(1, n);
}
{
  const plainH = aimMiss('habit', false), leanH = aimMiss('habit', true);
  const plainR = aimMiss('random', false), leanR = aimMiss('random', true);
  check(leanH < plainH * 0.8, 'against the habitual pilot, leading into its break lands nearer', `${plainH.toFixed(1)} m → ${leanH.toFixed(1)} m`);
  check(Math.abs(leanR - plainR) < plainR * 0.1, 'against the random pilot, the aim is no worse', `${plainR.toFixed(1)} m → ${leanR.toFixed(1)} m`);
}

console.log('\n--- kept between sessions');
{
  const back = StyleModel.fromJSON(JSON.parse(JSON.stringify(habitual.toJSON())), 'Red', 7);
  // A moment between spells (the onset state of a fight in progress is not kept, only what was learned).
  const s: StyleSituation = { bearing: -0.8, aspect: 0, range: 900, speed: 130, agl: 300, missile: 0, underFire: 0, hit: 0, turnRate: 0.1, climbRate: 0 };
  const a = habitual.predict(s), b = back.predict(s);
  const same = a.turn.every((v, i) => Math.abs(v - b.turn[i]) < 1e-3) && a.vertical.every((v, i) => Math.abs(v - b.vertical[i]) < 1e-3) && Math.abs(a.turnConfidence - b.turnConfidence) < 1e-9;
  check(same && back.records.length === habitual.records.length, 'a saved and loaded side predicts the same and remembers what it saw');
}

console.log('\n--- in the game: a tower turret\'s side learns the pilot');
{
  await initPhysics();
  allAtWar();
  const sites: TurretSite[] = [];
  for (let ci = 0; ci < 6; ci++) for (let cj = 0; cj < 6; cj++) sites.push(...turretSites(ci, cj, 1));
  const site = sites.find((x) => x.y < 200)!;
  const head = new THREE.Vector3(site.x, site.y + TURRET_HEAD_Y, site.z);
  const idle = { pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 };
  // A line of approach with a clear view of the turret, from beyond its reach (2.5 km) to 800 m.
  const alt = head.y + 400;
  let bearing = 0;
  for (let k = 0; k < 32; k++) {
    const a = (k / 32) * Math.PI * 2;
    const at = (d: number) => new THREE.Vector3(head.x + Math.sin(a) * d, alt, head.z - Math.cos(a) * d);
    if ([800, 1400, 2000, 2600].every((d) => lineOfSight(head, at(d)))) { bearing = a; break; }
  }
  const far = new THREE.Vector3(head.x + Math.sin(bearing) * 3000, alt, head.z - Math.cos(bearing) * 3000);
  const near = new THREE.Vector3(head.x + Math.sin(bearing) * 800, alt, head.z - Math.cos(bearing) * 800);
  /**
   * Attack runs on one turret: in from 3 km to 800 m and back out, at 160 m/s, again and
   * again. With the habit, the pilot breaks left for 2.5 s whenever it is hit. The other
   * turrets are held dark, missiles are held and the craft is mended after each hit, so the gun
   * duel runs the whole time.
   */
  function flight(seconds: number, habit: boolean, lean: boolean) {
    const sim = new Simulation(JET);
    sim.traffic.enabled = false;
    sim.groundTurrets.density = 1;
    sim.setTeam((((baseOwner(site.ci, site.cj) ?? 0) + 1) % 3) as Team);
    sim.spawnGraceUntil = 0;
    sim.style.enabled = lean;
    const speed = 160, dt = 1 / 120;
    const p = far.clone();
    let heading = bearing + Math.PI, breakUntil = -1, breaks = 0, inbound = true, hits = 0;
    for (let i = 0; i < seconds * 120 && !sim.exploded; i++) {
      for (const x of sim.groundTurrets.turrets) {
        x.missileAt = sim.time;
        if (x.site.id !== site.id) x.disabledUntil = sim.time + 1;
      }
      for (const [id, max] of sim.damage.maxHp) sim.damage.hp.set(id, max);
      if (sim.hitsTaken > hits) {
        hits = sim.hitsTaken;
        if (habit && sim.time >= breakUntil) { breakUntil = sim.time + 2.5; breaks++; }
      }
      // Steer: in a break, hard left; else for the end of the run (turning round at each end).
      const goal = inbound ? near : far;
      if (Math.hypot(p.x - goal.x, p.z - goal.z) < 200) inbound = !inbound;
      let rate: number;
      if (sim.time < breakUntil) rate = -0.45;
      else {
        const want = Math.atan2(goal.x - p.x, -(goal.z - p.z));
        const err = Math.atan2(Math.sin(want - heading), Math.cos(want - heading));
        rate = Math.max(-0.5, Math.min(0.5, err * 1.2));
      }
      heading += rate * dt;
      const v = new THREE.Vector3(Math.sin(heading) * speed, 0, -Math.cos(heading) * speed);
      p.addScaledVector(v, dt);
      const b = sim.craft.body;
      const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -heading);
      b.setTranslation(p, true);
      b.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w }, true);
      b.setLinvel(v, true);
      b.setAngvel({ x: 0, y: 0, z: 0 }, true);
      sim.step(idle);
    }
    const tur = sim.groundTurrets.turrets.find((x) => x.site.id === site.id);
    return { sim, model: tur ? sim.style.models.get(tur.side) : undefined, breaks, hits: sim.hitsTaken };
  }
  const a = flight(240, true, true);
  const m = a.model;
  check(!!m && m.habits.moments > 100, 'the turret\'s side watches the pilot while it fights it', `${m?.habits.moments ?? 0} moments, ${a.breaks} breaks`);
  check(!!m && m.records.some((r) => /turn left \d+ of \d+ times when hit/.test(r.text)), 'and writes down the habit', m?.records.map((r) => r.text).join(' / ') ?? '');
  check(a.sim.groundTurrets.leaned > 0, 'the turret leads into the break it expects', `${a.sim.groundTurrets.leaned} aim solutions`);
  const b = flight(240, true, true);
  check(JSON.stringify(a.model?.toJSON()) === JSON.stringify(b.model?.toJSON()), 'the same flight teaches the same thing');
  const off = flight(240, true, false);
  check(a.hits >= Math.max(3, off.hits * 1.5), 'leading into the break, the turret hits the habitual pilot more often', `${off.hits} hits leading straight, ${a.hits} leading into its break, in 240 s`);
}

console.log('\n--- seasons');
{
  const s1 = seasonOf(SEASON_EPOCH), mid = seasonOf(SEASON_EPOCH + 40 * 86_400_000);
  check(s1.id === 1 && s1.day === 1 && mid.id === 2 && mid.day === 13 && mid.endsAt - mid.startsAt === SEASON_DAYS * 86_400_000, 'four-week seasons from a fixed epoch', `day 41 is season ${mid.id} day ${mid.day}`);
}

console.log(failures ? `\n${failures} FAILED` : '\nAll style checks passed');
if (failures) process.exit(1);
