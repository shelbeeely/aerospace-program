import type { CraftDef, PartDef, WheelDef } from './types.ts';

/** Road wheels: six per side, evenly spaced, all driven, steered by skidding the two sides. */
const WHEEL_Z = [-2.25, -1.35, -0.45, 0.45, 1.35, 2.25];
const TRACK_X = 1.75;

const roadWheel = (side: 1 | -1, z: number): WheelDef => ({
  type: 'wheel',
  offset: [side * TRACK_X, -0.45, z],
  radius: 0.42,
  restLength: 0.2,
  stiffness: 140000,
  damping: 14000,
  brakes: true,
  drive: 3400,
  skid: side,
});

const track = (side: 1 | -1): PartDef => ({
  id: `track.${side < 0 ? 'left' : 'right'}`,
  kind: 'track',
  mass: 900,
  position: [side * TRACK_X, 0.5, 0],
  shape: { type: 'box', size: [0.62, 0.78, 5.6] },
  collider: false,
  color: '#ff3b1f',
  reinforce: 3,
});

/**
 * Program tank: a heavy, slow armoured hull on six road wheels per side. It skid-steers: the
 * yaw channel drives the two tracks in opposite directions, so it can turn on the spot. Every
 * part is fully reinforced and armoured (4x strength), it bulldozes through buildings it drives
 * into, fires its cannon and coaxial gun (fitted weapon modules), and lays a red jetwall behind it.
 */
export const TANK: CraftDef = {
  name: 'Program Tank',
  formatVersion: 1,
  armor: 4,
  bulldozer: true,
  parts: [
    {
      id: 'hull',
      kind: 'tank hull',
      mass: 7800,
      position: [0, 1.15, 0],
      shape: { type: 'box', size: [2.9, 0.9, 6.0] },
      color: '#1a0a08',
      reinforce: 3,
      modules: [
        ...WHEEL_Z.flatMap((z) => [roadWheel(-1, z), roadWheel(1, z)]),
        { type: 'drag', cdA: 3.2 },
        { type: 'trail', offset: [0, -0.7, 3.05], kind: 'wall', height: 2.4, color: '#ff3b1f' },
      ],
    },
    track(-1),
    track(1),
    {
      id: 'turret', kind: 'turret', mass: 1800, position: [0, 1.9, 0.3], shape: { type: 'box', size: [2.0, 0.6, 2.4] }, color: '#2a0c08', reinforce: 3,
      // The main gun (its breech in the turret, the barrel out through the mantlet) and the
      // coaxial machine gun beside it.
      modules: [
        { type: 'weapon', kind: 'cannon', offset: [0, 0.05, -1.2] },
        { type: 'weapon', kind: 'gun', offset: [0.55, 0.05, -1.2] },
      ],
    },
    { id: 'cannon', kind: 'cannon', mass: 300, position: [0, 1.95, -1.9], shape: { type: 'cylinder', radius: 0.14, length: 2.6, axis: 'z' }, color: '#ff8a1f', reinforce: 3 },
    { id: 'glacis.light', kind: 'accent', mass: 5, position: [0, 1.62, -3.0], shape: { type: 'box', size: [2.6, 0.08, 0.06] }, collider: false, color: '#ffb000' },
    { id: 'turret.light', kind: 'accent', mass: 5, position: [0, 2.22, 0.3], shape: { type: 'box', size: [2.04, 0.05, 2.44] }, collider: false, color: '#ff3b1f' },
  ],
};
