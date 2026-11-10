import { CircuitBlockGenerator } from './generators/CircuitBlockGenerator.ts';
import type { FamilyGenerator } from './generators/common.ts';
import { ElectronicCavernGenerator } from './generators/ElectronicCavernGenerator.ts';
import { IndustrialMegastructureGenerator } from './generators/IndustrialMegastructureGenerator.ts';
import { ProcessingTowerGenerator } from './generators/ProcessingTowerGenerator.ts';
import { RadialStructureGenerator } from './generators/RadialStructureGenerator.ts';
import type { ArchetypeId } from './types.ts';

/**
 * Every architectural family the world can build, by id. A family is a generator plus its
 * metadata: computational functions, silhouette variants, tunable parameters, lot preferences
 * and the book pages its language comes from. Adding a family = one generator registered here.
 */
export const ARCHETYPES: Record<ArchetypeId, FamilyGenerator> = {
  circuit: CircuitBlockGenerator,
  tower: ProcessingTowerGenerator,
  industrial: IndustrialMegastructureGenerator,
  cavern: ElectronicCavernGenerator,
  radial: RadialStructureGenerator,
};

export const ARCHETYPE_IDS = Object.keys(ARCHETYPES) as ArchetypeId[];

export function archetype(id: ArchetypeId): FamilyGenerator {
  const g = ARCHETYPES[id];
  if (!g) throw new Error(`unknown archetype ${id}`);
  return g;
}

/** Which family builds a function (functions are unique across families). */
export function archetypeForFunction(func: string): ArchetypeId | null {
  for (const id of ARCHETYPE_IDS) if (ARCHETYPES[id].functions.includes(func)) return id;
  return null;
}
