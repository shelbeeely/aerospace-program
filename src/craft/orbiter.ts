import type { CraftDef, PartDef } from './types.ts';

/**
 * Orbiter: a small neon spaceplane (~4.6 t fuelled). One throttleable rocket in the tail
 * (isp 330 s, full thrust in vacuum) with reaction-control thrusters for attitude where the
 * air is too thin for the surfaces, wing and fuselage tanks around the centre of mass, low
 * wing with dihedral, tricycle gear. Takes off and lands like a jet; on this small planet,
 * ~230 m/s level at 10 km is already an orbit with its apoapsis near 50 km.
 *
 * Axes: +X right, +Y up, -Z forward. Origin ~ at the wing root.
 */

const CYAN = '#22e8ff';
const WHITE = '#eef8ff';
const AMBER = '#ffb02e';
const WING_Y = -0.3;

const wing = (side: -1 | 1): PartDef => ({
  id: side < 0 ? 'wing.left' : 'wing.right',
  kind: 'wing',
  mass: 220,
  position: [side * 2.85, WING_Y, -0.3],
  rotationDeg: [0, 0, side * 3],
  shape: { type: 'box', size: [4.5, 0.2, 2.3] },
  color: WHITE,
  modules: [
    // Wing tank inboard, near the CoM.
    { type: 'fuel', offset: [-side * 1.2, 0, 0], capacity: 330 },
    {
      type: 'aero',
      offset: [-side * 1.125, 0, 0],
      span: 2.25,
      chord: 2.3,
      aspectRatio: 5,
      incidenceDeg: 1.5,
      camberDeg: 1.5,
      criticalMach: 0.8,
      control: { channel: 'flaps', maxDeflectionDeg: 30, gain: 1, spanFraction: 0.9, chordFraction: 0.25 },
    },
    {
      type: 'aero',
      offset: [side * 1.125, 0, 0],
      span: 2.25,
      chord: 2.3,
      aspectRatio: 5,
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
  position: [side * 1.6, -0.7, 0.55],
  collider: false,
  shape: { type: 'box', size: [0.12, 0.5, 0.12] },
  color: '#555555',
  modules: [
    { type: 'wheel', offset: [0, 0.1, 0], radius: 0.32, restLength: 0.45, stiffness: 140000, damping: 15000, brakes: true },
    { type: 'drag', cdA: 0.07 },
  ],
});

export const ORBITER: CraftDef = {
  name: 'Orbiter',
  formatVersion: 1,
  parts: [
    {
      id: 'nose',
      kind: 'nose',
      mass: 180, // avionics, RCS quads
      position: [0, 0, -5.2],
      shape: { type: 'box', size: [0.7, 0.75, 1.6] },
      color: WHITE,
    },
    {
      id: 'fuselage',
      kind: 'fuselage',
      mass: 1050,
      position: [0, 0, -1.5],
      shape: { type: 'box', size: [1.2, 1.3, 6.0] },
      color: WHITE,
      modules: [
        { type: 'body', length: 11.5, diameter: 1.25, offset: [0, 0, 1.0], cdFront: 0.1 },
        // Main propellant tank over the wing.
        { type: 'fuel', offset: [0, 0.2, 1.6], capacity: 900 },
      ],
    },
    {
      id: 'cockpit',
      kind: 'cockpit',
      mass: 200,
      position: [0, 0.85, -2.6],
      shape: { type: 'box', size: [0.8, 0.55, 2.6] },
      color: CYAN,
      modules: [
        { type: 'battery', cells: 12, capacityAh: 40, cellResistance: 0.002, cellVmax: 2.13, cellVmin: 1.85 },
        { type: 'avionics', loadW: 500, essential: true },
      ],
    },
    {
      id: 'engine',
      kind: 'engine.rocket',
      mass: 420,
      position: [0, 0.05, 2.6],
      shape: { type: 'box', size: [0.95, 0.95, 3.2] },
      color: AMBER,
      modules: [
        // Throttleable rocket plus the RCS: the stick turns the craft in vacuum too.
        { type: 'engine', kind: 'rocket', maxThrust: 30000, isp: 330, rcsTorque: 6000 },
        { type: 'generator', ratedAmps: 200, minRpmFraction: 0.05 },
      ],
    },
    {
      id: 'tailcone',
      kind: 'nozzle',
      mass: 90,
      position: [0, 0.35, 5.1],
      shape: { type: 'box', size: [0.7, 0.7, 2.0] },
      color: AMBER,
      modules: [{ type: 'drag', cdA: 0.04 }],
    },
    wing(-1),
    wing(1),
    {
      id: 'stabilizer.left',
      kind: 'tail.horizontal',
      mass: 30,
      position: [-1.3, 0.3, 5.3],
      rotationDeg: [0, 0, -4],
      shape: { type: 'box', size: [2.0, 0.08, 1.1] },
      color: CYAN,
      modules: [
        { type: 'aero', span: 2.0, chord: 1.1, aspectRatio: 4, incidenceDeg: -1.5, control: { channel: 'pitch', maxDeflectionDeg: 20, gain: -1, chordFraction: 0.4 } },
      ],
    },
    {
      id: 'stabilizer.right',
      kind: 'tail.horizontal',
      mass: 30,
      position: [1.3, 0.3, 5.3],
      rotationDeg: [0, 0, 4],
      shape: { type: 'box', size: [2.0, 0.08, 1.1] },
      color: CYAN,
      modules: [
        { type: 'aero', span: 2.0, chord: 1.1, aspectRatio: 4, incidenceDeg: -1.5, control: { channel: 'pitch', maxDeflectionDeg: 20, gain: -1, chordFraction: 0.4 } },
      ],
    },
    {
      id: 'stabilizer.vertical',
      kind: 'tail.vertical',
      mass: 35,
      position: [0, 1.4, 5.0],
      rotationDeg: [0, 0, 90],
      shape: { type: 'box', size: [1.8, 0.1, 1.4] },
      color: AMBER,
      modules: [{ type: 'aero', span: 1.8, chord: 1.4, control: { channel: 'yaw', maxDeflectionDeg: 20, gain: 1, chordFraction: 0.35 } }],
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
        { type: 'wheel', offset: [0, 0.1, 0], radius: 0.25, restLength: 0.45, stiffness: 45000, damping: 5000, maxSteerDeg: 20 },
        { type: 'drag', cdA: 0.04 },
      ],
    },
    mainGear(-1),
    mainGear(1),
  ],
};
