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

let failures = 0;
const check = (label: string, ok: boolean) => { console.log(`${ok ? 'PASS' : 'FAIL'} ${label}`); if (!ok) failures++; };
const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) < eps;
check('Rankine peak at core radius', close(tornadoTangentialSpeed(75, 75, 55), 55));
check('Rankine linear inside and inverse radius outside', close(tornadoTangentialSpeed(37.5, 75, 55), 27.5) && close(tornadoTangentialSpeed(150, 75, 55), 27.5) && close(tornadoTangentialSpeed(300, 75, 55), 13.75));
check('Rankine axis finite and calm tangentially', tornadoTangentialSpeed(0, 75, 55) === 0);
const vortex = { x: 0, z: 0, velocityX: 4, velocityZ: 0, coreRadius: 75, peakSpeed: 55, height: 900 };
const coreWind = tornadoWind(new THREE.Vector3(40, 0, 0), 10, vortex, new THREE.Vector3());
check('moving tornado path retains central updraft', close(coreWind.y, 22) && coreWind.x === 0 && coreWind.z === 0);
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
if(failures) process.exit(1);
console.log('all disaster checks passed');
