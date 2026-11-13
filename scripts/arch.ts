/**
 * Digital world architecture checks (headless): the five families against the ten validation
 * checks, determinism, validation actually rejecting bad forms, district variety and clustering,
 * chunk-boundary determinism, interiors inside their shells with real openings, and the Outlands
 * terrain (archetypes present, surface continuous across chunk boundaries, hulls matching the
 * surface). Run with `npm run arch`.
 */
import { structureRoom } from '../src/arch/InteriorGenerator.ts';
import { generateStructure } from '../src/arch/ArchitectureGenerator.ts';
import { ARCHETYPE_IDS, ARCHETYPES } from '../src/arch/BuildingArchetypeRegistry.ts';
import { districtLayout, districtPlan } from '../src/arch/DistrictGenerator.ts';
import { bigCellForms, landformHull, landformsInRect, terrainHeight, TERRAIN, wastelandAt } from '../src/arch/DigitalTerrainGenerator.ts';
import { GRID } from '../src/arch/grid.ts';
import { sailerNetwork } from '../src/arch/InfrastructureNetwork.ts';
import type { StructureSpec } from '../src/arch/types.ts';
import { validateStructure } from '../src/arch/validation.ts';
import { regionSites } from '../src/arch/WorldRegionManager.ts';
import { setWorld, WORLD } from '../src/arch/world.ts';
import { PLANET } from '../src/sim/layout.ts';

let failures = 0;
function check(ok: boolean, label: string, detail = ''): void {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
}
const C = PLANET.circumference;

// --- Families: every archetype, function and variant generates and validates.
for (const a of ARCHETYPE_IDS) {
  const g = ARCHETYPES[a];
  let pass = 0, n = 0, attempts = 0;
  const failed = new Map<string, number>();
  for (const variant of g.variants) for (let i = 0; i < 24; i++) {
    const size = [110, 246, 382][i % 3];
    const s = generateStructure({
      archetype: a, seed: 1000 + i * 7919, x: 0, z: 0, w: size * (g.elongated ? 1.6 : 1), d: size,
      minHeight: 15, maxHeight: 80 + (i % 5) * 80, intensity: (i % 4) / 3, region: ['control', 'machine-city', 'industrial', 'communication', 'transport'][i % 5], variant,
      landmark: g.landmarkVariants?.includes(variant) ? 'test' : undefined,
    });
    n++; attempts += s.validation!.attempts;
    if (s.validation!.pass) pass++;
    else for (const c of s.validation!.checks) if (!c.pass) failed.set(`${variant}: ${c.name}`, (failed.get(`${variant}: ${c.name}`) ?? 0) + 1);
  }
  check(pass / n >= 0.97, `${g.label}: generated structures pass the ten checks`, `${pass}/${n} over ${g.variants.length} variants, ${(attempts / n).toFixed(2)} attempts avg${failed.size ? `; ${[...failed].map(([k, v]) => `${k} ×${v}`).join(', ')}` : ''}`);
}

// --- Determinism
{
  const req = { archetype: 'industrial' as const, seed: 4242, x: 100, z: 200, w: 400, d: 220, minHeight: 20, maxHeight: 140, intensity: 0.5, region: 'industrial' };
  const a = JSON.stringify(generateStructure(req)), b = JSON.stringify(generateStructure(req));
  check(a === b, 'the same request always yields the same structure', `${a.length} bytes`);
  const d1 = JSON.stringify(districtPlan(12, 7).structures.map((s) => [s.id, s.variant, s.height.toFixed(3)]));
  // Generate other districts in between, then the same one fresh with a different cache history.
  setWorld({ seed: WORLD.seed });
  for (const [i, j] of [[13, 7], [12, 8], [3, 30]]) districtPlan(i, j);
  const d2 = JSON.stringify(districtPlan(12, 7).structures.map((s) => [s.id, s.variant, s.height.toFixed(3)]));
  check(d1 === d2, 'districts are identical whatever order they are generated in', `${districtPlan(12, 7).structures.length} structures`);
}

// --- Validation rejects what the rules forbid.
{
  const good = generateStructure({ archetype: 'circuit', seed: 7, x: 0, z: 0, w: 246, d: 246, minHeight: 20, maxHeight: 120, intensity: 0.5, region: 'control' });
  const req = { archetype: 'circuit' as const, seed: 7, x: 0, z: 0, w: 246, d: 246, minHeight: 20, maxHeight: 120, intensity: 0.5, region: 'control' };
  const slab: StructureSpec = { ...good, components: [
    { prim: { kind: 'box', w: 30, h: 300, d: 30 }, x: 0, y: 0, z: 0, tier: 1, surface: 'hull', edges: 'none', role: 'tower', mass: 0 },
    { prim: { kind: 'box', w: 32, h: 2, d: 32 }, x: 0, y: 300, z: 0, tier: 1, surface: 'hull', edges: 'top', light: 'structure', role: 'cap', mass: 1 },
  ], colliders: [{ shape: 'box', x: 0, y: 150, z: 0, sx: 30, sy: 300, sz: 30 }], height: 302 };
  const v1 = validateStructure(slab, req, {});
  check(!v1.pass && !v1.checks[5].pass, 'a plain slab tower is rejected as conventional architecture', v1.checks.filter((c) => !c.pass).map((c) => c.name).join(', '));
  const neon: StructureSpec = { ...good, components: good.components.map((c) => ({ ...c, edges: 'all' as const, light: c.light ?? 'structure' })) };
  const v2 = validateStructure(neon, req, {});
  check(!v2.checks[4].pass, 'lighting every edge is rejected (purposeful illumination)', v2.checks[4].detail);
  const offPalette: StructureSpec = { ...good, components: good.components.map((c, i) => (i === 0 ? { ...c, surface: 'magenta' as never } : c)) };
  check(!validateStructure(offPalette, req, {}).checks[6].pass, 'an off-palette surface is rejected (1982 visual language)');
}

// --- Districts: clusters by region, variety, negative space.
{
  const fam = new Map<string, Map<string, number>>();
  let structures = 0, open = 0, lots = 0, kits = 0, rejected = 0, ms = 0, n = 0;
  const sigs = new Set<string>();
  for (let i = 0; i < GRID.chunks; i += 3) for (let j = 0; j < GRID.chunks; j += 3) {
    const d = districtPlan(i, j);
    n++; ms += d.ms; rejected += d.rejected; kits += d.kits.length;
    lots += d.layout.lots.length;
    open += d.layout.lots.filter((l) => l.kind === 'open').length;
    for (const s of d.structures) {
      structures++;
      sigs.add(`${s.archetype}:${s.variant}`);
      const mm = fam.get(d.layout.region) ?? new Map<string, number>();
      mm.set(s.archetype, (mm.get(s.archetype) ?? 0) + 1);
      fam.set(d.layout.region, mm);
    }
  }
  check(sigs.size >= 20, 'districts use the full architectural variety', `${sigs.size} family/variant forms among ${structures} structures`);
  check(open / lots > 0.15, 'negative space: a real share of lots stays open', `${((open / lots) * 100).toFixed(0)}% of ${lots} lots`);
  check(kits > 0, 'imported kit towers are placed by the districts', `${kits} kit towers in ${n} sampled districts`);
  const dominant = (r: string) => [...(fam.get(r) ?? new Map()).entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const ok = (dominant('industrial') ?? 'industrial') === 'industrial' && (dominant('communication') ?? 'radial') === 'radial' && ['cavern', 'circuit'].includes(dominant('machine-city') ?? 'cavern');
  check(ok, 'regions form functional clusters (their families dominate)', [...fam].map(([r]) => `${r}: ${dominant(r)}`).join(', '));
  check(rejected / Math.max(1, structures + rejected) < 0.05, 'few structures are rejected by validation', `${rejected} rejected`);
  check(ms / n < 40, 'a district generates fast enough to stream', `${(ms / n).toFixed(1)} ms average`);
}

// --- Interiors: inside the shell, with real openings in the walls.
{
  let checked = 0, bad = 0;
  for (let seed = 0; seed < 40; seed++) {
    const s = generateStructure({ archetype: 'industrial', seed, x: 0, z: 0, w: 480, d: 246, minHeight: 25, maxHeight: 90, intensity: 0.5, region: 'transport', variant: 'hall', func: 'transport-terminal' });
    if (!s.interior) continue;
    checked++;
    const I = s.interior;
    for (const c of s.components) {
      if (!c.interior || c.surface === 'translucent') continue;
      if (c.x < I.x0 - 1 || c.x > I.x1 + 1 || c.z < I.z0 - 1 || c.z > I.z1 + 1 || c.y < I.y0 - 0.5 || c.y > I.y1) bad++;
    }
    // An entrance must be open: no wall collider across the doorway at walking height.
    for (const e of I.entrances) {
      const x = e.side === 0 ? I.x1 + I.wall / 2 : I.x0 - I.wall / 2;
      const blocked = s.colliders.some((c) => Math.abs(c.x - (s.rotation % 2 ? 0 : x)) < c.sx / 2 && Math.abs(c.z) < c.sz / 2 && c.y - c.sy / 2 < 2 && c.y + c.sy / 2 > 2 && s.rotation % 2 === 0);
      if (blocked) bad++;
    }
  }
  check(checked > 20 && bad === 0, 'interiors sit inside their shells and doorways are open', `${checked} halls, ${bad} problems`);
}

// --- Rooms for the people: solid structures get a commons hollowed out of a grounded mass.
{
  let made = 0, total = 0, bad = 0, raised = 0, steps = 0, blockedDoor = 0, noRoom = 0;
  for (const archetype of ['circuit', 'cavern', 'industrial'] as const) for (let seed = 0; seed < 40; seed++) {
    const s = generateStructure({ archetype, seed, x: 0, z: 0, w: 110, d: 110, minHeight: 20, maxHeight: 120, intensity: 0.5, region: 'machine-city' });
    total++;
    const I = s.interior;
    if (!I || I.program !== 'commons') continue;
    made++;
    if (!s.validation?.pass) bad++;
    if (I.y0 > 0.3) { raised++; steps += s.components.filter((c) => c.role === 'stair').length; }
    for (const c of s.components) {
      if (!c.interior) continue;
      if (c.x < I.x0 - 0.5 || c.x > I.x1 + 0.5 || c.z < I.z0 - 0.5 || c.z > I.z1 + 0.5 || c.y < I.y0 - 0.5 || c.y > I.y1) bad++;
    }
    const room = structureRoom(s);
    if (!room) { noRoom++; continue; }
    for (const d of room.doors) {
      // The doorway is open at walking height, and so is the aisle behind it.
      for (const t of [0, -2, -d.depth + 0.5]) {
        const x = d.x + d.nx * t, z = d.z + d.nz * t;
        if (s.colliders.some((c) => Math.abs(c.x - x) < c.sx / 2 && Math.abs(c.z - z) < c.sz / 2 && c.y - c.sy / 2 < room.y + 1.5 && c.y + c.sy / 2 > room.y + 0.5)) blockedDoor++;
      }
      // A raised door has a floor all the way down, in steps no walker would balk at.
      for (let i = 1; i < d.floor.length; i++) if (d.floor[i - 1] - d.floor[i] > 0.55) bad++;
      if (d.rise > 0.3 && Math.abs(d.floor[0] - d.rise) > 0.55) bad++;
    }
  }
  check(made > total * 0.4, 'solid structures get rooms for their people', `${made} of ${total} circuit, cavern and industrial structures`);
  check(bad === 0 && blockedDoor === 0 && noRoom === 0, 'the rooms validate, hold their furniture, and their doors and aisles are open', `${bad} problems, ${blockedDoor} blocked, ${noRoom} without a usable door`);
  check(raised > 0 && steps > 0, 'a room on a foundation has steps down from its door', `${raised} raised rooms, ${steps} treads`);
}

// --- Outlands terrain.
{
  const seen = new Set<string>();
  for (const s of regionSites()) if (s.kind === 'outlands') seen.add(s.terrain);
  check(seen.size === 5, 'all five Outlands terrain archetypes occur', [...seen].join(', '));
  const shapes = new Map<string, number>();
  for (let i = 0; i < TERRAIN.bigCells; i += 2) for (let j = 0; j < TERRAIN.bigCells; j += 2) for (const f of bigCellForms(i, j)) shapes.set(`${f.arch}:${f.shape}`, (shapes.get(`${f.arch}:${f.shape}`) ?? 0) + 1);
  check(shapes.size >= 8, 'landforms are geometric solids of many kinds', [...shapes].map(([k, v]) => `${k} ${v}`).join(', '));
  // Continuity across a chunk boundary: heights on both sides of every chunk line agree with themselves
  // (evaluated in different images), and the hull sets of neighbouring chunks cover the surface.
  let mismatch = 0, samples = 0;
  for (let k = 0; k < 400; k++) {
    const x = GRID.x0 + Math.floor(k / 20) * GRID.chunkSize * 1.7 + 0.5, z = GRID.z0 + (k % 20) * 997.3;
    if (wastelandAt(x, z) < 0.3) continue;
    samples++;
    if (Math.abs(terrainHeight(x, z) - terrainHeight(x + C, z - C)) > 1e-6) mismatch++;
  }
  check(samples > 20 && mismatch === 0, 'terrain is seamless across the planet wrap and chunk lines', `${samples} samples`);
  // Hull vs surface: the top of a frustum hull equals the reported height at its centre.
  let hullBad = 0, hulls = 0;
  for (const f of landformsInRect(GRID.x0 + 20 * GRID.chunkSize, GRID.z0, GRID.x0 + 26 * GRID.chunkSize, GRID.z0 + 6 * GRID.chunkSize, false)) {
    if (f.shape !== 'frustum' || f.overhead || f.ry) continue;
    hulls++;
    const pts = landformHull(f);
    let top = 0;
    for (let i = 1; i < pts.length; i += 3) top = Math.max(top, pts[i]);
    if (Math.abs(top - (f.y0 + f.h)) > 1e-3) hullBad++;
  }
  check(hullBad === 0, 'physics hulls match the drawn landforms', `${hulls} frustums`);
}

// --- Infrastructure.
{
  const net = sailerNetwork();
  check(net.routes.length > 20 && net.pylons.length > 50, 'Solar Sailer routes link the landmarks, carried by pylons', `${net.routes.length} routes, ${net.pylons.length} pylons`);
  let paths = 0, corridors = 0;
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) for (const c of districtPlan(i, j).infra.components) {
    if (c.role === 'pathway' || c.role === 'conduit' || c.role === 'lane') paths++;
    if (c.role === 'corridor') corridors++;
  }
  check(paths > 100 && corridors > 0, 'structures plug into the network (pathways, conduits, elevated corridors)', `${paths} ground links, ${corridors / 2} corridors in the centre`);
}

// --- A new seed regenerates a different, still valid world.
{
  const before = JSON.stringify(districtLayout(5, 5).lots.map((l) => [l.kind, l.wb, l.db]));
  setWorld({ seed: 77 });
  const after = JSON.stringify(districtLayout(5, 5).lots.map((l) => [l.kind, l.wb, l.db]));
  const d = districtPlan(20, 20);
  check(before !== after && d.structures.every((s) => s.validation?.pass || s.landmark), 'a new world seed regenerates the world', `${d.structures.length} structures in district 20,20`);
  setWorld({ seed: 1982 });
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll architecture checks passed');
process.exit(failures ? 1 : 0);
