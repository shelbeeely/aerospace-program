import * as THREE from 'three';
import { HAZARDS } from '../tuning.ts';
import type { PartDef } from '../craft/types.ts';

export interface PartFire {
  id: string;
  position: THREE.Vector3;
  radius: number;
  temperature: number;
  fuel: number;
  burning: boolean;
  /** kg of fuel burned this step, to deduct from real fuel tanks. */
  consumed: number;
}
function radius(p: PartDef): number {
  const s = p.shape;
  return s.type === 'box' ? Math.hypot(...s.size) / 2 : s.type === 'sphere' ? s.radius : Math.hypot(s.radius, s.length / 2);
}
/** Headless heat/fuel model. Finite combustible mass and cooling ensure every fire burns out.
 * Temperatures are °C, fuel kg. Heat propagation uses a snapshot so part order cannot matter. */
export class FireSystem {
  readonly parts = new Map<string, PartFire>();
  active = false;
  private readonly smokeOrigin = new THREE.Vector3();
  reset(parts: readonly PartDef[], tankFuel: ReadonlyMap<string, number> = new Map()): void {
    this.parts.clear(); this.active = false;
    for (const p of parts) this.parts.set(p.id, { id: p.id, position: new THREE.Vector3(...p.position), radius: radius(p), temperature: HAZARDS.ambientTemperature,
      fuel: tankFuel.get(p.id) ?? Math.min(5, p.mass * 0.04), burning: false, consumed: 0 });
  }
  ignite(id: string): boolean {
    const p = this.parts.get(id);
    if (!p || p.fuel <= 0) return false;
    p.temperature = Math.max(HAZARDS.flameTemperature, p.temperature); p.burning = true; this.active = true; return true;
  }
  strengthFactor(id: string): number {
    const t = this.parts.get(id)?.temperature ?? 20;
    return Math.max(0.12, 1 - Math.max(0, t - 150) / 800);
  }
  step(dt: number, attached: ReadonlySet<string>, tankFuel?: ReadonlyMap<string, number>): void {
    for (const id of this.parts.keys()) if (!attached.has(id)) this.parts.delete(id);
    const heat = new Map<string, number>();
    for (const p of this.parts.values()) {
      p.consumed = 0;
      const actualFuel = tankFuel?.get(p.id);
      if (actualFuel !== undefined) p.fuel = Math.min(p.fuel, actualFuel);
      if (p.fuel > 0 && p.temperature >= HAZARDS.ignitionTemperature) p.burning = true;
      if (!p.burning || p.fuel <= 0) { p.burning = false; continue; }
      p.consumed = Math.min(p.fuel, dt * Math.max(0.1, p.fuel / 10));
      p.fuel -= p.consumed;
      heat.set(p.id, (heat.get(p.id) ?? 0) + HAZARDS.heatRate);
      for (const q of this.parts.values()) {
        if (q === p || q.fuel <= 0) continue;
        const d = p.position.distanceTo(q.position);
        const reach = p.radius + q.radius + 0.6;
        if (d <= reach) heat.set(q.id, (heat.get(q.id) ?? 0) + HAZARDS.neighborHeatRate * (1 - 0.5 * d / reach));
      }
    }
    this.active = false;
    for (const p of this.parts.values()) {
      p.temperature = Math.min(HAZARDS.maximumTemperature, Math.max(HAZARDS.ambientTemperature, p.temperature + ((heat.get(p.id) ?? 0) - (p.temperature - HAZARDS.ambientTemperature) / HAZARDS.coolingTime) * dt));
      if (p.fuel <= 0) p.burning = false;
      if (p.burning || p.temperature > HAZARDS.ambientTemperature + 0.05) this.active = true;
    }
  }
  /** Buoyant smoke updraft, accumulated into an existing world-space wind vector. */
  addSmokeWind(point: THREE.Vector3, craftPosition: THREE.Vector3, craftRotation: THREE.Quaternion, out: THREE.Vector3): void {
    if (!this.active) return;
    const origin = this.smokeOrigin;
    for (const p of this.parts.values()) {
      if (!p.burning) continue;
      origin.copy(p.position).applyQuaternion(craftRotation).add(craftPosition);
      const h = point.y - origin.y;
      if (h < 0 || h > 80) continue;
      const r = 2 + h * 0.15;
      const d2 = (point.x - origin.x) ** 2 + (point.z - origin.z) ** 2;
      out.y += 3 * Math.exp(-d2 / (r * r)) * Math.exp(-h / 50);
    }
  }
}
