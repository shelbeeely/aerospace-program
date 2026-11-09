import type { CraftDef } from './types.ts';

/**
 * Light cycle: a low, enclosed two-wheel program carrier. The rear wheel drives, the front
 * steers, a gyro stabiliser keeps it upright and leaning into turns, and it lays down a jetwall
 * of solid light from its tail (L cycles jetwall → light ribbon → off).
 */
export const LIGHT_CYCLE: CraftDef = {
  name: 'Light Cycle',
  formatVersion: 1,
  parts: [
    {
      id: 'hull',
      kind: 'cycle hull',
      mass: 210,
      position: [0, 0.8, 0],
      shape: { type: 'box', size: [0.62, 0.7, 2.7] },
      color: '#00eaff',
      modules: [
        { type: 'wheel', offset: [0, -0.3, -1.12], radius: 0.46, restLength: 0.18, stiffness: 22000, damping: 2400, maxSteerDeg: 24, brakes: true },
        { type: 'wheel', offset: [0, -0.3, 1.12], radius: 0.46, restLength: 0.18, stiffness: 24000, damping: 2600, brakes: true, drive: 3600 },
        { type: 'stabilizer', strength: 6500 },
        { type: 'drag', cdA: 0.75 },
        { type: 'trail', offset: [0, -0.2, 1.45], kind: 'wall', height: 1.9, color: '#00eaff' },
      ],
    },
    { id: 'canopy', kind: 'canopy', mass: 25, position: [0, 1.22, -0.25], shape: { type: 'box', size: [0.5, 0.22, 1.3] }, color: '#e8f6ff' },
    { id: 'wheel.front', kind: 'wheel', mass: 12, position: [0, 0.48, -1.12], shape: { type: 'cylinder', radius: 0.46, length: 0.34, axis: 'x' }, collider: false, color: '#00eaff' },
    { id: 'wheel.rear', kind: 'wheel', mass: 12, position: [0, 0.48, 1.12], shape: { type: 'cylinder', radius: 0.46, length: 0.34, axis: 'x' }, collider: false, color: '#00eaff' },
  ],
};
