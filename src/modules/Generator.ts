import * as THREE from 'three';
import type { GeneratorDef } from '../craft/types.ts';
import { Engine } from './Engine.ts';
import type { ForceModule } from './ForceModule.ts';

/**
 * Engine-driven generator/alternator with a voltage regulator. Output current is available
 * once the engine it is geared to (one on the same part, else the craft's first engine) spools
 * past `minRpmFraction`, reaching the rating 0.15 spool above that. The ElectricalSystem
 * decides how much of it the bus actually takes.
 */
export class Generator implements ForceModule {
  readonly type = 'generator';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  readonly def: GeneratorDef;
  engine: Engine | null = null;
  /** Failed (test hook, lightning, damage): no output until reset. */
  failed = false;
  /** Current delivered to the bus this step (A). */
  current = 0;

  constructor(
    readonly partId: string,
    def: GeneratorDef,
    position: THREE.Vector3,
  ) {
    this.def = def;
    this.localPosition = position;
  }

  link(modules: readonly ForceModule[]): void {
    const engines = modules.filter((m): m is Engine => m instanceof Engine);
    this.engine = engines.find((e) => e.partId === this.partId) ?? engines[0] ?? null;
  }

  /** Current the generator could deliver right now (A). */
  get available(): number {
    if (this.failed || !this.engine || this.engine.starved) return 0;
    const min = this.def.minRpmFraction ?? 0.2;
    return this.def.ratedAmps * Math.min(1, Math.max(0, (this.engine.spool - min) / 0.15));
  }

  reset(): void {
    this.failed = false;
    this.current = 0;
  }

  step(): void {}
}
