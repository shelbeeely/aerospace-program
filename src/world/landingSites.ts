import { districtPlan } from '../arch/DistrictGenerator.ts';
import { GRID } from '../arch/grid.ts';
import { CITY, GROUND_HELIPADS, RUNWAYS, type LandingSite } from '../sim/layout.ts';
import { worldStructures } from './structures.ts';

let cached: LandingSite[] | null = null;

/**
 * Every place to land: the runways, the street-level helipads, and rooftop helipads on the flat
 * roofs the architecture generator marks (two near each central hub, picked deterministically).
 * A rooftop pad belongs to its structure's group and is unusable while it is fractured.
 */
export function landingSites(): LandingSite[] {
  if (cached) return cached;
  const ws = worldStructures();
  const groupOf = new Map<string, number>();
  for (const g of ws.groups) if (g.arch) groupOf.set(g.arch, g.id);
  const roofs: Array<{ x: number; z: number; y: number; group: number; r: number }> = [];
  const nx = Math.ceil(GRID.centralX / GRID.chunkBlocks), nz = Math.ceil(GRID.centralZ / GRID.chunkBlocks);
  for (let ci = 0; ci < nx; ci++) for (let cj = 0; cj < nz; cj++) {
    const d = districtPlan(ci, cj);
    d.structures.forEach((s, i) => {
      if (!d.lots[i].central || !s.roof) return;
      const group = groupOf.get(s.id);
      if (group === undefined) return;
      const { x, y, z, r } = s.roof;
      if (r < 9 || y < 30 || y > 260) return;
      roofs.push({ x, z, y, group, r });
    });
  }
  const names = ['Downtown', 'Southwest', 'South', 'Northwest', 'Northeast'];
  const rooftop: LandingSite[] = [];
  CITY.hubs.forEach((hub, h) => {
    const near = roofs
      .map((r) => ({ r, d: Math.hypot(r.x - hub.x, r.z - hub.z) }))
      .filter((c) => c.d < hub.r * 1.2)
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
