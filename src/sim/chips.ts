/**
 * Visual voxel chips: small glowing cubes knocked off buildings and aircraft by impacts. The
 * simulation only emits bursts (pure data, works headless); the renderer (ChipsView) flies,
 * bounces and fades them. They do not collide with anything (cheap: thousands per crash).
 */
export interface ChipBurst {
  /** Where the chips start (m) and how widely they scatter around it. */
  x: number;
  y: number;
  z: number;
  radius: number;
  /** Carried velocity (the impactor's share, m/s) and the outward burst speed (m/s). */
  vx: number;
  vy: number;
  vz: number;
  speed: number;
  count: number;
  /** Chip edge (m). */
  size: number;
  color: string;
  /** Derez voxels: they stay where they land, scattered on the Grid like broken glass. */
  persist?: boolean;
  /** Energy splash (fast-moving derez): droplets erupt from the grid at (x, y, z), the impact site,
   *  on parabolic arcs under gravity and dissipate where they land back on the grid. */
  splash?: boolean;
  seq: number;
}

export class ChipEmitter {
  readonly bursts: ChipBurst[] = [];
  seq = 0;
  /** Total chips emitted since the last reset (tests, stats). */
  total = 0;

  emit(b: Omit<ChipBurst, 'seq'>): void {
    if (b.count <= 0) return;
    this.bursts.push({ ...b, seq: ++this.seq });
    this.total += b.count;
    if (this.bursts.length > 512) this.bursts.splice(0, this.bursts.length - 512);
  }

  reset(): void {
    this.bursts.length = 0;
    this.total = 0;
  }
}
