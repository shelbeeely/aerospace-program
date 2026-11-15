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
- **People:** Bits are people, not vehicles: rigid hovering polyhedra with four figures (two
  idles in their inherited light, yellow YES, red NO) that walk the kerbs; the player on foot is
  one (`npm run bit`). Bits evolve: genes, YES–YES children, ageing, energy, gene pools kept per
  lot, an Evolution Lab (`npm run evolution`); in wars the district's side drafts sappers who set
  defusable charges by hand (`npm run sappers`). Every side also has one street program of its own
  (Archivist, Sentinel, Tender, Scavenger, Broker; `npm run programs`).
- **NPC brains:** small TypeScript networks with declared inputs and outputs, one policy per role,
  the engine carrying decisions out, explanations only from recorded events; trained from
  scripted teachers (`npm run train-drive` for drivers, `npm run train-squad` for the escort
  squad and the supply drone), proven in the Scenario Lab (`npm run scenario`). Weights are
  stamped with the code they were trained on: `npm run train` retrains whatever is stale, and
  CI (`brains.yml`) does it on push and commits the weights back to the branch. Each side learns
  the player's style in realtime and keeps it for the four-week season (`npm run style`). Road
  traffic drives by a network per stock ground type and gives a reckless driver room
  (`npm run civil`). A Stop
  hook (`.claude/hooks/stop-checks.sh`) runs the typecheck and the stale-weights check before a
  turn ends.
- **Grid TV:** `tv.html` draws the game with Canvas 2D for a Chromecast or a TV browser; `pad.html`
  makes a phone the gamepad (Cast channel, relay code, or one browser). The game runs in a worker
  on the TV or on the phone; one frame format either way (`npm run tv`, `docs/tv.md`).
- **Roads:** every road is pathed so the Navigator can drive any ground vehicle anywhere;
  ground vehicles spawn on roads, never on airstrips.
- **Code:** no `Math.random` in generation; sim/world/arch stay DOM- and scene-free; run
  `npm run typecheck`, `npm run arch`, `npm run drive`, `npm run city`, `npm run ground`.
