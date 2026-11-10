import type { CraftDef, PartDef, WheelDef } from './types.ts';

/**
 * Outlands vehicles: built for the craggy wastelands outside the cities, where a street light
 * cycle's small, stiff wheels get thrown by every rock. All of them ride on big wheels with
 * long, soft suspension travel and high ground clearance, and drive more than one wheel.
 * Colours: cyan circuit lines with amber and orange contrast (the Outlands palette).
 */

/** A wheel module plus its visual part, at (x, z) under a chassis whose centre is at chassisY. */
function wheelPair(
  id: string,
  [x, z]: [number, number],
  chassisY: number,
  w: Omit<WheelDef, 'type' | 'offset'> & { mountY: number; width: number; mass: number; color?: string },
): { module: WheelDef; part: PartDef } {
  const { mountY, width, mass, color, ...def } = w;
  return {
    module: { type: 'wheel', offset: [x, mountY, z], ...def },
    part: {
      id,
      kind: 'wheel',
      mass,
      position: [x, chassisY + mountY - def.restLength, z],
      shape: { type: 'cylinder', radius: def.radius, length: width, axis: 'x' },
      collider: false,
      color: color ?? '#ffb000',
    },
  };
}

// --- Light Crawler: a six-wheeled, all-wheel-drive rock crawler. Slow, sure-footed, tough.
const CRAWLER_Y = 1.55;
const crawlerWheels = ([[-1.35, -2.1], [1.35, -2.1], [-1.35, 0], [1.35, 0], [-1.35, 2.1], [1.35, 2.1]] as Array<[number, number]>).map((p, i) =>
  wheelPair(`wheel.${i}`, p, CRAWLER_Y, {
    mountY: -0.35, radius: 0.78, restLength: 0.5, stiffness: 52000, damping: 6200, brakes: true, drive: 2300,
    width: 0.62, mass: 40, ...(p[1] < 0 ? { maxSteerDeg: 24 } : p[1] > 0 ? { maxSteerDeg: -8 } : {}),
  }));

/**
 * Light Crawler: six huge wheels on long-travel suspension, all driven; the front pair steers
 * and the rear pair counter-steers, so it turns tight among the rocks. A cyan cab on an
 * armoured amber-lit hull, laying a light ribbon from its tail.
 */
export const LIGHT_CRAWLER: CraftDef = {
  name: 'Light Crawler',
  formatVersion: 1,
  parts: [
    {
      id: 'hull',
      kind: 'crawler hull',
      mass: 1500,
      position: [0, CRAWLER_Y, 0],
      shape: { type: 'box', size: [2.2, 0.8, 5.2] },
      color: '#0a1424',
      reinforce: 2,
      modules: [
        ...crawlerWheels.map((w) => w.module),
        { type: 'stabilizer', strength: 40000 },
        { type: 'drag', cdA: 2.2 },
        { type: 'trail', offset: [0, -0.4, 2.65], kind: 'wall', height: 1.6, color: '#ffb000' },
      ],
    },
    { id: 'cab', kind: 'canopy', mass: 160, position: [0, 2.3, -1.1], shape: { type: 'box', size: [1.8, 0.7, 2.0] }, color: '#00eaff' },
    { id: 'roof.light', kind: 'accent', mass: 4, position: [0, 2.68, -1.1], shape: { type: 'box', size: [1.84, 0.05, 2.04] }, collider: false, color: '#ff8a1f' },
    { id: 'skid.plate', kind: 'accent', mass: 6, position: [0, 1.12, -2.62], shape: { type: 'box', size: [2.0, 0.08, 0.06] }, collider: false, color: '#ffb000' },
    { id: 'side.left', kind: 'accent', mass: 3, position: [-1.12, 1.6, 0], shape: { type: 'box', size: [0.04, 0.08, 4.8] }, collider: false, color: '#00eaff' },
    { id: 'side.right', kind: 'accent', mass: 3, position: [1.12, 1.6, 0], shape: { type: 'box', size: [0.04, 0.08, 4.8] }, collider: false, color: '#00eaff' },
    ...crawlerWheels.map((w) => w.part),
  ],
};

// --- Light Runner: a fast four-wheel-drive desert runner.
const RUNNER_Y = 1.15;
const runnerWheels = ([[-1.0, -1.55], [1.0, -1.55], [-1.0, 1.55], [1.0, 1.55]] as Array<[number, number]>).map((p, i) =>
  wheelPair(`wheel.${['fl', 'fr', 'rl', 'rr'][i]}`, p, RUNNER_Y, {
    mountY: -0.3, radius: 0.56, restLength: 0.38, stiffness: 30000, damping: 3400, brakes: true, drive: 1500,
    width: 0.42, mass: 18, color: '#00eaff', ...(p[1] < 0 ? { maxSteerDeg: 30 } : {}),
  }));

/**
 * Light Runner: a low, fast two-seater on tall wheels and long-travel suspension, all four
 * driven. Quick on Outlands highways and still at home on the ravine floors. Cyan body, red
 * nose and tail bars, amber flanks.
 */
export const LIGHT_RUNNER: CraftDef = {
  name: 'Light Runner',
  formatVersion: 1,
  parts: [
    {
      id: 'chassis',
      kind: 'runner chassis',
      mass: 720,
      position: [0, RUNNER_Y, 0],
      shape: { type: 'box', size: [2.0, 0.5, 4.4] },
      color: '#00eaff',
      modules: [
        ...runnerWheels.map((w) => w.module),
        { type: 'stabilizer', strength: 14000 },
        { type: 'drag', cdA: 0.7 },
        { type: 'trail', offset: [0, -0.3, 2.25], kind: 'wall', height: 1.5, color: '#00eaff' },
      ],
    },
    { id: 'cabin', kind: 'canopy', mass: 80, position: [0, 1.6, 0.1], shape: { type: 'box', size: [1.4, 0.4, 1.8] }, color: '#e8f6ff' },
    { id: 'nose.stripe', kind: 'accent', mass: 4, position: [0, 1.42, -2.12], shape: { type: 'box', size: [1.8, 0.06, 0.18] }, collider: false, color: '#ff2a1a' },
    { id: 'tail.stripe', kind: 'accent', mass: 4, position: [0, 1.42, 2.12], shape: { type: 'box', size: [1.8, 0.08, 0.18] }, collider: false, color: '#ff2a1a' },
    { id: 'side.left', kind: 'accent', mass: 3, position: [-1.02, 1.05, 0], shape: { type: 'box', size: [0.04, 0.08, 3.8] }, collider: false, color: '#ffb000' },
    { id: 'side.right', kind: 'accent', mass: 3, position: [1.02, 1.05, 0], shape: { type: 'box', size: [0.04, 0.08, 3.8] }, collider: false, color: '#ffb000' },
    ...runnerWheels.map((w) => w.part),
  ],
};

// --- Light Snowmobile: two steering skis in front, a driven track behind.
const SLED_Y = 0.85;
const skis = ([[-0.8, -1.15], [0.8, -1.15]] as Array<[number, number]>).map((p, i) =>
  wheelPair(`ski.${i ? 'right' : 'left'}`, p, SLED_Y, {
    mountY: -0.25, radius: 0.3, restLength: 0.32, stiffness: 14000, damping: 1500, brakes: true, maxSteerDeg: 26,
    width: 0.22, mass: 8, color: '#00eaff',
  }));
const bogies = ([[0, 0.25], [0, 0.85], [0, 1.45]] as Array<[number, number]>).map((p, i) =>
  wheelPair(`track.bogie.${i}`, p, SLED_Y, {
    mountY: -0.25, radius: 0.32, restLength: 0.34, stiffness: 12000, damping: 1400, brakes: true, drive: 1500,
    width: 0.5, mass: 10, color: '#ff8a1f',
  }));

/**
 * Light Snowmobile: a light, nimble sled. Two skis steer at the front and a single driven
 * track (three bogie wheels on soft, long travel) pushes from behind, so it floats over loose
 * rubble. Cyan skis and cowl, an orange track, a light ribbon from the tail.
 */
export const LIGHT_SNOWMOBILE: CraftDef = {
  name: 'Light Snowmobile',
  formatVersion: 1,
  parts: [
    {
      id: 'body',
      kind: 'sled body',
      mass: 260,
      position: [0, SLED_Y, 0.2],
      shape: { type: 'box', size: [0.9, 0.5, 2.9] },
      color: '#0a1424',
      modules: [
        ...skis.map((w) => ({ ...w.module, offset: [w.module.offset![0], w.module.offset![1], w.module.offset![2] - 0.2] as [number, number, number] })),
        ...bogies.map((w) => ({ ...w.module, offset: [w.module.offset![0], w.module.offset![1], w.module.offset![2] - 0.2] as [number, number, number] })),
        { type: 'stabilizer', strength: 8000 },
        { type: 'drag', cdA: 0.6 },
        { type: 'trail', offset: [0, -0.2, 1.45], kind: 'wall', height: 1.3, color: '#00eaff' },
      ],
    },
    { id: 'cowl', kind: 'canopy', mass: 30, position: [0, 1.25, -0.7], shape: { type: 'box', size: [0.8, 0.3, 1.0] }, color: '#00eaff' },
    { id: 'seat.light', kind: 'accent', mass: 2, position: [0, 1.12, 0.6], shape: { type: 'box', size: [0.5, 0.05, 1.2] }, collider: false, color: '#ffb000' },
    { id: 'ski.bar', kind: 'accent', mass: 2, position: [0, 0.6, -1.15], shape: { type: 'box', size: [1.66, 0.05, 0.06] }, collider: false, color: '#00eaff' },
    ...skis.map((w) => w.part),
    ...bogies.map((w) => w.part),
  ],
};

/**
 * Outlands Light Cycle: the street cycle rebuilt for the wastelands. Bigger wheels on long,
 * soft suspension, the hull raised for clearance, a stronger gyro, and drive to both wheels
 * (a hub motor up front), in Outlands amber with cyan circuit lines.
 */
export const OUTLANDS_CYCLE: CraftDef = {
  name: 'Light Cycle (Outlands)',
  formatVersion: 1,
  parts: [
    {
      id: 'hull',
      kind: 'cycle hull',
      mass: 230,
      position: [0, 1.15, 0],
      shape: { type: 'box', size: [0.66, 0.7, 2.8] },
      color: '#1a0f04',
      modules: [
        { type: 'wheel', offset: [0, -0.3, -1.2], radius: 0.6, restLength: 0.36, stiffness: 16000, damping: 2000, maxSteerDeg: 24, brakes: true, drive: 1200 },
        { type: 'wheel', offset: [0, -0.3, 1.2], radius: 0.6, restLength: 0.36, stiffness: 18000, damping: 2200, brakes: true, drive: 3000 },
        { type: 'stabilizer', strength: 9000 },
        { type: 'drag', cdA: 0.8 },
        { type: 'trail', offset: [0, -0.2, 1.5], kind: 'wall', height: 1.9, color: '#ffb000' },
      ],
    },
    { id: 'canopy', kind: 'canopy', mass: 25, position: [0, 1.57, -0.25], shape: { type: 'box', size: [0.5, 0.22, 1.3] }, color: '#00eaff' },
    { id: 'hull.line', kind: 'accent', mass: 2, position: [0, 1.15, 0], shape: { type: 'box', size: [0.68, 0.05, 2.82] }, collider: false, color: '#ffb000' },
    { id: 'wheel.front', kind: 'wheel', mass: 14, position: [0, 0.49, -1.2], shape: { type: 'cylinder', radius: 0.6, length: 0.4, axis: 'x' }, collider: false, color: '#ffb000' },
    { id: 'wheel.rear', kind: 'wheel', mass: 14, position: [0, 0.49, 1.2], shape: { type: 'cylinder', radius: 0.6, length: 0.4, axis: 'x' }, collider: false, color: '#ffb000' },
  ],
};
