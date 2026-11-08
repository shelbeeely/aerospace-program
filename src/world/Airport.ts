import { AIRPORT, LAYOUT } from '../sim/layout.ts';

/**
 * Seeded-free (fixed) airport plan shared by the simulation and the renderer: solid structures
 * (terminal, jet bridges, hangars, control tower) plus the light positions the renderer draws.
 * Everything stays west of the runway (x < -60) so take-off rolls and test cards are untouched.
 */
export interface AirportPiece {
  shape: 'box' | 'oct';
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
  color: string;
  /** Solid (gets a collider and can be destroyed). */
  solid: boolean;
  windows: boolean;
  /** Pieces with the same group fracture together (one building, one airliner). */
  group: string;
}

export interface AirportLight {
  x: number;
  y: number;
  z: number;
  kind: 'edge' | 'threshold' | 'end' | 'taxi' | 'approach' | 'strobe';
  /** Strobe sequence index (approach "rabbit"). */
  seq?: number;
}

export interface Papi {
  x: number;
  z: number;
  /** Lights from the runway outwards; each switches red→white at its angle (deg). */
  lights: Array<{ x: number; angle: number }>;
  /** Approach direction along Z: +1 = landing toward +Z, -1 = toward -Z. */
  dir: 1 | -1;
}

export interface AirportPlan {
  pieces: AirportPiece[];
  lights: AirportLight[];
  papis: Papi[];
  windsock: { x: number; z: number; height: number };
  beacon: { x: number; y: number; z: number };
}

let cached: AirportPlan | null = null;
export function airportPlan(): AirportPlan {
  return (cached ??= buildAirport());
}

function buildAirport(): AirportPlan {
  const { length, width, centerZ } = LAYOUT.runway;
  const zN = centerZ - length / 2; // north (-Z) threshold
  const zS = centerZ + length / 2; // south (+Z) threshold, near the spawn
  const pieces: AirportPiece[] = [];
  const lights: AirportLight[] = [];

  // --- Terminal: long low hall with a raised central concourse.
  const t = AIRPORT.terminal;
  pieces.push({ shape: 'box', x: t.x, y: t.height / 2, z: t.z, sx: t.depth, sy: t.height, sz: t.length, color: '#00eaff', solid: true, windows: true, group: 'terminal' });
  pieces.push({ shape: 'box', x: t.x - 6, y: t.height + 6, z: t.z, sx: t.depth * 0.6, sy: 12, sz: t.length * 0.35, color: '#ff2bd6', solid: true, windows: true, group: 'terminal' });
  // Jet bridges and parked airliners at six gates along the apron side.
  for (let g = 0; g < 6; g++) {
    const gz = t.z - t.length / 2 + 40 + g * ((t.length - 80) / 5);
    const bridgeLen = 34;
    pieces.push({ shape: 'box', x: t.x + t.depth / 2 + bridgeLen / 2, y: 5, z: gz, sx: bridgeLen, sy: 3.5, sz: 4, color: '#9d4dff', solid: true, windows: false, group: `bridge${g}` });
    // Airliner (nose toward the terminal): fuselage, wings, tailplane, fin, engines.
    const ax = t.x + t.depth / 2 + bridgeLen + 26;
    const fus = 44;
    pieces.push({ shape: 'box', x: ax, y: 4.5, z: gz, sx: fus, sy: 5, sz: 5, color: '#e8f6ff', solid: true, windows: false, group: `airliner${g}` });
    pieces.push({ shape: 'box', x: ax + 2, y: 3.6, z: gz, sx: 9, sy: 0.8, sz: 40, color: '#e8f6ff', solid: true, windows: false, group: `airliner${g}` });
    pieces.push({ shape: 'box', x: ax + fus / 2 - 3, y: 6.2, z: gz, sx: 5, sy: 0.6, sz: 15, color: '#e8f6ff', solid: true, windows: false, group: `airliner${g}` });
    pieces.push({ shape: 'box', x: ax + fus / 2 - 3, y: 10, z: gz, sx: 6, sy: 8, sz: 0.6, color: '#ff2bd6', solid: true, windows: false, group: `airliner${g}` });
    for (const s of [-1, 1]) pieces.push({ shape: 'oct', x: ax + 4, y: 2.2, z: gz + s * 8, sx: 3, sy: 3, sz: 3, color: '#ff8a1f', solid: true, windows: false, group: `airliner${g}` });
  }

  // --- Control tower: tall octagonal shaft, wide glass cab, roof and mast.
  const tw = AIRPORT.tower;
  pieces.push({ shape: 'oct', x: tw.x, y: tw.height / 2, z: tw.z, sx: 9, sy: tw.height, sz: 9, color: '#00eaff', solid: true, windows: false, group: 'tower' });
  pieces.push({ shape: 'oct', x: tw.x, y: tw.height + 4, z: tw.z, sx: 18, sy: 8, sz: 18, color: '#3dffb0', solid: true, windows: true, group: 'tower' });
  pieces.push({ shape: 'oct', x: tw.x, y: tw.height + 9, z: tw.z, sx: 21, sy: 2, sz: 21, color: '#00eaff', solid: true, windows: false, group: 'tower' });
  pieces.push({ shape: 'box', x: tw.x, y: tw.height + 16, z: tw.z, sx: 0.8, sy: 12, sz: 0.8, color: '#ff2bd6', solid: true, windows: false, group: 'tower' });

  // --- Hangars along the taxiway (magenta), near the spawn end.
  for (let i = 0; i < 4; i++) {
    pieces.push({ shape: 'box', x: -width / 2 - 70, y: 4.5, z: LAYOUT.spawnZ - 60 - i * 34, sx: 24, sy: 9, sz: 20, color: '#ff2bd6', solid: true, windows: false, group: `hangar${i}` });
  }
  // Fuel farm: two tanks.
  for (const dz of [0, 22]) pieces.push({ shape: 'oct', x: -260, y: 6, z: 300 + dz, sx: 16, sy: 12, sz: 16, color: '#ff8a1f', solid: true, windows: false, group: `tank${dz}` });

  // --- Runway lights: edges every 60 m, green threshold bars, red end bars.
  for (let z = zN; z <= zS + 0.1; z += 60) {
    for (const s of [-1, 1]) lights.push({ x: s * (width / 2 + 1.5), y: 0.4, z, kind: 'edge' });
  }
  for (let k = -6; k <= 6; k++) {
    const x = (k / 6) * (width / 2);
    lights.push({ x, y: 0.4, z: zS + 2, kind: 'threshold' }, { x, y: 0.4, z: zN - 2, kind: 'threshold' });
    lights.push({ x, y: 0.4, z: zS - 1, kind: 'end' }, { x, y: 0.4, z: zN + 1, kind: 'end' });
  }
  // Approach lighting: centreline bars every 30 m out to AIRPORT.approachLength, a crossbar at
  // 300 m, and sequenced flashers ("the rabbit") running toward the threshold.
  for (const [z0, dir] of [[zS, 1], [zN, -1]] as const) {
    const n = Math.floor(AIRPORT.approachLength / 30);
    for (let k = 1; k <= n; k++) {
      const z = z0 + dir * k * 30;
      for (let b = -2; b <= 2; b++) lights.push({ x: b * 1.2, y: 0.8, z, kind: 'approach' });
      lights.push({ x: 0, y: 1.2, z, kind: 'strobe', seq: n - k });
    }
    for (let b = -10; b <= 10; b++) lights.push({ x: b * 1.5, y: 0.8, z: z0 + dir * 300, kind: 'approach' });
  }
  // Taxiway: blue edge lights every 30 m along the parallel taxiway and its three connectors.
  const tx = AIRPORT.taxiwayX;
  const tw2 = AIRPORT.taxiwayWidth / 2;
  for (let z = zN - 20; z <= zS + 20; z += 30) for (const s of [-1, 1]) lights.push({ x: tx + s * (tw2 + 1), y: 0.3, z, kind: 'taxi' });
  for (const cz of [zS - 30, centerZ, zN + 30]) {
    for (let x = tx + tw2 + 6; x < -width / 2 - 4; x += 15) for (const s of [-1, 1]) lights.push({ x, y: 0.3, z: cz + s * (tw2 + 1), kind: 'taxi' });
  }

  // --- PAPI: four lights left of each touchdown zone, 3° glide slope (2.5 / 2.83 / 3.17 / 3.5°).
  const gs = AIRPORT.glideSlopeDeg;
  const papiAngles = [gs + 0.5, gs + 0.17, gs - 0.17, gs - 0.5];
  const papis: Papi[] = [
    { x: -(width / 2 + AIRPORT.papiOffset), z: zS - 300, dir: -1, lights: papiAngles.map((a, i) => ({ x: -(width / 2 + AIRPORT.papiOffset + i * 9), angle: a })) },
    { x: -(width / 2 + AIRPORT.papiOffset), z: zN + 300, dir: 1, lights: papiAngles.map((a, i) => ({ x: -(width / 2 + AIRPORT.papiOffset + i * 9), angle: a })) },
  ];

  return {
    pieces,
    lights,
    papis,
    windsock: { x: width / 2 + 40, z: zS - 120, height: 7 },
    beacon: { x: tw.x, y: tw.height + 22.5, z: tw.z },
  };
}
