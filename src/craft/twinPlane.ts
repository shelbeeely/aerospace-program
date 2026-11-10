import type { CraftDef, PartDef } from './types.ts';

/**
 * Light piston twin (~1.6 t, 12.4 m span), in the spirit of a Baron or Seneca: low wing with
 * dihedral, wing-mounted nacelles with counter-rotating propellers (no critical engine, torque
 * and P-factor cancel), fuel in the wings near the CoM, tricycle gear with the mains under the
 * nacelles.
 *
 * Axes: +X right, +Y up, -Z forward. Origin ~ at the wing root.
 */

const WING_Y = -0.35;
const DIHEDRAL = 5;

/** One wing (side = -1 left, +1 right): inboard flap panel, outboard aileron panel, fuel tank. */
const wing = (side: -1 | 1): PartDef => ({
  id: side < 0 ? 'wing.left' : 'wing.right',
  kind: 'wing',
  mass: 115,
  position: [side * 3.35, WING_Y, -0.8],
  rotationDeg: [0, 0, side * DIHEDRAL],
  shape: { type: 'box', size: [5.4, 0.18, 1.7] },
  color: '#e8e4da',
  modules: [
    // Main tank between the nacelle and the root, close to the CoM.
    { type: 'fuel', offset: [-side * 1.6, 0, 0], capacity: 75 },
    {
      type: 'aero',
      offset: [-side * 1.35, 0, 0],
      span: 2.7,
      chord: 1.7,
      aspectRatio: 7.5,
      incidenceDeg: 2,
      camberDeg: 2,
      control: { channel: 'flaps', maxDeflectionDeg: 30, gain: 1, spanFraction: 0.9, chordFraction: 0.25 },
    },
    {
      // Washout: 2.5° less than the root, so the tips (and ailerons) stall last.
      type: 'aero',
      offset: [side * 1.35, 0, 0],
      span: 2.7,
      chord: 1.7,
      aspectRatio: 7.5,
      incidenceDeg: -0.5,
      camberDeg: 2,
      control: { channel: 'roll', maxDeflectionDeg: 18, gain: side < 0 ? 1 : -1, spanFraction: 0.85, chordFraction: 0.28 },
    },
  ],
});

/** Engine nacelle on the wing, propeller well ahead of the leading edge. */
const nacelle = (side: -1 | 1): PartDef => ({
  id: side < 0 ? 'engine.left' : 'engine.right',
  kind: 'engine.prop',
  mass: 185,
  position: [side * 2.1, -0.05, -1.75],
  shape: { type: 'box', size: [0.8, 0.8, 2.3] },
  color: '#2f4f7a',
  modules: [
    {
      type: 'engine',
      offset: [0, 0, -1.3],
      maxThrust: 4600,
      propMaxSpeed: 130,
      propRadius: 0.9,
      // Counter-rotating: left prop clockwise, right anticlockwise (seen from behind).
      propDirection: side < 0 ? 1 : -1,
    },
    { type: 'body', length: 2.3, diameter: 0.8, cdFront: 0.15 },
    // One alternator per engine: either can carry the bus.
    { type: 'generator', ratedAmps: 70 },
  ],
});

/** Main gear leg under the nacelle. */
const mainGear = (side: -1 | 1): PartDef => ({
  id: side < 0 ? 'gear.left' : 'gear.right',
  kind: 'gear',
  mass: 28,
  position: [side * 2.1, -0.75, -0.1],
  collider: false,
  shape: { type: 'box', size: [0.12, 0.5, 0.12] },
  color: '#555555',
  modules: [
    { type: 'wheel', offset: [0, 0.1, 0], radius: 0.3, restLength: 0.45, stiffness: 50000, damping: 5500, brakes: true },
    { type: 'drag', cdA: 0.06 },
  ],
});

export const TWIN_PLANE: CraftDef = {
  name: 'Twinstar B-2',
  formatVersion: 1,
  parts: [
    {
      id: 'nose',
      kind: 'nose',
      mass: 60,
      position: [0, 0, -3.4],
      shape: { type: 'box', size: [0.9, 0.9, 1.2] },
      color: '#e8e4da',
    },
    {
      id: 'fuselage',
      kind: 'fuselage',
      mass: 420,
      position: [0, 0, -0.3],
      shape: { type: 'box', size: [1.3, 1.4, 5.0] },
      color: '#e8e4da',
      modules: [
        { type: 'body', length: 6.2, diameter: 1.3, offset: [0, 0, -0.6], cdFront: 0.15 },
        { type: 'battery', cells: 12, capacityAh: 15, cellResistance: 0.003, cellVmax: 2.13, cellVmin: 1.85 },
      ],
    },
    {
      id: 'cabin',
      kind: 'cockpit',
      mass: 220, // pilot + three passengers
      position: [0, 0.85, -0.3],
      shape: { type: 'box', size: [1.1, 0.5, 2.4] },
      color: '#5b8fb9',
      modules: [
        { type: 'avionics', loadW: 250, essential: true },
        { type: 'avionics', loadW: 400, essential: false },
      ],
    },
    {
      id: 'tailcone',
      kind: 'fuselage',
      mass: 70,
      position: [0, 0.2, 4.0],
      shape: { type: 'box', size: [0.7, 0.8, 3.6] },
      color: '#e8e4da',
      modules: [{ type: 'drag', cdA: 0.06 }],
    },
    wing(-1),
    wing(1),
    nacelle(-1),
    nacelle(1),
    {
      id: 'stabilizer.horizontal',
      kind: 'tail.horizontal',
      mass: 32,
      position: [0, 0.35, 6.0],
      shape: { type: 'box', size: [4.2, 0.1, 0.9] },
      color: '#e8e4da',
      modules: [
        {
          type: 'aero',
          span: 4.2,
          chord: 0.9,
          incidenceDeg: -1.5,
          control: { channel: 'pitch', maxDeflectionDeg: 22, gain: -1, chordFraction: 0.4 },
        },
      ],
    },
    {
      id: 'stabilizer.vertical',
      kind: 'tail.vertical',
      mass: 22,
      position: [0, 1.2, 5.75],
      rotationDeg: [0, 0, 90],
      shape: { type: 'box', size: [1.6, 0.1, 1.35] },
      color: '#2f4f7a',
      modules: [
        {
          type: 'aero',
          span: 1.6,
          chord: 1.35,
          control: { channel: 'yaw', maxDeflectionDeg: 22, gain: 1, chordFraction: 0.4 },
        },
      ],
    },
    { id: 'gear.nose.strut', kind: 'gear.strut', mass: 0.3, position: [0, -0.55, -3.0], shape: { type: 'box', size: [0.06, 0.3, 0.06] }, collider: false, color: '#ffb000' },
    {
      id: 'gear.nose',
      kind: 'gear',
      mass: 18,
      position: [0, -0.85, -3.0],
      collider: false,
      shape: { type: 'box', size: [0.1, 0.4, 0.1] },
      color: '#555555',
      modules: [
        { type: 'wheel', offset: [0, 0.1, 0], radius: 0.24, restLength: 0.45, stiffness: 18000, damping: 2000, maxSteerDeg: 25 },
        { type: 'drag', cdA: 0.04 },
      ],
    },
    mainGear(-1),
    mainGear(1),
  ],
};
