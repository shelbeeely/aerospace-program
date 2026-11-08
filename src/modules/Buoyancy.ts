import * as THREE from 'three';
import type { BuoyancyDef } from '../craft/types.ts';
import { TUNING } from '../tuning.ts';
import type { ForceModule, StepContext } from './ForceModule.ts';

/** Gas density as a fraction of the surrounding air's (both scale with pressure). */
const GAS_RATIO: Record<NonNullable<BuoyancyDef['gas']>, number> = {
  hydrogen: 0.07,
  helium: 0.138,
  'hot-air': 0.75, // ~100 °C envelope
};

const _p = new THREE.Vector3();
const _f = new THREE.Vector3();

/**
 * Archimedes: a gas cell displaces air, so it's pushed up by (air density - gas density) ×
 * volume × g. Thinner air aloft means less lift, so blimps find a ceiling on their own.
 */
export class Buoyancy implements ForceModule {
  readonly type = 'buoyancy';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  lift = 0;

  constructor(
    readonly partId: string,
    readonly def: BuoyancyDef,
    position: THREE.Vector3,
  ) {
    this.localPosition = position;
  }

  /** Net lift (N) at sea level, for design analysis. */
  seaLevelLift(): number {
    return TUNING.seaLevelDensity * (1 - GAS_RATIO[this.def.gas ?? 'helium']) * this.def.volume * TUNING.gravity;
  }

  reset(): void {
    this.lift = 0;
  }

  step(ctx: StepContext): void {
    ctx.toWorldPoint(this.localPosition, _p);
    const rho = ctx.airDensity(_p.y);
    this.lift = rho * (1 - GAS_RATIO[this.def.gas ?? 'helium']) * this.def.volume * TUNING.gravity;
    _f.set(0, this.lift, 0);
    ctx.applyForce('buoyancy', _f, _p);
  }
}
