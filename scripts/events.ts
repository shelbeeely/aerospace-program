/** Deterministic disaster model + actual Rapier ground-motion integration regressions. */
import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import { Atmosphere, calmWeather } from '../src/sim/atmosphere.ts';
import { neutralControls } from '../src/sim/controls.ts';
import { groundAcceleration, groundDisplacement } from '../src/sim/events/earthquake.ts';
import { hurricaneSpeed, surgeHeight } from '../src/sim/events/hurricane.ts';
import { tornadoTangentialSpeed, tornadoWind } from '../src/sim/events/tornado.ts';
import { WorldEvents } from '../src/sim/events/WorldEvents.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import { worldStructures } from '../src/world/structures.ts';

let failures = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
check('Rankine peak at core radius', close(tornadoTangentialSpeed(75, 75, 55), 55));
check('Rankine linear inside and inverse radius outside', close(tornadoTangentialSpeed(37.5, 75, 55), 27.5) && close(tornadoTangentialSpeed(150, 75, 55), 27.5) && close(tornadoTangentialSpeed(300, 75, 55), 13.75));
check('Rankine axis finite and calm tangentially', tornadoTangentialSpeed(0, 75, 55) === 0);
// The axis is wherever the scheduler has moved it (here 40 m along its path).
const vortex = { x: 40, z: 0, velocityX: 4, velocityZ: 0, coreRadius: 75, peakSpeed: 55, height: 900 };
const coreWind = tornadoWind(new THREE.Vector3(40, 0, 0), 10, vortex, new THREE.Vector3());
check('moving tornado path retains central updraft', close(coreWind.y, 55 * 0.7) && coreWind.x === 0 && coreWind.z === 0);
const nearGround = tornadoWind(new THREE.Vector3(40 + 150, 1, 0), 0, vortex, new THREE.Vector3());
const aloft = tornadoWind(new THREE.Vector3(40 + 150, 400, 0), 0, vortex, new THREE.Vector3());
check('surface inflow toward the core, about as strong as the swirl near the ground', nearGround.x < -0.85 * Math.abs(nearGround.z) && -aloft.x < 0.5 * Math.abs(aloft.z));
check('Holland eye calm, including tiny radius', hurricaneSpeed(0, 1200, 48) === 0 && hurricaneSpeed(1e-300, 1200, 48) === 0);
check('Holland maximum at Rmax', close(hurricaneSpeed(1200, 1200, 48), 48) && hurricaneSpeed(600, 1200, 48) < 48 && hurricaneSpeed(2400, 1200, 48) < 48);
check('surge bounded and starts at zero', surgeHeight(2500, 0) === 0 && close(surgeHeight(2500, 180), 3) && surgeHeight(0, 180) < 3);

const one = new WorldEvents(42);
const two = new WorldEvents(42);
for (const system of [one, two]) {
 system.schedule('tornado', 1); system.schedule('hurricane', 2); system.schedule('earthquake', 3);
}
let same = true;
let nonzero = false;
for (let i = 0; i < 1200; i++) {
 one.advance(1 / 120); two.advance(1 / 120);
 const point = new THREE.Vector3(-800, 80, -400);
 const a = one.addWind(point, new THREE.Vector3());
 const b = two.addWind(point, new THREE.Vector3());
 same &&= a.equals(b) && one.groundAcceleration().equals(two.groundAcceleration());
 nonzero ||= a.length() > 1;
}
check('same seed and schedule reproduce exact wind/quake traces', same && nonzero);
const different = new WorldEvents(43);different.schedule('tornado', 1);different.advance(10);
check('different seed changes the event trace', !different.addWind(new THREE.Vector3(-800, 80, -400), new THREE.Vector3()).equals(one.addWind(new THREE.Vector3(-800, 80, -400), new THREE.Vector3())));
const future = new WorldEvents(1);future.schedule('hurricane', 5, {duration: 4});future.advance(4);
check('future events have no effects', future.active.length === 0 && future.rainAt(1200, 0) === 0 && future.addWind(new THREE.Vector3(1, 0, 0), new THREE.Vector3()).length() === 0);
future.advance(6);check('expired events removed', future.active.length === 0 && future.surgeHeight(2500) === 0);
one.clear();check('clear removes every disaster effect', one.active.length === 0 && one.groundAcceleration().length() === 0 && one.surgeHeight(2500) === 0);
const cap = new WorldEvents(); for(let i=0;i<32;i++)cap.schedule('tornado',100);let rejected=false;try{cap.schedule('tornado',100)}catch{rejected=true}check('event count bounded',rejected);

const t = 8.123, h = 1e-4;
const finiteDifference = groundDisplacement(t+h,20,7).add(groundDisplacement(t-h,20,7)).addScaledVector(groundDisplacement(t,20,7),-2).divideScalar(h*h);
check('analytic quake acceleration matches second displacement derivative', finiteDifference.distanceTo(groundAcceleration(t,20,7)) < 1e-5);
check('quake starts and ends at rest', [0,20,30].every(age=>groundDisplacement(age,20,7).length() === 0 && groundAcceleration(age,20,7).length()===0));
const atm = new Atmosphere(calmWeather());
atm.events.trigger('hurricane',{x:0,z:0});atm.advance(5);
const rain = atm.precipitationAt(new THREE.Vector3(1200,0,0));
check('hurricane rain bands feed actual precipitation independently of preset', rain.rate>0 && rain.kind==='rain');
check('event wind feeds actual Atmosphere.windAt', atm.windAt(new THREE.Vector3(1200,0,0),0,new THREE.Vector3()).length()>40);
atm.restart();check('weather restart clears and rewinds scheduler',atm.events.time===0 && atm.events.active.length===0);
atm.windContributors.push((_p,_t,out)=>{out.y+=3});check('additive wind sources work',atm.windAt(new THREE.Vector3(),0,new THREE.Vector3()).y===3);

await initPhysics();
const sim = new Simulation(TEST_PLANE);
sim.atmosphere.events.trigger('earthquake',{duration:3});
let maxGround = 0;
let kinematic = false;
for(let i=0;i<360;i++) {
 sim.step(neutralControls());
 sim.world.forEachRigidBody(body=>{
  if(body.bodyType()===RAPIER.RigidBodyType.KinematicPositionBased){kinematic=true;maxGround=Math.max(maxGround,Math.abs(body.translation().y+5));}
 });
}
check('earthquake drives an actual kinematic ground body',kinematic && maxGround>0.001);
for(let i=0;i<5;i++)sim.step(neutralControls());
let stillMoving=false;sim.world.forEachRigidBody(body=>{if(body.isKinematic())stillMoving=true});
check('ground returns to fixed body after event, simulation finite',!stillMoving && Number.isFinite(sim.telemetry().altitude) && sim.explosionResets===0);
sim.atmosphere.events.trigger('earthquake');sim.step(neutralControls());sim.resetToRunway();
check('reset restores ground and clears events',sim.atmosphere.events.active.length===0 && sim.atmosphere.events.groundDisplacement().length()===0);
sim.world.free();

// ---------------------------------------------------------------- tornadoes: path and destruction
{
  // The path: it travels at its ground speed and winds rather than sliding on a straight line.
  const w = new WorldEvents(7);
  const e = w.trigger('tornado', { x: 0, z: 0, duration: 200 });
  const h0 = e.tornado.heading!;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < 150 * 20; i++) { w.advance(0.05); if (i % 20 === 0) pts.push([e.tornado.x, e.tornado.z]); }
  const travelled = pts.slice(1).reduce((d, p, i) => d + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
  const [ex, ez] = pts[pts.length - 1];
  const chord = Math.hypot(ex, ez);
  let lateral = 0;
  for (const [x, z] of pts) lateral = Math.max(lateral, Math.abs((x * ez - z * ex) / Math.max(1, chord)));
  console.log(`  track: ${travelled.toFixed(0)} m in 150 s, chord ${chord.toFixed(0)} m, widest swing ${lateral.toFixed(0)} m, heading ${((e.tornado.heading! - h0) * 180 / Math.PI).toFixed(0)} deg off its start`);
  check('a tornado travels its track at ~9 m/s (real ones: 10-20 m/s)', travelled > 150 * 7 && travelled < 150 * 11);
  check('and its path winds (not a ruler line)', lateral > 25 && chord < travelled * 0.995);
  check('the funnel and the wind move with it', (() => { const v = w.addWind(new THREE.Vector3(ex + 75, 5, ez), new THREE.Vector3()); return v.length() > 30; })());
}
{
  const sim = new Simulation(TEST_PLANE);
  // Open ground near the craft: a loose 300 kg piece (a wing, a rubble slab) 110 m from a
  // tornado that stands still, just outside its core.
  const c = sim.position.clone();
  const tx = c.x + 400, tz = c.z;
  const e = sim.atmosphere.events.trigger('tornado', { x: tx, z: tz, duration: 60, strength: 1.2 });
  e.tornado.speed = 0;
  const gy = 0;
  const loose = sim.world.createRigidBody(RAPIER.RigidBodyDesc.dynamic().setTranslation(tx + 110, gy + 0.5, tz));
  sim.world.createCollider(RAPIER.ColliderDesc.cuboid(1.2, 0.3, 1.2).setMass(300), loose);
  const r0 = 110;
  let rMin = r0, yMax = 0;
  for (let i = 0; i < 25 * 120; i++) {
    sim.step(neutralControls());
    const p = loose.translation();
    rMin = Math.min(rMin, Math.hypot(p.x - e.tornado.x, p.z - e.tornado.z));
    yMax = Math.max(yMax, p.y);
  }
  console.log(`  loose block: nearest ${rMin.toFixed(0)} m from the axis (from ${r0} m), up to ${yMax.toFixed(0)} m`);
  check('a tornado draws loose objects from outside its core into it', rMin < e.tornado.coreRadius);
  check('and lifts them into the funnel', yMax > 15);
  sim.world.free();
}
{
  // A structure in its path: the core tears through it and rubble goes up.
  const sim = new Simulation(TEST_PLANE);
  const ws = worldStructures();
  const c = sim.position.clone();
  let target: { x: number; z: number; id: number } | null = null;
  for (const g of ws.groups) {
    if (!g.name.startsWith('arch:') || g.name.startsWith('arch:infra:')) continue;
    const w = g.size[0] * g.blockSize, d = g.size[2] * g.blockSize, h = g.size[1] * g.blockSize;
    if (h < 12 || h > 70 || w > 70 || d > 70) continue;
    const x = g.x0 + w / 2, z = g.z0 + d / 2;
    if (Math.hypot(x - c.x, z - c.z) < 1500) { target = { x, z, id: g.id }; break; }
  }
  check('found a structure near the craft for the tornado test', !!target);
  if (target) {
    // The craft waits 250 m off, so the structure streams in; the tornado comes at it from 200 m.
    const b = sim.craft.body;
    b.setTranslation({ x: target.x, y: sim.position.y, z: target.z + 260 }, true);
    run0(sim, 1);
    const e = sim.atmosphere.events.trigger('tornado', { x: target.x - 200, z: target.z, duration: 90, strength: 1.2 });
    e.tornado.heading = 0; // +x, straight at it
    e.tornado.wander = 0;
    let yMax = 0;
    for (let i = 0; i < 40 * 120; i++) {
      sim.step(neutralControls());
      if (i % 30 === 0) sim.world.forEachRigidBody((r) => { if (r.isDynamic() && r !== sim.craft.body) yMax = Math.max(yMax, r.translation().y); });
    }
    const toll = sim.tornadoToll;
    console.log(`  path of destruction: ${toll.blocks} blocks torn out, ${sim.staticWorld.fractured.size} structure(s) broken, rubble up to ${yMax.toFixed(0)} m, ${toll.scars} scars`);
    check('the tornado tears through a structure in its path', sim.staticWorld.fractured.has(target.id) && toll.blocks >= 20);
    check('the rubble is taken up into the funnel', yMax > 25);
    check('it scours a scar along its track', toll.scars >= 5);
    sim.resetToRunway();
    check('a reset clears the tornado, its scars and its toll', sim.atmosphere.events.active.length === 0 && sim.tornadoToll.blocks === 0 && sim.craters.length === 0);
  }
  sim.world.free();
}
function run0(sim: Simulation, sec: number) { for (let i = 0, n = Math.round(sec / sim.dt); i < n; i++) sim.step(neutralControls()); }

if(failures) process.exit(1);
console.log('all disaster checks passed');
