import { CITY, GROUND_HELIPADS, RUNWAYS, type LandingSite } from '../sim/layout.ts';
import { cityPlan } from './City.ts';
import { worldStructures } from './structures.ts';

let cached: LandingSite[] | null = null;

/**
 * Every place to land: the runways, the street-level helipads, and rooftop helipads on flat-
 * topped towers (two near each downtown hub, picked deterministically from the city plan).
 * A rooftop pad belongs to its tower's structure group and is unusable while it is fractured.
 */
export function landingSites(): LandingSite[] {
  if (cached) return cached;
  const ws = worldStructures();
  const spires = cityPlan().spires;
  const roofs: Array<{ x: number; z: number; y: number; group: number; r: number }> = [];
  for (const g of ws.groups) {
    if (!g.name.startsWith('city:') || g.kit) continue;
    let top = null as (typeof ws.list)[number] | null;
    for (const i of g.pieces) {
      const p = ws.list[i];
      if (!top || p.y + p.sy / 2 > top.y + top.sy / 2) top = p;
    }
    if (!top || top.shape !== 'box') continue;
    const y = top.y + top.sy / 2;
    const r = Math.min(top.sx, top.sz) / 2;
    if (r < 9 || y < 50 || y > 260) continue;
    if (spires.some((s) => Math.abs(s.x - top!.x) < top!.sx / 2 && Math.abs(s.z - top!.z) < top!.sz / 2)) continue;
    roofs.push({ x: top.x, z: top.z, y, group: g.id, r });
  }
  const names = ['Downtown', 'Southwest', 'South', 'Northwest', 'Northeast'];
  const rooftop: LandingSite[] = [];
  CITY.hubs.forEach((hub, h) => {
    const near = roofs
      .map((r) => ({ r, d: Math.hypot(r.x - hub.x, r.z - hub.z) }))
      .filter((c) => c.d < hub.r * 0.8)
      .sort((a, b) => a.d - b.d);
    const picked: typeof roofs = [];
    for (const c of near) {
      if (picked.length >= 2) break;
      if (picked.some((p) => Math.hypot(p.x - c.r.x, p.z - c.r.z) < 250)) continue;
      picked.push(c.r);
    }
    picked.forEach((r, k) => rooftop.push({
      id: `roof-${h}-${k}`, name: `${names[h] ?? `Hub ${h + 1}`} Rooftop ${k + 1}`, kind: 'helipad',
      x: r.x, z: r.z, y: r.y, axis: 'z', length: 0, width: Math.min(10, r.r - 1), group: r.group,
    }));
  });
  cached = [...RUNWAYS, ...GROUND_HELIPADS, ...rooftop];
  return cached;
}

export function landingSite(id: string): LandingSite | undefined {
  return landingSites().find((s) => s.id === id);
}
