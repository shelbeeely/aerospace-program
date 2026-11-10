# CLAUDE.md

@AGENTS.md

The full rules are in [AGENTS.md](AGENTS.md) (imported above). The essentials:

- **Visual language:** the original 1982 TRON digital world (Michael Bonifer, *The Art of
  TRON*), not TRON: Legacy and not synthwave. Architectural fidelity, meaningful geometry,
  spatial coherence and environmental variety come before decorative neon effects. Large unlit
  surfaces; light is selective and communicates function; never cover everything in glowing
  lines.
- **World:** World → Region → District → Structure → Component, seeded and deterministic. Five
  architectural families (circuit-board, processing towers, industrial megastructures,
  electronic caverns, radial/communication) plus the imported kit towers, all validated by the
  ten architectural checks. Outlands: grid plains, Sea of Simulation, electronic canyons,
  geometric wastelands, mechanical caverns and transitions, as exact geometric solids.
- **Vehicles:** every craft is restyled into the 1982 palette and must be one connected piece
  (`npm run craft`); a vehicle never hits its own light wall.
- **Roads:** every road is pathed so the flight computer can drive any ground vehicle anywhere;
  ground vehicles spawn on roads, never on airstrips.
- **Code:** no `Math.random` in generation; sim/world/arch stay DOM- and scene-free; run
  `npm run typecheck`, `npm run arch`, `npm run drive`, `npm run city`, `npm run ground`.
