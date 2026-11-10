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
  `npm run ground` before pushing world or vehicle changes.

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
