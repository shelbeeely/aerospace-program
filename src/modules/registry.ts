import * as THREE from 'three';
import type { ModuleDef, PartDef } from '../craft/types.ts';
import { AeroSurface } from './AeroSurface.ts';
import { Body } from './Body.ts';
import { Buoyancy } from './Buoyancy.ts';
import { Drag } from './Drag.ts';
import { Engine } from './Engine.ts';
import { FlightController } from './FlightController.ts';
import type { ForceModule } from './ForceModule.ts';
import { FuelTank } from './FuelTank.ts';
import { Rotor } from './Rotor.ts';
import { Wheel } from './Wheel.ts';

/**
 * Builds a force module from its JSON def. `position`/`rotation` are the module's
 * craft-local transform (part transform combined with the module's offset).
 * Add a case here when you add a new module type.
 */
export function createModule(
  part: PartDef,
  def: ModuleDef,
  position: THREE.Vector3,
  rotation: THREE.Quaternion,
): ForceModule {
  switch (def.type) {
    case 'aero': {
      // Which end of the surface is the tip? The end farther from the centreline.
      const outerSign = part.position[0] < -1e-3 ? -1 : 1;
      return new AeroSurface(part.id, def, position, rotation, outerSign);
    }
    case 'engine':
      return new Engine(part.id, def, position, rotation);
    case 'wheel':
      return new Wheel(part.id, def, position, rotation);
    case 'drag':
      return new Drag(part.id, def, position);
    case 'body':
      return new Body(part.id, def, position, rotation);
    case 'fuel':
      return new FuelTank(part.id, def, position);
    case 'buoyancy':
      return new Buoyancy(part.id, def, position);
    case 'rotor':
      return new Rotor(part.id, def, position, rotation);
    case 'flightController':
      return new FlightController(part.id, def, position);
    default: {
      const unknown: never = def;
      throw new Error(`Unknown module type: ${(unknown as { type: string }).type}`);
    }
  }
}

/**
 * Modules that read or command others (flight controllers) must run first in each step.
 * Lower = earlier.
 */
export function stepOrder(m: ForceModule): number {
  return m instanceof FlightController ? 0 : 1;
}
