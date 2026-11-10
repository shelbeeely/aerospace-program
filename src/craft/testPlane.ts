import type { CraftDef } from './types.ts';

/**
 * Stage 1 test plane: a forgiving high-wing trainer (~740 kg, 10 m span).
 * Pure data in the same format the Stage 2 hangar will save.
 *
 * Axes: +X right, +Y up, -Z forward. Origin ~ at the wing root.
 */
export const TEST_PLANE: CraftDef = {
  name: 'Trainer T-1',
  formatVersion: 1,
  parts: [
    {
      id: 'engine',
      kind: 'engine.prop',
      mass: 130,
      position: [0, 0, -2.6],
      shape: { type: 'box', size: [1.0, 1.0, 1.0] },
      color: '#c94f3d',
      modules: [
        { type: 'engine', offset: [0, 0, -0.6], maxThrust: 4000, propMaxSpeed: 100, propRadius: 0.95 },
        { type: 'generator', ratedAmps: 60 },
      ],
    },
    {
      id: 'fuselage',
      kind: 'fuselage',
      mass: 220,
      position: [0, 0, 0],
      shape: { type: 'box', size: [1.1, 1.2, 4.2] },
      color: '#e8e4da',
      // Slender-body fuselage: axial drag, crossflow drag, destabilising Munk moment.
      modules: [
        { type: 'body', length: 4.2, diameter: 1.15, cdFront: 0.25 },
        // 24 V, 7 Ah lead-acid main battery: ~1 h of essential bus if the alternator fails.
        { type: 'battery', cells: 12, capacityAh: 7, cellResistance: 0.004, cellVmax: 2.13, cellVmin: 1.85 },
      ],
    },
    {
      id: 'tailboom',
      kind: 'fuselage',
      mass: 40,
      position: [0, 0.15, 3.4],
      shape: { type: 'box', size: [0.55, 0.6, 2.8] },
      color: '#e8e4da',
      modules: [{ type: 'drag', cdA: 0.05 }],
    },
    {
      id: 'cockpit',
      kind: 'cockpit',
      mass: 100,
      position: [0, 0.75, -0.7],
      shape: { type: 'box', size: [0.95, 0.45, 1.4] },
      color: '#5b8fb9',
      modules: [
        // Flight instruments, radio, transponder; lights and pitot heat are shed on battery.
        { type: 'avionics', loadW: 150, essential: true },
        { type: 'avionics', loadW: 200, essential: false },
      ],
    },
    {
      id: 'wing.left',
      kind: 'wing',
      mass: 55,
      position: [-2.85, 0.65, -0.35],
      rotationDeg: [0, 0, -3.5], // dihedral: tip up
      shape: { type: 'box', size: [4.6, 0.14, 1.5] },
      color: '#f2c14e',
      modules: [
        // Wing tank near the root, 30 kg of fuel. Burning it shifts the CoM slightly aft.
        { type: 'fuel', offset: [1.15, 0, 0], capacity: 30 },
        // Inboard panel: more incidence than the tip (washout), so the root stalls first and
        // the ailerons keep working through the stall, as on real trainers.
        {
          type: 'aero',
          offset: [1.15, 0, 0],
          span: 2.3,
          chord: 1.5,
          aspectRatio: 7,
          incidenceDeg: 1.5,
          camberDeg: 2, // NACA 2412-like: lifts at zero AoA, Cm0 ≈ -0.05
          control: { channel: 'flaps', maxDeflectionDeg: 30, gain: 1, spanFraction: 0.9, chordFraction: 0.25 },
        },
        {
          type: 'aero',
          offset: [-1.15, 0, 0],
          span: 2.3,
          chord: 1.5,
          aspectRatio: 7,
          incidenceDeg: -1.5,
          camberDeg: 2,
          control: { channel: 'roll', maxDeflectionDeg: 18, gain: 1, spanFraction: 0.9, chordFraction: 0.28 },
        },
      ],
    },
    {
      id: 'wing.right',
      kind: 'wing',
      mass: 55,
      position: [2.85, 0.65, -0.35],
      rotationDeg: [0, 0, 3.5],
      shape: { type: 'box', size: [4.6, 0.14, 1.5] },
      color: '#f2c14e',
      modules: [
        // Wing tank near the root, 30 kg of fuel. Burning it shifts the CoM slightly aft.
        { type: 'fuel', offset: [-1.15, 0, 0], capacity: 30 },
        // Inboard panel: more incidence than the tip (washout), so the root stalls first and
        // the ailerons keep working through the stall, as on real trainers.
        {
          type: 'aero',
          offset: [-1.15, 0, 0],
          span: 2.3,
          chord: 1.5,
          aspectRatio: 7,
          incidenceDeg: 1.5,
          camberDeg: 2, // NACA 2412-like: lifts at zero AoA, Cm0 ≈ -0.05
          control: { channel: 'flaps', maxDeflectionDeg: 30, gain: 1, spanFraction: 0.9, chordFraction: 0.25 },
        },
        {
          type: 'aero',
          offset: [1.15, 0, 0],
          span: 2.3,
          chord: 1.5,
          aspectRatio: 7,
          incidenceDeg: -1.5,
          camberDeg: 2,
          control: { channel: 'roll', maxDeflectionDeg: 18, gain: -1, spanFraction: 0.9, chordFraction: 0.28 },
        },
      ],
    },
    {
      id: 'stabilizer.horizontal',
      kind: 'tail.horizontal',
      mass: 18,
      position: [0, 0.2, 4.6],
      shape: { type: 'box', size: [3.2, 0.1, 0.85] },
      color: '#f2c14e',
      modules: [
        {
          type: 'aero',
          span: 3.2,
          chord: 0.85,
          incidenceDeg: -1.5,
          control: { channel: 'pitch', maxDeflectionDeg: 24, gain: -1, chordFraction: 0.4 },
        },
      ],
    },
    {
      id: 'stabilizer.vertical',
      kind: 'tail.vertical',
      mass: 12,
      position: [0, 0.95, 4.55],
      rotationDeg: [0, 0, 90], // local +X (span) points up, normal points left
      shape: { type: 'box', size: [1.3, 0.1, 1.1] },
      color: '#c94f3d',
      modules: [
        {
          type: 'aero',
          span: 1.3,
          chord: 1.1,
          control: { channel: 'yaw', maxDeflectionDeg: 20, gain: 1, chordFraction: 0.4 },
        },
      ],
    },
    {
      id: 'gear.nose',
      kind: 'gear',
      mass: 12,
      position: [0, -0.7, -2.1],
      collider: false,
      shape: { type: 'box', size: [0.1, 0.4, 0.1] },
      color: '#555555',
      modules: [
        {
          type: 'wheel',
          offset: [0, 0.1, 0],
          radius: 0.2,
          restLength: 0.45,
          stiffness: 18000,
          damping: 1700,
          maxSteerDeg: 25,
        },
        { type: 'drag', cdA: 0.04 },
      ],
    },
    // Gear struts: tie the main legs to the fuselage (visual; the legs carry the loads).
    { id: 'gear.strut.left', kind: 'gear.strut', mass: 0.5, position: [-0.83, -0.55, 0.35], shape: { type: 'box', size: [0.7, 0.06, 0.06] }, collider: false, color: '#ffb000' },
    { id: 'gear.strut.right', kind: 'gear.strut', mass: 0.5, position: [0.83, -0.55, 0.35], shape: { type: 'box', size: [0.7, 0.06, 0.06] }, collider: false, color: '#ffb000' },
    {
      id: 'gear.left',
      kind: 'gear',
      mass: 18,
      position: [-1.15, -0.7, 0.35],
      collider: false,
      shape: { type: 'box', size: [0.1, 0.4, 0.1] },
      color: '#555555',
      modules: [
        {
          type: 'wheel',
          offset: [0, 0.1, 0],
          radius: 0.25,
          restLength: 0.4,
          stiffness: 26000,
          damping: 2800,
          brakes: true,
        },
        { type: 'drag', cdA: 0.05 },
      ],
    },
    {
      id: 'gear.right',
      kind: 'gear',
      mass: 18,
      position: [1.15, -0.7, 0.35],
      collider: false,
      shape: { type: 'box', size: [0.1, 0.4, 0.1] },
      color: '#555555',
      modules: [
        {
          type: 'wheel',
          offset: [0, 0.1, 0],
          radius: 0.25,
          restLength: 0.4,
          stiffness: 26000,
          damping: 2800,
          brakes: true,
        },
        { type: 'drag', cdA: 0.05 },
      ],
    },
  ],
};
