/**
 * Terrain for the simulation: the Outlands' geometric landforms (src/arch/DigitalTerrainGenerator.ts).
 * Kept as the sim-facing module so physics, autopilot, trails and spawn logic import one place.
 *
 * - terrainHeight: the ground surface underfoot (overhead roof slabs and orbs excluded);
 * - terrainTop: the highest solid surface (obstacle clearance, overhangs included);
 * - solidHulls: one convex hull per landform, whose union is exactly the drawn terrain.
 */
export {
  chunkHasTerrain, highwayDistance, landformsInRect, nearWasteland, OUTLANDS, solidHulls, TERRAIN, terrainHeight, terrainTop,
  wastelandAt, wastelandByte, wastelandMask,
} from '../arch/DigitalTerrainGenerator.ts';
