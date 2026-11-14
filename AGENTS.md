# AGENTS.md: Digital World Design Rules (1982)

Rules for every agent and contributor working on this repo. Claude Code reads them through
`CLAUDE.md`, which imports this file.

## Working rules

- **Visual language:** the design rules below govern anything visual or spatial.
- **Roads:** every road is pathed (§14). Keep the road graph (`src/sim/roadRules.ts`,
  `src/sim/roads.ts`), traffic and the ground shader in agreement.
- **Kit towers stay:** the imported "Tron Buildings 1" kit towers (`src/world/kit.ts`,
  `src/render/KitTowersView.ts`, CC-BY-4.0, credited in the README) are placed by the district
  planner as their own lot type. Do not remove them.
- **Ground vehicles start on a road**, never on an airstrip.
- **Determinism:** world generation is a pure function of the world seed and lattice indices;
  never use `Math.random` in generation code.
- **Separation:** the simulation (`src/sim`, `src/world`, `src/arch`) stays free of three.js
  scene objects and the DOM; rendering lives in `src/render`.
- **Checks:** `npm run typecheck`, `npm run arch`, `npm run drive`, `npm run city`,
  `npm run ground` before pushing world or vehicle changes; `npm run bit` for the people.

## Design rules

These rules govern every visual and spatial decision in the digital world: the architecture,
the Outlands, the ground, the sky, light and infrastructure. They replace the earlier
synthwave/neon look entirely. When a change trades one of these rules against decoration,
the rule wins.

**Priority order:** architectural fidelity, meaningful geometry, spatial coherence and
environmental variety come before decorative neon effects.

**Source:** the environmental artwork and production concepts documented in Michael Bonifer's
*The Art of TRON* (1982). This is the original film's architectural language, not the visual
style of *TRON: Legacy* (2010). The original has its own identity: monumental electronic
structures, abstract geometry, circuit-board landscapes, illuminated edges, industrial
machinery and atmospheric colour gradients.

**Implementation:** `src/arch/` (generation), `src/render/arch/` (rendering), with technical
documentation in [`docs/architecture-grammar.md`](docs/architecture-grammar.md).

---

## 1. Fundamental architectural philosophy

The digital world is not a futuristic human city. Its architecture is the physical
manifestation of computer systems, electronic components, information processing and
computational functions. Buildings should resemble enormous electronic machines that happen to
contain inhabitable spaces. Every structure must have a recognisable purpose within the
digital world.

Core principles:

1. Architecture emerges from electronic infrastructure.
2. Geometry determines the identity of a building.
3. Lighting communicates function, structure and activity.
4. Large architectural masses take priority over surface decoration.
5. Buildings are integrated into their surrounding electronic environment.
6. Scale should frequently feel monumental.
7. Negative space is as important as solid geometry.
8. Structures use a combination of orthogonal, cylindrical, radial, tapered and sweeping forms.
9. Different computational functions produce different architectural forms.
10. The world must remain visually coherent while supporting significant architectural variety.

Avoid conventional skyscrapers, houses, office buildings, brick walls, glass curtain walls and
ordinary street layouts.

## 2. Architectural families

At least five distinct procedural building generators.

### A. Circuit-board structures (book pp. 12–16, 39–40)

Rectangular extrusions emerging from large geometric planes; layered platforms and stepped
elevations; broad, uninterrupted surfaces; recessed channels and narrow pathways; linear
illuminated connections; repeating rectangular subdivisions; large geometric foundations.
Buildings appear physically integrated into the electronic substrate. Functions: memory
storage, data routing, computational processing, system infrastructure.

### B. Monumental processing towers (pp. 13–16, 60–62)

Cylindrical and polygonal cores; wide foundations and tapered bodies; flared, trumpet-like
bases; radial platforms; suspended or elevated geometric masses; strong vertical silhouettes;
symmetrical compositions; limited but deliberate illuminated details. Major processing
centres, control systems and computational landmarks. Towers are not restricted to
rectangular prisms.

### C. Industrial megastructures (pp. 35–38)

Enormous enclosed spaces; long corridors and structural passages; repeating frames and support
columns; massive walls with deep recesses; broad geometric openings; oversized pylons; large
interior chambers; illuminated structural seams. Infrastructure operating at a scale much larger
than individual programs: transportation terminals, carriers, processing facilities,
industrial complexes.

### D. Electronic caverns and dense machine cities (p. 39, electronic cave concept)

Interlocking rectangular volumes; vertically stacked structures; cantilevered platforms; deep
shafts and voids; overlapping architectural masses; dense orthogonal arrangements; narrow
illuminated boundaries; multiple connected elevations. Not conventional city blocks: connected
mechanical structures surrounding enormous negative spaces.

### E. Radial and communication structures (pp. 53–58)

Circular and radial geometry; symmetrical arrangements; elevated central platforms; rings and
concentric structures; slender connecting elements; monumental communication nodes; geometric
bridges and transportation connections. I/O towers, communications infrastructure, energy
distribution and major transportation hubs.

## 3. Geometry and proportions

A procedural geometric grammar. Allowed primary primitives: boxes and rectangular prisms;
cylinders; cones and truncated cones; pyramids; polygonal extrusions; radial platforms; rings
and toroidal sections; tapered columns; swept surfaces; custom extruded profiles.

Each structure has a strong primary silhouette of roughly 2–5 dominant masses before secondary
detail (an implementation guideline, not a historical production constraint).

- **Primary geometry** defines the recognisable silhouette.
- **Secondary geometry** defines platforms, columns, supports, recesses and connecting volumes.
- **Tertiary geometry** defines panel seams, circuitry, illuminated channels and small detail.

Tertiary detail never overwhelms primary forms. Heights, widths, proportions, orientations and
complexity vary substantially; buildings are never uniformly sized.

## 4. Materials and surfaces

A restrained material system.

- **Primary surfaces:** deep blue, dark navy, near-black, muted cyan, desaturated metallic blue,
  occasional pale blue and grey.
- **Secondary illumination:** electric cyan, bright blue, white, red, orange, amber.

Do not cover every surface in glowing lines; large unlit surfaces are essential. Favour smooth
surfaces over heavy texture; large geometric panels; no realistic brick, concrete, wood or
ordinary glass; selective emissive edges; subtle gradients and atmospheric variation; some
surfaces translucent or reflective; clear silhouettes against the environment. Materials and
shader parameters are reusable.

## 5. Architectural illumination

Lighting is part of the architecture, not an external effect. Illuminated features communicate
structural boundaries, active computational processes, energy distribution, data
transportation, entrances and connections, functional regions and building activity. Emissive
materials with selective bloom; bloom never obscures the geometry. Not every edge glows.
Distinct lighting states exist for **active**, **idle**, **damaged** and **inactive** structures.

## 6. Integration with the digital landscape

Buildings emerge from and connect to the electronic terrain: vast geometric grid planes,
circuit-board-like landscapes, recessed channels, elevated platforms, geometric valleys, deep
mechanical cavities, broad transportation corridors, suspended structures and distant
monumental silhouettes. No naturalistic terrain unless deliberately abstracted into the digital
world's geometric language. The world has both enormous open spaces and dense, enclosed
architectural regions.

Structures connect through visible networks of data pathways, energy conduits, transportation
routes, bridges, elevated corridors and illuminated channels, and that infrastructure has a
meaningful relationship to building function.

## 7. Procedural generation

Modular and seed-based. Every structure has: a unique identifier, architectural archetype,
computational function, position and orientation, dimensions and proportions, primary and
secondary geometry parameters, material palette, illumination configuration, connection points,
interior accessibility, activity state and generation seed. Generation is deterministic for a
given seed.

Hierarchy: **World → Region → District → Structure → Component**. Regions have recognisable
identities (open computational plains, dense machine cities, industrial processing zones,
communication districts, monumental control centres, transportation networks, electronic
caverns). No uniform random placement: buildings form meaningful functional clusters.

## 8. Interior architecture

Accessible interiors follow the exterior language: monumental chambers, repeating structural
bays, long geometric corridors, elevated walkways, deep shafts, recessed platforms, geometric
doorways, large machinery and functional illumination. Interiors are navigable and spatially
consistent with the exterior geometry; no decorative interiors disconnected from the
structure's physical dimensions.

## 9. Scale and atmosphere

Enormous scale: distant silhouettes, wide horizons, deep atmospheric gradients, large
unoccupied spaces, monumental structures, repeating detail that establishes perspective,
controlled fog and depth. Preserve the painterly atmospheric qualities of the 1982 concept art.
The world is never uniformly black.

## 10. Three.js implementation

Reusable modules (`ArchitectureGenerator`, `BuildingArchetypeRegistry`, the five family
generators, `DigitalTerrainGenerator`, `InfrastructureNetwork`, `ArchitecturalMaterialLibrary`,
`BuildingLightingController`, `InteriorGenerator`, `WorldRegionManager`). `BufferGeometry` for
custom shapes, `InstancedMesh` for repeated components, shared materials and geometries,
procedural shaders for grids and circuitry, level of detail, frustum culling, chunk streaming,
deterministic seeds. Real-time in a browser, including mobile; avoid excessive draw calls and
individual light sources.

## 11. Architectural validation

Every generated building passes these checks, or is regenerated, or rejected:

1. A recognisable geometric silhouette.
2. Its appearance communicates an electronic or computational function.
3. It belongs to one of the defined families.
4. Its geometry is integrated with the surrounding environment.
5. Illuminated details are purposeful.
6. It avoids conventional contemporary architecture.
7. It preserves the 1982 visual language.
8. It contributes to architectural variety.
9. Its scale suits the surrounding region.
10. Its geometry is optimised for real-time rendering.

## 12. Deliverables

A functional generation system (not concept images): a reusable architecture library; five
complete generators; a configurable material and illumination system; procedural electronic
terrain; functional infrastructure; multiple example districts; a navigable Three.js
environment; seeded world generation; desktop and mobile performance work; technical
documentation of the grammar and parameters; an interactive debug interface for selecting
archetypes, modifying parameters, inspecting geometry and regenerating structures.

**Final objective:** a digital civilisation whose architecture looks generated by the internal
logic of a computer rather than designed by human architects: monumental, geometric,
functional, mysterious, and unmistakably connected to the visual design of the original 1982
TRON.

---

## 13. The Outlands

Regions outside the electronic cities are the Outlands: immense abstract computational
landscapes. They must not resemble ordinary Earth terrain with neon textures applied. Geometry,
surfaces, illumination and spatial organisation suggest mathematical structures, electronic
systems and simulated environments. Preserve the painterly horizons, atmospheric gradients and
unusual geometric landforms of the film.

**Terrain archetypes:**

1. Grid plains: broad uninterrupted surfaces, distant horizons, occasional elevated platforms.
2. Sea of Simulation: unusual smooth and geometric formations.
3. Electronic canyons: immense angular walls, recessed valleys, narrow passages.
4. Geometric wastelands: sparse polygonal formations and isolated structures.
5. Mechanical caverns: enormous interconnected geometric voids.
6. Transitional regions blending archetypes.

(1 and 2 come directly from film environments; 3–6 extend the visual language.)

**Procedural geometry:** stepped and terraced forms, polygonal extrusions, large flat grid
surfaces, parametric curves and sweeps, geometric cliffs and valleys, procedural tunnels,
repeating mechanical formations, sparse monumental landmarks. Not exclusively noise-based:
deterministic mathematical functions, signed distance fields, geometric subdivision and
controlled variation.

**Density:** large sparse or empty areas; no uniform scatter of decoration; distinct zones of
high, medium and low density; distant landmarks visible across enormous distances.

**Infrastructure and exploration:** lightcycle highways, energy conduits, data pathways,
elevated corridors, bridges and Solar Sailer routes connect cities and remote structures.
Continuous travel from city centres into the Outlands without loading screens (chunk streaming,
procedural LOD).

**Atmosphere:** region-specific horizon gradients, haze, emissive terrain features, ambient
light, distant silhouettes and sparse animation. No realistic vegetation, ordinary rivers,
conventional rock textures or naturalistic mountains unless transformed into an appropriate
computational design.

**World generation:** World → Region → Terrain Chunk → Landform → Structure, deterministic
across chunk boundaries, with coherent connections between cities, transport and remote
structures. Terrain generators, configurable biome transitions, world streaming, distance LOD,
procedural landmarks and a debug interface for generation parameters.

The result should feel like a vast, mysterious electronic wilderness of the original 1982 TRON
universe, not a conventional open world decorated with neon.

---

## 14. Movement rules (project)

- **Every road is pathed.** Streets, data highways and Outlands highways form one road graph.
  The flight computer is general-purpose for all vehicles: a ground vehicle can be sent to any
  destination and drives there automatically along the network. Anything that adds, removes or
  blocks a road must keep the graph and the drawn ground in agreement. Islands of streets are
  linked to the network by connector roads (or removed if they cannot be), so there are none.
- **Ground vehicles start on the road network**, never on an airstrip.
- **Traffic behaves like traffic.** Riders (`src/sim/traffic.ts`) follow the one ahead, stop for
  the signals at highway crossings, give way where a street meets a highway, and never ride
  into another rider or its jetwall. Civil aircraft (`src/sim/aiTraffic.ts`) fly flights between
  fields and pads, one to a runway, and go around rather than land on an occupied one. Checks:
  `npm run traffic`, `npm run air`.
- **A broken road is a closed road.** A crater that closes a road segment (`src/sim/roadDamage.ts`)
  is a wall across the road to riders and to the flight computer, is left out of new routes, and
  is marked on the ground with a red bar at each rim. Anything else that blocks a road must do
  the same three things.
- **A vehicle never runs into its own light wall** (Rapier collision groups,
  `src/sim/collisionGroups.ts`); its walls stay deadly to everyone else. Ground vehicles reverse.

## 17. People (project)

- **Bits are people, not vehicles.** They are never a craft, never in the vehicle picker and
  never on wheels. A Bit is a rigid polyhedron that hovers; it has no legs and no animation
  rig. It speaks only by which of its four figures it shows (`src/people/bit.ts`): blue idle 1
  and idle 2 (it pulses between them), yellow YES, red NO.
- **They behave like people** (`src/sim/bits.ts`): they live on a lot, indoors in its building's
  room and on the kerb round it; they go in and out by the doors, stand, meet and talk, step
  back from fast vehicles and explosions, and derez when run over. Seeded and deterministic per
  lot; streamed around the player. A Bit is never inside a wall or the machinery.
- **Buildings have rooms for their people** (§8). A structure generated solid gets a commons
  hollowed out of its largest box mass on the ground or a low foundation (`inhabit` in
  `src/arch/InteriorGenerator.ts`), unless that would fail one of the ten checks. The shell
  keeps the mass's surface, tier and role, every door has a clear way out to the lot edge (with
  steps where it is raised) and a clear aisle in. New interior furniture keeps the aisles clear.
  A round drum is hollowed the same way by `inhabitRound` (a ring wall with real doorways), and
  the foot of any other mass by `inhabitShell` (a shell that follows its outline). Each pass is
  tried in turn until one passes the ten checks. A radial structure or tower none of them can
  open gets an entrance hall (`addHall`). The kit towers have their rooms cut in at import
  (`npm run import-towers`); do not edit `towerKit.json` or `towerKit.bin` by hand.
- **Every side has its own program on the streets** (`src/sim/programs.ts`): Archivists
  (Cyan), Sentinels (Red), Tenders (Amber), Scavengers (freelancers), Brokers (mercenaries).
  Each kind belongs to exactly one side and stands only where that side holds the district (or,
  for freelancers and mercenaries, anywhere). Programs are rigid polyhedra like the Bits:
  dark bodies with selective light in their side's colour, and YES/NO in yellow and red. They
  walk the road margins in file, never into a lot or along a closed road, and are seeded per
  road corner. A new side gets a new kind. Check: `npm run programs`.
- **The player on foot is a Bit** (`BitWalker`): it steps out of a stopped vehicle, walks, and
  gets back in beside it. The vehicle stays parked.
- **Errands on foot** (`src/sim/errands.ts`): an escorted Bit walks the trail the player
  walked, so it is never inside a wall, and goes into its new building by the door. The player's
  Bit can be styled (`src/people/bitStyle.ts`) in its idle light, size, idle figure and spin;
  YES stays yellow and NO red for everyone.
- The figures are the imported "BIT" meshes (CC-BY 4.0, credited in the README). Do not
  replace them with humanoids.
- Check: `npm run bit`.

## 18. Destruction (project)

- **One engine, and it bears load.** Everything that breaks (structures, kit towers,
  infrastructure, town buildings, Outlands landforms) becomes a `BlockBuilding`
  (`src/world/BlockBuilding.ts`). Blocks must stay connected to the ground **and** within what
  the structure could bear when whole (`analyseLoad`, `loadLimits`): overloaded columns crush,
  over-long overhangs snap. Do not add a second destruction path.
- **Being whole never fails a structure.** Limits are taken from the intact block grid; a new
  kind of structure needs no tuning to stand.
- **Hollow stays hollow.** A structure with a room carries it into its block grid
  (`StructureGroup.room`); pieces too small to be a block are left out.
- **What rests on something says so.** A structure held up by others declares `heldBy`
  (corridors do); it falls when a holder no longer holds. A raised landform falls when fewer
  than half of the landforms under it are left.
- **People are part of it.** A wrecked building's Bits leave; rubble and blasts derez Bits and
  the player on foot.
- Checks: `npm run buildings`, `npm run destruction`.

## 16. Vehicles (project)

- **Every vehicle wears the 1982 palette.** `src/craft/style1982.ts` restyles every craft when it
  is built, whatever its source (built-in, Studio, AI designer): dark navy / blue / steel bodies
  (warm near-blacks for red-team craft) with dim seams, and selective light (accent strips,
  canopies, leading edges, nozzles) in one circuit colour plus at most one accent, under a
  quarter of the surface. No custom liveries.
- **Every vehicle is one connected piece** (`src/craft/connectivity.ts`): part shapes overlap or
  touch, nothing floats, modules sit on their own part. The AI design loop rejects violations.
- **Generated vehicles are detailed** in three tiers (primary silhouette, secondary machinery,
  tertiary seams and light lines). The detail round (`src/gen/detailer.ts`) adds visual-only
  parts and can never change the tested physics.
- **The architecture rules apply to every vehicle** (`src/craft/grammar.ts`, drawn by
  `src/render/VehicleGrammarView.ts`). A craft's parts are its primary geometry; the vehicle
  grammar reads what each part does (hull, wing, fin, cockpit, engine, rotor, wheel, trail
  emitter) and derives secondary geometry (spines, armour plates, wingtip caps, fences, nozzle
  rings and petals, intake cowls, canopy frames, fender arcs, rotor guards) and tertiary
  geometry (panel seams, chine light lines, intake lips, tip lights, nozzle glow), seeded by the
  craft so every design varies and the same craft always looks the same. Render-only: it never
  touches the physics. Lights have states (§5): running lights dim when idle and brighten when
  active, nozzles glow with spool and flare on afterburner, damaged parts flicker, wrecks go
  dark. Lit pieces stay under a tenth of the surface.
- Check: `npm run craft`.
- **Hostile aircraft wear red-team colours** through `redTeam()` (`src/craft/style1982.ts`):
  warm near-black bodies and red light, still under the light budget, with the light states of
  §5 (dim on patrol, full in the attack, flickering when hit). Check: `npm run enemies`. Tower
  turrets (`src/craft/towerTurret.ts`) wear it too (check: `npm run turrets`).
- **Every side has one livery** (`sideLivery()` in `src/sim/teams.ts`, built on `livery()` in
  `src/craft/style1982.ts`): Cyan (cyan light, cool bodies), Red (red light, warm bodies), Amber
  (amber light, cool bodies), freelancers (white light), mercenaries (bright blue light). The
  player's craft, AI aircraft and turrets wear their side's. Check: `npm run teams`.
- **The imported kit towers remain part of the world.**

## 15. Reference notes from the book

What the concept art establishes concretely, used by the generators:

- **p. 10** (Chris Lane): rings hovering over a circular platform around a central cluster; a
  floor of large glowing translucent panes.
- **p. 12** (Peter Mueller): airbrushed skies (deep red, cyan, pale); a raised slab whose top is
  a circuit board with orange traces; blocky components on a circuit landscape.
- **p. 13**: concave trumpet-flared towers wrapped in grid lines with a glowing ring at the
  waist; a long megastructure street with red halo rings and a red floor line; tiled grid floor
  with trapezoidal prisms.
- **p. 15**: dark sky over an amber horizon band, a wall of blocks, a cyan plane, a cyan grid
  floor.
- **pp. 35–37** (the carrier, Syd Mead / Triple-I): pale cyan solids with red-orange edge lines,
  vast overhead slabs, a maze of circuitry on the ground, a beam of light.
- **p. 39** (Harrison Ellenshaw): the electronic cave, a dense vertical shaft of interlocking
  blocks with light falling from above; the ring game's floating red rings.
- **p. 40** (Triple-I cityscape): pale pyramidal bases carrying needle spires with lit tips,
  red halo rings hovering above them.
- **p. 53** (solar sailer hangar): pale teal fluted walls, a skylight grid roof, an energy beam.
- **p. 54** (Sea of Simulation): pale blue smooth spheres, domes and lenses; orbs floating in a
  deep blue sky; a pale plain marked with short dashes; tall tapered structures.
- **p. 55**: canyon walls of vertical fluted columns.
- **p. 58**: stepped concentric tiers rising to a lit enclosure with light fanning outward.
- **pp. 60–62** (the control program): a fluted cylinder of vertical slats on a pedestal, on a
  mesa ringed with sawtooth teeth and radial red lines, with a beam rising to the sky.
