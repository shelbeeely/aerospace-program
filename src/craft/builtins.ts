import { JET } from './jet.ts';
import { LIGHT_CAR } from './lightCar.ts';
import { LIGHT_CYCLE } from './lightCycle.ts';
import { LIGHT_CRAWLER, LIGHT_RUNNER, LIGHT_SNOWMOBILE, OUTLANDS_CYCLE } from './outlands.ts';
import { TANK } from './tank.ts';
import { ORBITER } from './orbiter.ts';
import { TEST_PLANE } from './testPlane.ts';
import { TWIN_PLANE } from './twinPlane.ts';
import type { CraftDef, ModuleDef, RotorDef } from './types.ts';

/**
 * Built-in craft, one per vehicle family. Same JSON format the Designer generates and the
 * hangar saves. They double as reference designs in the Designer's prompt.
 */

/** Helium blimp: ~1% heavier than air, pendulum-stable (gas high, gondola low), twin pods. */
export const BLIMP: CraftDef = {
  name: 'Skyship B-1',
  formatVersion: 1,
  parts: [
    {
      id: 'envelope',
      kind: 'envelope',
      mass: 160,
      position: [0, 5, 0],
      shape: { type: 'cylinder', radius: 3.4, length: 22, axis: 'z' },
      color: '#d9dbe3',
      strength: 0,
      modules: [
        { type: 'buoyancy', volume: 560, gas: 'helium' },
        { type: 'drag', cdA: 1.6 },
        // The hull makes lift at an angle of attack (a very low aspect ratio "wing") that acts
        // well forward of its centre: the destabilising Munk moment the fins have to fight.
        { type: 'aero', offset: [0, 0, -4], span: 6.8, chord: 22, aspectRatio: 0.6, cd0: 0.0 },
      ],
    },
    {
      // Same hull, sideways: side force in a yaw, also acting forward. A tiny massless-ish carrier
      // part because a module takes its orientation from its part.
      id: 'hull.side',
      kind: 'envelope.aero',
      mass: 0.01,
      position: [0, 5, -4],
      rotationDeg: [0, 0, 90],
      shape: { type: 'box', size: [0.05, 0.05, 0.05] },
      color: '#d9dbe3',
      collider: false,
      strength: 0,
      modules: [{ type: 'aero', span: 6.8, chord: 22, aspectRatio: 0.6, cd0: 0.0 }],
    },
    {
      id: 'gondola',
      kind: 'cabin',
      mass: 288,
      position: [0, 0.9, -1.0], // under the centre of buoyancy, so it floats level
      shape: { type: 'box', size: [2, 1.4, 6] },
      color: '#3d4f66',
      modules: [
        { type: 'drag', cdA: 0.6 },
        { type: 'fuel', capacity: 25 },
        { type: 'wheel', offset: [0, -0.6, -2], radius: 0.25, restLength: 0.3, stiffness: 3000, damping: 400, brakes: true },
        { type: 'wheel', offset: [0, -0.6, 2], radius: 0.25, restLength: 0.3, stiffness: 3000, damping: 400, maxSteerDeg: 20 },
      ],
    },
    {
      id: 'pod.left',
      kind: 'engine.prop',
      mass: 40,
      position: [-1.7, 1.2, -1.0],
      shape: { type: 'box', size: [0.5, 0.5, 0.9] },
      color: '#c94f3d',
      modules: [{ type: 'engine', offset: [0, 0, -0.5], maxThrust: 350, propMaxSpeed: 30, propRadius: 0.7, propDirection: 1 }],
    },
    {
      id: 'pod.right',
      kind: 'engine.prop',
      mass: 40,
      position: [1.7, 1.2, -1.0],
      shape: { type: 'box', size: [0.5, 0.5, 0.9] },
      color: '#c94f3d',
      // Counter-rotating so the two torques cancel.
      modules: [{ type: 'engine', offset: [0, 0, -0.5], maxThrust: 350, propMaxSpeed: 30, propRadius: 0.7, propDirection: -1 }],
    },
    {
      id: 'fin.left',
      kind: 'tail.horizontal',
      mass: 12,
      position: [-4.6, 5, 9.6],
      shape: { type: 'box', size: [2.6, 0.12, 2.2] },
      color: '#c94f3d',
      modules: [{ type: 'aero', span: 2.6, chord: 2.2, aspectRatio: 2.5, control: { channel: 'pitch', maxDeflectionDeg: 25, gain: -1, chordFraction: 0.4 } }],
    },
    {
      id: 'fin.right',
      kind: 'tail.horizontal',
      mass: 12,
      position: [4.6, 5, 9.6],
      shape: { type: 'box', size: [2.6, 0.12, 2.2] },
      color: '#c94f3d',
      modules: [{ type: 'aero', span: 2.6, chord: 2.2, aspectRatio: 2.5, control: { channel: 'pitch', maxDeflectionDeg: 25, gain: -1, chordFraction: 0.4 } }],
    },
    {
      id: 'fin.top',
      kind: 'tail.vertical',
      mass: 12,
      position: [0, 9.6, 9.6],
      rotationDeg: [0, 0, 90],
      shape: { type: 'box', size: [2.6, 0.12, 2.2] },
      color: '#c94f3d',
      modules: [{ type: 'aero', span: 2.6, chord: 2.2, aspectRatio: 2.5, control: { channel: 'yaw', maxDeflectionDeg: 25, gain: 1, chordFraction: 0.4 } }],
    },
    {
      id: 'fin.bottom',
      kind: 'tail.vertical',
      mass: 8,
      position: [0, 2.6, 9.4],
      rotationDeg: [0, 0, 90],
      shape: { type: 'box', size: [1.6, 0.12, 1.8] },
      color: '#c94f3d',
      modules: [{ type: 'aero', span: 1.6, chord: 1.8, aspectRatio: 2.5, control: { channel: 'yaw', maxDeflectionDeg: 25, gain: 1, chordFraction: 0.4 } }],
    },
  ],
};

const quadRotor = (spin: 1 | -1): RotorDef => ({
    type: 'rotor',
    offset: [0, 0.08, 0],
    radius: 0.38,
    blades: 2,
    chord: 0.05,
    maxRpm: 4500,
    mode: 'rpm',
    pitchDeg: 12,
    twistDeg: -10,
  spin,
});

/**
 * Heavy-lift outrunner on a 12S pack: 130 rpm/V (no-load ~5800 rpm at 44 V, so 4500 rpm with
 * margin), 50 mΩ, 120 A ESC. Hover ≈ 26 A per motor, full thrust ≈ 70 A.
 */
const quadMotor: ModuleDef = { type: 'motor', kv: 130, rWinding: 0.05, maxCurrent: 120 };

/** 25 kg heavy-lift quadcopter (X layout). Unflyable without its flight controller, as in reality. */
export const QUADCOPTER: CraftDef = {
  name: 'Lifter Q-4',
  formatVersion: 1,
  parts: [
    {
      id: 'body',
      kind: 'drone.body',
      mass: 12,
      position: [0, 0.4, 0],
      shape: { type: 'box', size: [0.5, 0.2, 0.5] },
      color: '#2b2f36',
      modules: [
        { type: 'flightController', mode: 'multirotor', maxTiltDeg: 30, maxYawRateDeg: 120 },
        { type: 'drag', cdA: 0.08 },
        // 12S 16 Ah LiPo (~710 Wh, ~4.5 kg, part of the body's mass): ~15 min hover.
        { type: 'battery', cells: 12, capacityAh: 16, cellResistance: 0.0025, cellVmax: 4.2, cellVmin: 3.3, thermalMass: 4500, maxTempC: 70 },
        // Flight computer, GPS, radio and ESC logic.
        { type: 'avionics', loadW: 40, essential: true },
      ],
    },
    { id: 'arm.a', kind: 'drone.arm', mass: 1, position: [0, 0.45, 0], rotationDeg: [0, 45, 0], shape: { type: 'box', size: [1.75, 0.05, 0.08] }, color: '#555b66', collider: false },
    { id: 'arm.b', kind: 'drone.arm', mass: 1, position: [0, 0.45, 0], rotationDeg: [0, -45, 0], shape: { type: 'box', size: [1.75, 0.05, 0.08] }, color: '#555b66', collider: false },
    // Diagonal pairs spin the same way; yaw comes from speeding up one pair.
    { id: 'motor.fl', kind: 'drone.motor', mass: 2.5, position: [-0.62, 0.5, -0.62], shape: { type: 'cylinder', radius: 0.06, length: 0.1 }, color: '#c94f3d', modules: [quadRotor(1), quadMotor] },
    { id: 'motor.fr', kind: 'drone.motor', mass: 2.5, position: [0.62, 0.5, -0.62], shape: { type: 'cylinder', radius: 0.06, length: 0.1 }, color: '#c94f3d', modules: [quadRotor(-1), quadMotor] },
    { id: 'motor.rl', kind: 'drone.motor', mass: 2.5, position: [-0.62, 0.5, 0.62], shape: { type: 'cylinder', radius: 0.06, length: 0.1 }, color: '#e8e4da', modules: [quadRotor(-1), quadMotor] },
    { id: 'motor.rr', kind: 'drone.motor', mass: 2.5, position: [0.62, 0.5, 0.62], shape: { type: 'cylinder', radius: 0.06, length: 0.1 }, color: '#e8e4da', modules: [quadRotor(1), quadMotor] },
    { id: 'skid.left', kind: 'skid', mass: 0.5, position: [-0.3, 0.03, 0], shape: { type: 'box', size: [0.05, 0.05, 0.8] }, color: '#222222' },
    { id: 'skid.right', kind: 'skid', mass: 0.5, position: [0.3, 0.03, 0], shape: { type: 'box', size: [0.05, 0.05, 0.8] }, color: '#222222' },
  ],
};

/** Light two-seat helicopter: collective/cyclic main rotor, tail rotor, stability augmentation. */
export const HELICOPTER: CraftDef = {
  name: 'Kestrel H-2',
  formatVersion: 1,
  parts: [
    {
      id: 'cabin',
      kind: 'cabin',
      mass: 380,
      position: [0, 1.4, 0],
      shape: { type: 'sphere', radius: 1.1 },
      color: '#2f6fb3',
      modules: [
        { type: 'flightController', mode: 'helicopter', maxYawRateDeg: 60 },
        { type: 'drag', cdA: 0.9 },
      ],
    },
    {
      id: 'engine',
      kind: 'engine.turbine',
      mass: 150,
      position: [0, 2.1, 0.2],
      shape: { type: 'box', size: [0.8, 0.6, 1.2] },
      color: '#8a929c',
      modules: [{ type: 'fuel', capacity: 40 }],
    },
    {
      id: 'mast',
      kind: 'rotor.mast',
      mass: 20,
      position: [0, 2.7, 0.36], // directly over the centre of mass
      shape: { type: 'box', size: [0.2, 0.6, 0.2] },
      color: '#555b66',
      modules: [
        {
          type: 'rotor',
          offset: [0, 0.35, 0],
          radius: 3.8,
          blades: 2,
          chord: 0.18,
          maxRpm: 510,
          mode: 'collective',
          pitchDeg: 18,
          minPitchDeg: -1,
          twistDeg: -8,
          spin: 1,
          cyclicDeg: 8,
        },
      ],
    },
    { id: 'boom', kind: 'tail.boom', mass: 30, position: [0, 1.9, 3.6], shape: { type: 'box', size: [0.25, 0.25, 4.5] }, color: '#2f6fb3', modules: [{ type: 'drag', cdA: 0.08 }] },
    {
      id: 'tailrotor',
      kind: 'rotor.tail',
      mass: 5,
      position: [0.18, 2.0, 6.0],
      rotationDeg: [0, 0, -90], // thrust axis points right (+X): cancels the main rotor's torque
      shape: { type: 'box', size: [0.2, 0.1, 0.2] },
      color: '#555b66',
      modules: [
        {
          type: 'rotor',
          radius: 0.6,
          blades: 2,
          chord: 0.1,
          maxRpm: 2600,
          mode: 'collective',
          pitchDeg: 20,
          minPitchDeg: -20,
          twistDeg: 0,
          spin: 1,
          inputs: { collective: 'yaw' },
        },
      ],
    },
    { id: 'stabilizer', kind: 'tail.horizontal', mass: 3, position: [0, 1.9, 5.5], shape: { type: 'box', size: [1.2, 0.05, 0.4] }, color: '#e8e4da', modules: [{ type: 'aero', span: 1.2, chord: 0.4 }] },
    { id: 'fin', kind: 'tail.vertical', mass: 3, position: [0, 2.3, 5.9], rotationDeg: [0, 0, 90], shape: { type: 'box', size: [0.8, 0.05, 0.5] }, color: '#e8e4da', modules: [{ type: 'aero', span: 0.8, chord: 0.5 }] },
    { id: 'skid.left', kind: 'skid', mass: 8, position: [-0.9, 0.05, 0.1], shape: { type: 'box', size: [0.08, 0.08, 2.4] }, color: '#333333' },
    { id: 'skid.right', kind: 'skid', mass: 8, position: [0.9, 0.05, 0.1], shape: { type: 'box', size: [0.08, 0.08, 2.4] }, color: '#333333' },
    { id: 'strut.front', kind: 'skid.strut', mass: 4, position: [0, 0.4, -0.5], shape: { type: 'box', size: [1.9, 0.06, 0.06] }, color: '#333333', collider: false },
    { id: 'strut.rear', kind: 'skid.strut', mass: 4, position: [0, 0.4, 0.7], shape: { type: 'box', size: [1.9, 0.06, 0.06] }, color: '#333333', collider: false },
  ],
};

export interface BuiltinCraft {
  id: string;
  label: string;
  craft: CraftDef;
  hint: string;
}

/**
 * The craft offered in the vehicle picker: single prop, twin prop, jet and quadcopter. Each
 * scores 100/100 on its test card in calm air and in the "moderate" weather preset (see
 * scripts/headless.ts). HELICOPTER and BLIMP stay exported as reference designs.
 */
export const BUILTINS: BuiltinCraft[] = [
  { id: 'trainer', label: 'Trainer T-1 (single prop)', craft: TEST_PLANE, hint: 'Z for full throttle, S to rotate at ~60 kt. "." lowers flaps a notch. Expect a left swing from prop torque.' },
  { id: 'twin', label: 'Twinstar B-2 (twin prop)', craft: TWIN_PLANE, hint: 'Counter-rotating props: no swing. Z for full throttle, rotate with S at ~85 kt.' },
  { id: 'jet', label: 'Hawkeye J-3 (jet trainer)', craft: JET, hint: 'Throttle above 95% lights the afterburner (thirsty). Rotate at ~145 kt; throttle back below 95% to cruise.' },
  { id: 'orbiter', label: 'Orbiter (rocket spaceplane)', craft: ORBITER, hint: 'Rocket: full thrust in vacuum, thirsty. Climb ~40°, ease the nose down above 8 km, circularise at the apoapsis (ORB row). RCS steers in thin air.' },
  { id: 'quad', label: 'Lifter Q-4 (quadcopter)', craft: QUADCOPTER, hint: 'Throttle 50% ≈ hover. W/S/A/D tilt, Q/E yaw.' },
  { id: 'cycle', label: 'Light Cycle', craft: LIGHT_CYCLE, hint: 'W to go, S to brake, A/D to steer. L: jetwall → light ribbon → off. Its trail derezzes with it.' },
  { id: 'car', label: 'Light Car', craft: LIGHT_CAR, hint: 'W to go, S to brake, A/D to steer the front wheels. L: jetwall → light ribbon → off.' },
  { id: 'tank', label: 'Program Tank', craft: TANK, hint: 'Heavy and tough. W to go, S to brake, A/D skid-steer (turns on the spot when stopped). L cycles its jetwall.' },
  { id: 'crawler', label: 'Light Crawler (Outlands)', craft: LIGHT_CRAWLER, hint: 'Six-wheel drive rock crawler on long-travel suspension: slow and sure among the Outlands rubble. W/S, A/D steer (the rear wheels counter-steer).' },
  { id: 'runner', label: 'Light Runner (Outlands)', craft: LIGHT_RUNNER, hint: 'Fast four-wheel drive on tall wheels: quick on Outlands highways, at home on ravine floors. W/S, A/D steer.' },
  { id: 'sled', label: 'Light Snowmobile (Outlands)', craft: LIGHT_SNOWMOBILE, hint: 'Two skis steer, a driven track pushes: light and nimble over loose rubble. W/S, A/D steer.' },
  { id: 'cycle-outlands', label: 'Light Cycle (Outlands)', craft: OUTLANDS_CYCLE, hint: 'The street cycle rebuilt for the wastelands: big wheels, long travel, two-wheel drive. The street Light Cycle is not built for rocky ground.' },
];
