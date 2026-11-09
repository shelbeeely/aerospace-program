import type { CraftDef, PartDef, WheelDef } from './types.ts';

/** Wheel stations (x, z): front pair steers, rear pair drives. */
const WHEELS: Array<[number, number]> = [[-0.86, -1.4], [0.86, -1.4], [-0.86, 1.4], [0.86, 1.4]];
const RADIUS = 0.38;
const REST = 0.16;
const MOUNT_Y = -0.25;

const wheel = ([x, z]: [number, number]): WheelDef => ({
  type: 'wheel',
  offset: [x, MOUNT_Y, z],
  radius: RADIUS,
  restLength: REST,
  stiffness: 32000,
  damping: 3200,
  brakes: true,
  ...(z < 0 ? { maxSteerDeg: 30 } : { drive: 3600 }),
});

const CHASSIS_Y = 0.7;
const wheelPart = ([x, z]: [number, number], i: number): PartDef => ({
  id: `wheel.${['fl', 'fr', 'rl', 'rr'][i]}`,
  kind: 'wheel',
  mass: 14,
  position: [x, CHASSIS_Y + MOUNT_Y - REST, z],
  shape: { type: 'cylinder', radius: RADIUS, length: 0.28, axis: 'x' },
  collider: false,
  color: '#00eaff',
});

/**
 * Light car: a low four-wheel neon runabout. The front wheels steer, the rear wheels drive, and
 * it lays light from its tail like a cycle (L: jetwall → light ribbon → off). Cyan body lines,
 * with red and amber accents for contrast.
 */
export const LIGHT_CAR: CraftDef = {
  name: 'Light Car',
  formatVersion: 1,
  parts: [
    {
      id: 'chassis',
      kind: 'car chassis',
      mass: 620,
      position: [0, CHASSIS_Y, 0],
      shape: { type: 'box', size: [1.9, 0.5, 4.2] },
      color: '#00eaff',
      modules: [
        ...WHEELS.map(wheel),
        { type: 'drag', cdA: 0.62 },
        { type: 'trail', offset: [0, -0.3, 2.15], kind: 'wall', height: 1.4, color: '#00eaff' },
      ],
    },
    { id: 'cabin', kind: 'canopy', mass: 90, position: [0, 1.17, 0.2], shape: { type: 'box', size: [1.4, 0.44, 1.9] }, color: '#e8f6ff' },
    { id: 'nose.stripe', kind: 'accent', mass: 4, position: [0, 0.96, -2.02], shape: { type: 'box', size: [1.7, 0.06, 0.18] }, collider: false, color: '#ff2a1a' },
    { id: 'tail.stripe', kind: 'accent', mass: 4, position: [0, 0.96, 2.02], shape: { type: 'box', size: [1.7, 0.08, 0.18] }, collider: false, color: '#ff2a1a' },
    { id: 'side.left', kind: 'accent', mass: 3, position: [-0.96, 0.62, 0], shape: { type: 'box', size: [0.04, 0.08, 3.6] }, collider: false, color: '#ffb000' },
    { id: 'side.right', kind: 'accent', mass: 3, position: [0.96, 0.62, 0], shape: { type: 'box', size: [0.04, 0.08, 3.6] }, collider: false, color: '#ffb000' },
    ...WHEELS.map(wheelPart),
  ],
};
