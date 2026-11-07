/** Static world layout shared by the simulation and the renderer. */
export const LAYOUT = {
  /** Ground is a square of this size (m), top surface at y = 0. */
  groundSize: 10_000,
  runway: {
    length: 1400,
    width: 30,
    /** Runway centre. The runway is aligned with the Z axis. */
    centerZ: -300,
  },
  /** Spawn: near the +Z threshold, facing -Z down the runway. */
  spawnZ: 360,
} as const;
