import * as THREE from 'three';
import type { AvionicsDef } from '../craft/types.ts';
import type { ForceModule } from './ForceModule.ts';

/** A constant-power electrical load (instruments, radios, flight computer, lights). */
export class Avionics implements ForceModule {
  readonly type = 'avionics';
  readonly localRotation = new THREE.Quaternion();
  readonly localPosition: THREE.Vector3;
  readonly def: AvionicsDef;
  readonly essential: boolean;
  /** Burnt out (electrical spike): draws nothing and never works again until reset. */
  failed = false;
  /** Load-shed because no generator is online (non-essential only). */
  shed = false;
  /** Has power this step. */
  powered = false;
  /** Spike energy absorbed so far (J). */
  spikeJ = 0;

  constructor(
    readonly partId: string,
    def: AvionicsDef,
    position: THREE.Vector3,
  ) {
    this.def = def;
    this.localPosition = position;
    this.essential = def.essential ?? true;
  }

  /** Power it wants from the bus (W). */
  get demand(): number {
    return this.failed || this.shed ? 0 : this.def.loadW;
  }

  reset(): void {
    this.failed = this.shed = false;
    this.powered = false;
    this.spikeJ = 0;
  }

  step(): void {}
}
