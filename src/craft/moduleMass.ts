import type { ModuleDef, PartDef, WeaponModuleDef } from './types.ts';

const G = 9.81;

/**
 * Modules are massless: a part's `mass` covers everything on it. These floors keep that honest:
 * the least a part can weigh for what it carries, from real power-to-weight figures (generous,
 * so ordinary designs never hit them). The design pipeline raises a part that is lighter
 * (autoFix) and says so.
 */
export function moduleMinMass(m: ModuleDef): { kg: number; why: string } | null {
  switch (m.type) {
    case 'engine': {
      const t = m.maxThrust;
      switch (m.kind) {
        case 'rocket': return { kg: t / (G * 100), why: `${(t / 1000).toFixed(1)} kN rocket (thrust/weight ≤ 100)` };
        case 'solid': {
          // The propellant is in the casing: T·burnTime/(isp·g0), plus ~15% for the case.
          const prop = (t * (m.burnTime ?? 20)) / ((m.isp ?? 250) * G);
          return { kg: prop * 1.15, why: `${(t / 1000).toFixed(1)} kN solid booster burning ${m.burnTime ?? 20} s carries ${Math.round(prop)} kg of propellant` };
        }
        case 'ramjet': return { kg: t / (G * 15), why: `${(t / 1000).toFixed(1)} kN ramjet (thrust/weight ≤ 15)` };
        case 'scramjet': return { kg: t / (G * 10), why: `${(t / 1000).toFixed(1)} kN scramjet (thrust/weight ≤ 10)` };
        case 'prop': return { kg: t / (G * 4), why: `${(t / 1000).toFixed(1)} kN propeller engine (thrust/weight ≤ 4)` };
        default:
          if (m.kind === 'turbofan' || m.kind === 'turbojet' || m.propMaxSpeed === undefined) return { kg: t / (G * 8), why: `${(t / 1000).toFixed(1)} kN jet (thrust/weight ≤ 8)` };
          return { kg: t / (G * 4), why: `${(t / 1000).toFixed(1)} kN propeller engine (thrust/weight ≤ 4)` };
      }
    }
    case 'battery': {
      const wh = m.cells * m.cellVmax * m.capacityAh;
      return { kg: wh / 250, why: `${Math.round(wh)} Wh battery (≤ 250 Wh/kg)` };
    }
    case 'airbrake': return { kg: m.area * 4, why: `${m.area} m² airbrake` };
    case 'weapon': {
      // The weapon plus its rounds (a bomb bay is mostly bombs).
      const per: Record<WeaponModuleDef['kind'], [number, number, number]> = {
        // [weapon kg, kg per round, default rounds]
        gun: [40, 0.05, 600], cannon: [150, 12, 40], missile: [30, 60, 6], bomb: [60, 250, 8], laser: [60, 0, 240], disc: [25, 4, 12], pulse: [80, 1, 60],
      };
      const [w, r, n] = per[m.kind];
      const rounds = m.ammo ?? n;
      return { kg: w + r * rounds, why: `${m.kind} with ${rounds} rounds` };
    }
    case 'chute': return { kg: m.cdA * 0.15, why: `drag chute (cdA ${m.cdA} m²)` };
    default: return null;
  }
}

/** The least this part can weigh for its modules, with the reasons (empty when it has none). */
export function partMinMass(p: PartDef): { kg: number; reasons: string[] } {
  let kg = 0;
  const reasons: string[] = [];
  for (const m of p.modules ?? []) {
    const r = moduleMinMass(m);
    if (!r) continue;
    kg += r.kg;
    reasons.push(r.why);
  }
  return { kg, reasons };
}
