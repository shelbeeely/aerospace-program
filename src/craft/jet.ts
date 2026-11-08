import type { CraftDef, PartDef } from './types.ts';

/**
 * Light two-seat jet trainer (~3.9 t, 9.6 m span) in the spirit of a Hawk or L-39: one
 * low-bypass turbofan with a small afterburner in the rear fuselage, low wing with slight
 * dihedral, tricycle gear. The fuselage, each wing, each tail surface and the engine are
 * separate parts, so an over-stressed wing or tail breaks off on its own.
 *
 * Axes: +X right, +Y up, -Z forward. Origin ~ at the wing root.
 */

const WING_Y = -0.3;

const wing = (side: -1 | 1): PartDef => ({
  id: side < 0 ? 'wing.left' : 'wing.right',
  kind: 'wing',
  mass: 230,
  position: [side * 2.75, WING_Y, -0.5],
  rotationDeg: [0, 0, side * 3],
  shape: { type: 'box', size: [4.3, 0.2, 2.0] },
  color: '#d8dde3',
  modules: [
    // Wing tank inboard, near the CoM.
    { type: 'fuel', offset: [-side * 1.2, 0, 0], capacity: 220 },
    {
      type: 'aero',
      offset: [-side * 1.075, 0, 0],
      span: 2.15,
      chord: 2.0,
      aspectRatio: 5.4,
      incidenceDeg: 1.5,
      camberDeg: 1.5,
      criticalMach: 0.8,
      control: { channel: 'flaps', maxDeflectionDeg: 30, gain: 1, spanFraction: 0.9, chordFraction: 0.25 },
    },
    {
      type: 'aero',
      offset: [side * 1.075, 0, 0],
      span: 2.15,
      chord: 2.0,
      aspectRatio: 5.4,
      incidenceDeg: -0.5,
      camberDeg: 1.5,
      criticalMach: 0.8,
      control: { channel: 'roll', maxDeflectionDeg: 15, gain: side < 0 ? 1 : -1, spanFraction: 0.85, chordFraction: 0.25 },
    },
  ],
});

const mainGear = (side: -1 | 1): PartDef => ({
  id: side < 0 ? 'gear.left' : 'gear.right',
  kind: 'gear',
  mass: 60,
  position: [side * 1.5, -0.7, 0.35],
  collider: false,
  shape: { type: 'box', size: [0.12, 0.5, 0.12] },
  color: '#555555',
  modules: [
    { type: 'wheel', offset: [0, 0.1, 0], radius: 0.32, restLength: 0.45, stiffness: 120000, damping: 13000, brakes: true },
    { type: 'drag', cdA: 0.07 },
  ],
});

export const JET: CraftDef = {
  name: 'Hawkeye J-3',
  formatVersion: 1,
  parts: [
    {
      id: 'nose',
      kind: 'nose',
      mass: 160, // avionics
      position: [0, 0, -5.2],
      shape: { type: 'box', size: [0.7, 0.75, 1.6] },
      color: '#d8dde3',
    },
    {
      id: 'fuselage',
      kind: 'fuselage',
      mass: 1150,
      position: [0, 0, -1.5],
      shape: { type: 'box', size: [1.1, 1.3, 6.0] },
      color: '#d8dde3',
      modules: [
        // The whole fuselage, nose to tailpipe, as one slender body.
        { type: 'body', length: 11.5, diameter: 1.2, offset: [0, 0, 1.0], cdFront: 0.1 },
        // Fuselage tank over the wing.
        { type: 'fuel', offset: [0, 0.2, 1.4], capacity: 450 },
      ],
    },
    {
      id: 'cockpit',
      kind: 'cockpit',
      mass: 220, // two crew + ejection seats
      position: [0, 0.85, -2.6],
      shape: { type: 'box', size: [0.8, 0.55, 2.6] },
      color: '#4d7ea8',
      modules: [
        // 24 V, 40 Ah main battery behind the cockpit; mission avionics are shed on battery.
        { type: 'battery', cells: 12, capacityAh: 40, cellResistance: 0.002, cellVmax: 2.13, cellVmin: 1.85 },
        { type: 'avionics', loadW: 600, essential: true },
        { type: 'avionics', loadW: 1500, essential: false },
      ],
    },
    {
      id: 'engine',
      kind: 'engine.turbofan',
      mass: 700,
      position: [0, 0.05, 2.6],
      shape: { type: 'box', size: [0.95, 0.95, 3.2] },
      color: '#6b7280',
      modules: [
        {
          type: 'engine',
          kind: 'turbofan',
          maxThrust: 24000,
          bypassRatio: 0.75,
          afterburner: { thrustRatio: 1.45, fuelRatio: 3.5 },
          spoolTime: 1.5,
        },
        { type: 'generator', ratedAmps: 300, minRpmFraction: 0.1 },
      ],
    },
    {
      id: 'tailcone',
      kind: 'fuselage',
      mass: 90,
      position: [0, 0.35, 5.1],
      shape: { type: 'box', size: [0.7, 0.7, 2.0] },
      color: '#d8dde3',
      modules: [{ type: 'drag', cdA: 0.04 }],
    },
    wing(-1),
    wing(1),
    {
      id: 'stabilizer.left',
      kind: 'tail.horizontal',
      mass: 30,
      position: [-1.25, 0.3, 5.3],
      rotationDeg: [0, 0, -4],
      shape: { type: 'box', size: [1.9, 0.08, 1.0] },
      color: '#d8dde3',
      modules: [
        // All-moving tailplane halves: whole-wing aspect ratio.
        { type: 'aero', span: 1.9, chord: 1.0, aspectRatio: 4, incidenceDeg: -1.5, control: { channel: 'pitch', maxDeflectionDeg: 20, gain: -1, chordFraction: 0.4 } },
      ],
    },
    {
      id: 'stabilizer.right',
      kind: 'tail.horizontal',
      mass: 30,
      position: [1.25, 0.3, 5.3],
      rotationDeg: [0, 0, 4],
      shape: { type: 'box', size: [1.9, 0.08, 1.0] },
      color: '#d8dde3',
      modules: [
        { type: 'aero', span: 1.9, chord: 1.0, aspectRatio: 4, incidenceDeg: -1.5, control: { channel: 'pitch', maxDeflectionDeg: 20, gain: -1, chordFraction: 0.4 } },
      ],
    },
    {
      id: 'stabilizer.vertical',
      kind: 'tail.vertical',
      mass: 35,
      position: [0, 1.4, 5.0],
      rotationDeg: [0, 0, 90],
      shape: { type: 'box', size: [1.7, 0.1, 1.3] },
      color: '#b8433a',
      modules: [{ type: 'aero', span: 1.7, chord: 1.3, control: { channel: 'yaw', maxDeflectionDeg: 20, gain: 1, chordFraction: 0.35 } }],
    },
    {
      id: 'gear.nose',
      kind: 'gear',
      mass: 35,
      position: [0, -0.75, -4.2],
      collider: false,
      shape: { type: 'box', size: [0.1, 0.4, 0.1] },
      color: '#555555',
      modules: [
        { type: 'wheel', offset: [0, 0.1, 0], radius: 0.25, restLength: 0.45, stiffness: 40000, damping: 4400, maxSteerDeg: 20 },
        { type: 'drag', cdA: 0.04 },
      ],
    },
    mainGear(-1),
    mainGear(1),
  ],
};
