# Digital World: architectural grammar and generation parameters

Technical documentation of the procedural world. The rules it implements are in
[AGENTS.md](../AGENTS.md); this document explains how.

```
src/arch/                      generation (pure data: no three.js scene objects, no DOM)
  world.ts                     WORLD config (seed, region lattice, blend width), cache reset
  rng.ts                       hash32 / Rng: everything derives from (seed, lattice indices)
  palette.ts                   surfaces, light roles, patterns, activity states (the 1982 palette)
  types.ts                     Primitive, Component, ColliderPiece, StructureSpec, GenRequest…
  grammar.ts                   Builder: primitives → components + axis-aligned colliders
  generators/*.ts              the five families (FamilyGenerator)
  BuildingArchetypeRegistry.ts archetype id → generator
  ArchitectureGenerator.ts     request → validated StructureSpec (regenerate on failure)
  validation.ts                the ten architectural checks
  InteriorGenerator.ts         hollow shells with real openings + interior programmes
  WorldRegionManager.ts        regions (sites, profiles, blending, atmosphere)
  DistrictGenerator.ts         district = chunk: lot layout, structures, kit towers, infrastructure
  InfrastructureNetwork.ts     pathways, elevated corridors, Solar Sailer routes and pylons
  DigitalTerrainGenerator.ts   the Outlands (landform lattices, heights, hulls, landmarks)
src/render/arch/               rendering
  ArchitectureMeshBuilder.ts   components → merged geometry with per-edge glow, LODs
  ArchitecturalMaterialLibrary.ts  the shader (painted shading, patterns, edges, states)
  BuildingLightingController.ts    per-structure activity state texture
  DigitalWorldView.ts          district streaming, LOD, curvature-aware culling, fractures
  TerrainView.ts               Outlands landform streaming
  InfrastructureView.ts        Solar Sailer beams
  SkyAtmosphere.ts             painted sky, region-driven atmosphere
src/render/cityGround.ts       the electronic ground (circuit substrate, channels, highways)
src/sim/roadRules.ts, roads.ts, groundPilot.ts   road network, routing, ground driving
src/ui/ArchitectureDebugPanel.ts                 debug interface (explorer + in-game, K)
explore.html, src/explore/main.ts                Digital World Explorer
```

## Hierarchy

**World → Region → District → Structure → Component** (Outlands: World → Region → Terrain
chunk → Landform → Structure).

- **World:** `WORLD.seed` (default 1982). Every procedural decision is `hash32(seed, …indices)`
  or an `Rng` seeded from one, so any district, cell or structure regenerates alone, in any
  order. `setWorld({ seed, transition })` changes the world and clears every derived cache.
- **Region:** a jittered 12 × 12 lattice of sites (~4.2 km). Each site is civilised (one of seven
  identities) or Outlands (one of five terrain archetypes); sea sites follow the ocean band.
  Sites near hubs, airfields and the centre are always civilised. A point blends its nearest
  three sites over `WORLD.transition` metres (transitional regions). Each identity has a
  `RegionProfile`: family weights, open-space share, lot sizes, height band and atmosphere.
- **District:** one planet chunk (10 × 10 blocks, ~1.36 km). Lots of 1–4 blocks each way are
  laid out on the block lattice (never across a data highway; a lot covers the minor streets
  inside it). Each lot is a structure, a landmark (hub blocks), an imported kit tower, or
  negative space.
- **Structure:** a `StructureSpec` from a family generator, validated.
- **Component:** one primitive with its tier, surface, edge mode, light role and pattern.

| Region | Families (weight) | Open | Heights (m) |
| --- | --- | --- | --- |
| Monumental control centre | tower 4, radial 2.5, circuit 1.5, industrial 0.6 | 40% | 40–420 |
| Dense machine city | cavern 4, circuit 3, tower 0.8, radial 0.4 | 12% | 30–240 |
| Industrial processing zone | industrial 5, circuit 1.5, cavern 0.6, tower 0.5 | 22% | 20–160 |
| Communication district | radial 5, tower 1.5, circuit 1 | 35% | 30–300 |
| Transportation network | industrial 3, radial 2.5, circuit 1.5 | 30% | 20–180 |
| Open computational plain | circuit 3, radial 1, tower 0.6 | 70% | 12–90 |
| Electronic caverns | cavern 6, circuit 1, industrial 0.5 | 15% | 40–260 |

Heights rise with hub monumentality and are hard-capped by the airport obstacle zoning
(structures regenerate lower until every solid fits, or the lot stays open). Kit towers take a
share of single and double lots in the dense regions (22% machine city, 14% control/transport).

## The grammar

Primitives (`types.ts`): `box` (optionally tapered to a pyramid frustum), `prism` (n-sided:
cylinders, polygonal cores, cones, truncated and flared columns), `lathe` (revolved profile:
trumpet flares, stepped radial platforms), `ring` (annulus or arc), `torus`, `extrude` (custom
outline), `sweep` (section along a path, per-point scale), `frustum`, `dome`, `sphere`.

Hierarchy: tier 1 primary masses (2–5 per structure, grouped by `mass` id), tier 2 secondary
(platforms, columns, supports, connectors), tier 3 tertiary (seams, channels, pins, lit detail;
never colliders, never silhouette-changing). The `Builder` snaps dimensions to 0.5 m, assigns
colliders for tiers 1–2 (boxes, drums, cones; rings as box segments) and records connection
points (data, energy, transport, bridge).

Edge modes: `none`, `top`, `base`, `rims`, `silhouette`, `horizontal`, `all`. Light roles:
structure (cyan), data (blue), energy (white), entrance (amber), process (orange), warning (red).
Patterns (shader-drawn): panels, grid, flutes, circuit, skylight.

## The five families

| Family | Variants | Functions | Book |
| --- | --- | --- | --- |
| Circuit-board | memory, router, array, bus, stepped | memory-storage, data-router, processing-array, system-bus, cache-bank | 12–16, 39–40 |
| Processing tower | control, trumpet, stack, pylon, spire, suspended | central-processor, control-tower, compute-core, arithmetic-unit, scheduler | 13–16, 40, 60–62 |
| Industrial | hall, carrier, gantry, stepped | transport-terminal, carrier-dock, processing-facility, assembly-hall, power-plant | 35–38, 53 |
| Electronic cavern | shaft, terrace, lattice | machine-city-block, data-warehouse, io-buffer, cache-stack, interconnect | 39 |
| Radial | io, stepped, dish, distributor, hub, rings | io-tower, comm-node, energy-distributor, transit-hub, beacon | 10, 16, 39, 53–58 |

Parameters per family (all editable in the lab; defaults drawn per seed):

- **Circuit:** coverage, foundation, height, subdivisions, steps, channelGlow, seamEvery.
- **Tower:** height, base, flare, taper, sides (6/8/12/32), platforms, halos.
- **Industrial:** length, width, height, bay, pylonDepth, portal.
- **Cavern:** cells, height, levels, overhang, bridges, canopy.
- **Radial:** height, rings, spokes, elevation, core, beam.

The `control` tower variant (the fluted drum on a sawtooth mesa with a sky beam) is reserved
mostly for landmarks. Hub landmarks: the main hub is the Grid Spire (a trumpet tower, ~490 m).
Outlands landmarks follow their terrain: control cylinder on a mesa in the canyons, needle
spires in the Sea of Simulation, stepped I/O tiers in the wastelands, floating rings on the
grid flats, a shaft complex in the mechanical caverns.

## Interiors

Industrial halls and some stepped circuit blocks are hollow. `shellWalls` builds the walls with
real openings for every entrance (lit portal frames) and a roof; `furnishInterior` fills the
inner volume: `hall` (structural bays of columns and ceiling beams, a lit nave, elevated
walkways with a ramp, a light shaft, a dais with machinery), `chamber` (a central machine,
radial channels, a ring walkway) or `shaft` (ring walkways at several levels). Interior parts
draw at LOD 0 only and always collide, so vehicles and walkers can go in.

**Rooms for the people.** A structure generated solid is given a `commons` by `inhabit`: the
largest box mass standing on the ground, or on a foundation up to 6.5 m high, with nothing
else inside it and at least 14 × 14 × 5.5 m, is replaced by a shell of the same surface, tier and
role, with up to two doors (an opposite pair when possible). A side gets a door only if the
strip from the wall to the lot edge is clear above the threshold; ledges below it get a flight
of steps (0.5 m risers). The commons has terminal banks along the walls, memory columns in the
quarters, a meeting ring under a halo, and aisles kept clear from each door. If the hollowed
structure fails validation it is rebuilt solid. `structureRoom` gives the people (`src/sim/bits.ts`)
each door in world space with the depth of its clear aisle and the floor profile outside it.
A low slab that qualifies (the foundation of a circuit structure) becomes an undercroft: when
the room is wider than 44 m a grid of plain columns carries the slab, clear of the aisles.

**Round rooms.** `inhabitRound` does the same for a solid prism of near-constant radius (at
least 9 m, sides ≥ 6): its foot (all of a drum up to 10 m, the first 8 m of a taller one) is
rebuilt as arcs of `ring` wall between the doorways, a lintel over each, a roof disc, and the
rest of the prism above. Doors face the four axes. The wall's colliders are laid by hand (16
boxes round the ring, left out at the doorways, with a jamb box each side) so the openings are
exact. The room is furnished as a `chamber`; `InteriorConfig.round` carries its centre and
inner radius.

620 of 997 sampled structures have a room (circuit 310 of 450, cavern 142 of 173, industrial
104 of 162, tower 64 of 116, radial 0 of 96). Strongly tapered and curved bases (trumpet
flares, pyramid spires) and the radial structures are not hollowed.

## Validation (the ten checks)

1. **Silhouette:** 2–5 primary masses owning ≥ 20% of the primary+secondary surface.
2. **Function:** a known function with its required elements (roles and counts).
3. **Family:** a registered archetype and variant.
4. **Integration:** a grounded footprint ≥ 25% of the lot square and ≥ 1 ground connection.
5. **Purposeful illumination:** ≤ 45% of mass edges lit, glowing faces ≤ 8% of the surface.
6. **Not conventional:** no plain slab tower, no domestic vocabulary, ≥ 3 distinct forms.
7. **1982 language:** palette-only surfaces and lights, ≥ 75% unlit surface.
8. **Variety:** at most two identical form signatures per district.
9. **Scale:** under the lot's height limit (zoning is enforced separately as a hard limit),
   inside its lot.
10. **Real time:** ≤ 24k triangles, ≤ 700 components, ≤ 200 colliders.

Up to six attempts with derived seeds; districts reject what never passes (open lot).

## The Outlands

Three lattices divide the circumference (seamless): big (128, ~393 m) primary landforms,
small (512, ~98 m) secondary formations, fine (2048, ~25 m) rubble. A cell's archetype is its
block's blend dithered by the cell hash. Every landform is a convex solid (frustum, pyramid,
octahedron, tilted slab, prism, dome, sphere): physics uses one hull each, the renderer draws the
same solid. `terrainHeight` is the ground underfoot (overhead roof slabs and orbs excluded),
`terrainTop` the highest solid. Outlands highways (every 37th line) and landmark clearings cut
through every lattice.

- **Grid plains:** platforms in ~24% of cells (one or two tiers), sparse lit markers.
- **Sea of Simulation:** 1–3 smooth domes per cell, elongated along a slow flow field; small
  lenses; orbs floating 120–380 m up.
- **Electronic canyons:** stepped mesas up to 300 m (1–3 tiers, asymmetric terraces, 3–11%
  batter), narrow passages, 14% recessed valleys, crags on tops, rubble on floors.
- **Geometric wastelands:** one isolated formation in ~38% of cells (monolith, pyramid, tilted
  slab, balanced octahedron, tapered prism), sparse shards.
- **Mechanical caverns:** roof slabs at 70–150 m (shared by 3 × 3 superblocks so the voids
  interconnect) on pillar grids or walls with passages; 20% open shafts; floor machinery.

## Infrastructure and roads

- **Pathways:** each ground connection runs to its lot edge: data → blue trace, energy → white
  conduit, transport → amber lanes.
- **Elevated corridors:** between facing structures across one street, where both have solid
  faces at a shared height (≥ 14 m, under zoning).
- **Solar Sailer routes:** each landmark to its two nearest (≤ 7.5 km), at a constant altitude
  clear of terrain and zoning; pylons every ~650 m, slid off streets, highways and landforms.
- **Roads:** `roadRules.ts` decides which segments exist from the block summary (lots, joins,
  highways, Outlands highways, connector roads). After the summary is built, `connectRoads`
  links every island of streets to the main network along terrain-clear segments (drawn as
  roads) and removes unlinkable fragments. `roads.ts` routes with A* on travel time
  (streets 16 m/s, highways 30 m/s). `groundPilot.ts` drives: right lane, pure pursuit,
  corner and arrival speed limits, re-route when off the road.

## Rendering

- One shader for structures, landforms and infrastructure: painted key/fill/rim shading with a
  dark-to-light gradient up each structure, shader-drawn patterns, screen-space anti-aliased edge
  glow selected per face edge, emissive faces with data flow, activity states from the lighting
  texture (active pulse, idle steady, damaged flicker toward red, inactive dark, hidden).
- One merged mesh per district per LOD (LOD 0 everything, LOD 1 without interiors and unlit
  detail, LOD 2 silhouettes), plus one additive mesh for beams. Ranges (desktop/mobile):
  1.4/0.8 km, 3.4/2.2 km, 8/5.2 km, extended from altitude.
- Culling accounts for the planet's curvature drop; long faces are subdivided so the bend holds.
- The sky and haze follow the region below (`atmosphereAt`), and weather dims them.
- Kit towers draw with `KitTowersView` (centre plus registered planet chunks).
- Clouds (`VolumetricClouds.ts`): a back-faced slab between cloud base and top, raymarched in
  flat world space (32 steps, 48 on high, 18 on phones) through a baked 40³ tiling Perlin-Worley
  texture; coverage and cell height from WeatherView's painting of `Atmosphere.cellValue`;
  Beer's-law shadow toward the key light, powder edges, forward lobe; lighting posterised into
  bands between deep navy and pale blue-white, rimmed in the region's band colour; haze with
  distance. Ported in stylised form from leoawen/volumetric_cloud_atmosphere_scattering (MIT).
- Scattering (`scatterNode`): ray/sphere path length through a 3 km air shell (stopping at the
  planet) → optical depth → banded palette colour; drawn on the planet's limb from altitude.

## Debug interface

`explore.html` (the Digital World Explorer): fly/walk camera (walk collides with structures and
terrain and enters interiors), travel to region archetypes and landmarks, seed and blend
regeneration, and the panel: World (where you are, streaming stats, debug views: hierarchy,
flat surfaces, activity, normals; lighting override; glow/edge/pattern/exposure and LOD sliders;
region map with click-to-travel), Inspect (pick a structure: full spec and validation report;
change its activity state), Archetype lab (family, function, variant, seed, lot, every
parameter, tier/interior/collider toggles). In the flight game, K opens World and Inspect.

URL parameters: `explore.html?seed=7&x=…&z=…&y=…&yaw=…&pitch=…&view=lab&quality=high`.

## Checks

`npm run arch` (families, validation, determinism, districts, interiors, terrain,
infrastructure, reseeding), `npm run drive` (one road network, every destination by road,
spawns on roads, the Navigator driving), `npm run city`, `npm run ground`,
`npm run traffic`, `npm run trails`.
