# Campaign design: a persistent city-builder RTS

Status: design only. No campaign code exists yet. Written against commit `98834c5`.

The campaign extends the game into a persistent online strategy game. One season is one
continuous match. Players are mayors who build cities; teams of mayors govern countries across
a network of portal-linked planets. Borders change through settlement, infrastructure,
diplomacy and, if players choose it, war. A season can stay peaceful from start to finish.

The campaign is a new entry point. The Studio, flight, driving, the explorer and Grid Link keep
working as they do now.

Decisions already taken for the first playable slice:

- **Roads are lattice-snapped.** Mayors open, close and upgrade segments of the existing street
  lattice and zone whole blocks. Free-form roads are deferred.
- **Crossing a portal reloads the client into the destination planet.** A seamless in-place
  swap is deferred.

## 1. Goals and non-goals

Goals:

- A server-authoritative simulation with durable state and validated, idempotent commands.
- City building as durable edits over the generated world, in the 1982 visual language
  (`AGENTS.md`), with the credited kit towers kept.
- Real flows of goods, commuters and services on the existing road graph.
- Countries, provinces, treaties and votes, with peaceful ways to change the map.
- Portals and generated planets that arrive with working cities.
- Seasons that score well without a war.

Non-goals for the first slice: free-form roads, in-place planet swaps, federations, combat
(occupation, ceasefires and military objectives are the next milestone), and scaling beyond
one server process per planet.

**Sandbox stays sandbox.** Local world resets, free team switching and capture by destroying the
last turret (`Territory.capture` in `src/sim/territory.ts`, called from the turret code) are
sandbox rules. In the campaign, ownership changes only when the server resolves them, and
hostility follows diplomacy, not team id.

## 2. Audit of the existing code

What the code does today, and what that means for the campaign.

**Planet constants are global.** `PLANET` (radius 8 km, gravity), `LAYOUT`, `COAST` and `CITY`
in `src/sim/layout.ts` are module constants. `GRID` in `src/arch/grid.ts` is computed from them
at import (370 blocks round, 37 x 37 chunks). The hand-planned centre, the hubs, the airport
and the coast band do not depend on the seed. Every planet therefore has the same size, the
same sea band and the same central plan until those are made configurable.

**The seed is a mutable global with partial reset.** `WORLD` in `src/arch/world.ts` holds the
seed, region lattice, transition width and Outlands share. `setWorld()` runs the clearers
registered with `onWorldReset()`. Registered today: `DistrictGenerator`, `InfrastructureNetwork`,
`DigitalTerrainGenerator`, `WorldRegionManager`, `planetCity.ts`. Not registered:

- `src/sim/territory.ts` (`dealt`, `baseCache`, and a fixed `SEED = 0x7ea3` that ignores the
  world seed),
- `src/world/landingSites.ts` (`cached`),
- `src/world/City.ts` (`cityPlan`, cleared only by `resetCityPlan()`),
- `src/world/structures.ts`, the static world's Rapier colliders, traffic, Bits, turrets.

Only the explorer (`src/explore/main.ts`) changes the seed, at startup from `?seed=` and from
its debug panel. The flight game has never changed planet while running. This is why the first
slice reloads the page to change planet: the seed is applied before anything is generated, as
the explorer already does, and no stale cache can survive.

**Ids have no planet scope.** Structure groups are named `arch:...`, districts are `ci,cj`,
region cells are `i,j`, landing sites are `runway-...` and `roof-h-k`. All are unique on one
planet only.

**Roads are a lattice.** `blockSummary()` in `src/world/planetCity.ts` produces one RGBA record
per block; `segmentExists()` and `connectRoads()` in `src/sim/roadRules.ts` derive the road
graph from it; `src/sim/roads.ts` paths on it (`findRoute`, `nearestNode`, `roadOpen`,
`roadKind`); traffic and the ground shader read the same bytes. `findRoute` already takes a
`blocked` callback. `src/sim/roadDamage.ts` is the model for an overlay: one record closes a
segment for riders, for the route planner and on the drawn ground together.
`refreshGroundTextures()` in `src/render/cityGround.ts` recomputes the ground summary in place.

**Provinces exist in all but name.** `regionSites()` in `src/arch/WorldRegionManager.ts` gives a
12 x 12 lattice of region cells (about 4.2 km), each with a kind (city, outlands, sea), a city
region type, a terrain archetype and a name. `regionTeam()` deals them to teams and
`baseOwner()` maps districts to them. `RadarMap` and `GlobeView` already draw a territory wash
from `Territory` and its `version` counter.

**The server is a stateless relay.** `server/index.ts` and `server/rooms.ts` hold rooms keyed by
a five-letter code, shape-check and rate-limit messages (`src/net/protocol.ts`,
`PROTOCOL_VERSION = 3`) and fan them out. No accounts, no storage. Territory and captures are
simulated by each client. `render.yaml` deploys it on a free plan that sleeps and has no
persistent disk.

**Checks are headless scripts.** `scripts/*.ts` run under Node with type stripping and print
PASS/FAIL lines; the server has `bun test server`. The campaign follows both patterns.

## 3. Planet context

```ts
interface PlanetConfig {
  id: string;               // 'grid' for the home planet, then server-issued
  seed: number;
  generatorVersion: number; // bumped when generation changes shape
  surface: SurfaceConfig;   // what the generators may vary per planet
}
```

- The active planet is chosen once at startup (`?planet=<id>`, config fetched from the server or
  from the local cache) and applied with `setWorld()` before any generator runs. The home
  planet `grid` is seed 1982 with today's settings, so the sandbox is unchanged.
- **Ids are planet-scoped:** `p:<planet>/city:<n>`, `p:<planet>/prov:<i>,<j>`,
  `p:<planet>/arch:<...>`. Inside one planet context the existing short ids stay in use; the
  prefix is added at the campaign boundary (commands, snapshots, storage).
- `SurfaceConfig` in the first slice: region mix weights, Outlands share, transition width,
  atmosphere palette, the hash salt for territory. These are already parameters of `WORLD` and
  the region profiles or are one-line changes.
- Later, with refactoring of `layout.ts` and `grid.ts`: radius and circumference, the coast
  band, the central plan and hubs. Until then, generated planets replace the hand-planned
  centre's role with their seeded cities and keep the standard size.
- `generatorVersion` is stored with every planet. A planet generated under an old version keeps
  being generated by rules compatible with that version, or is migrated explicitly; stored
  edits must never land on different terrain.
- Physics and flight keep working per planet: `Simulation` is built after the planet context
  is set, exactly as now.

## 4. Campaign simulation

Location: `src/campaign/`. Pure TypeScript, no DOM, no three.js, no Bun APIs, so the server and
the client both import it (the client uses it for prediction and display, the server's result
is the truth). No `Math.random`: all randomness comes from seeded hashes of ids and the tick.

**Time.** A fixed campaign tick (default one minute of season time). The server maps wall time
to ticks through a configurable rate, so a test season can run compressed. `advance(state, n)`
is the only way state moves forward besides commands.

**Entities.**

| Entity | Notes |
|---|---|
| Planet | `PlanetConfig`, portals on it, discovery state |
| Province | a region cell; four independent layers (below) |
| Player | account id, country, offices, activity state (section 9) |
| Country | a team: treasury, members and roles, policies; reuses team identity and livery from `src/sim/teams.ts` |
| City | anchored in a province; mayor (player, caretaker or neutral simulation), budget, policies, population, jobs, stockpile, standing orders |
| Facility | utility, freight terminal, depot, bridge, portal terminal; has an owner, an operator and a state (§5: active, idle, damaged, inactive) |
| Stockpile | food, fuel, construction materials |
| Edit | a road or zoning edit on a block or segment (section 5) |
| Freight route | origin, destination, path on the road graph, reserved capacity |
| Treaty | parties, terms, expiry, withdrawal notice, status |
| Vote | proposal, electorate, threshold, deadline, ballots |
| Scheduled event | due tick, kind, payload, applied flag |
| Portal, Transfer | section 6 |
| Feed entry | what happened, to whom, why |

**Province layers.** Each is stored and changed on its own, never derived from another:

1. sovereignty (which country),
2. military occupation (who holds it now, if anyone),
3. facility operation (who runs each facility; leases live here),
4. treaty access (who may transit or use what).

Displayed borders are derived from sovereignty; occupation is drawn as a second mark.

**Economy.** Zoned blocks produce and consume by type (housing: residents and demand; industry
and agriculture: goods and jobs; trade and transport: throughput). Cities specialise by what
they zone and by the province's endowment (from its region type and terrain archetype).
Utilities set a service level that scales output. Shortages reduce growth and are reported in
the feed with their cause.

**Freight and commuters.** A shipment is routed with `findRoute` from the producing block's
nearest road node to the terminal, and between terminals along the highway network. Each
segment class has a capacity per tick (`ROAD_SPEED` and lane count give the base); a corridor's
capacity is its narrowest segment. Demand above capacity queues. Treaties can reserve part of a
corridor. Commuters load the same segments. Near a player, load is shown by real riders
(`src/sim/traffic.ts` density follows the campaign's segment load); elsewhere it stays an
aggregate number. A closed segment (edit, damage, event) is passed to `findRoute` as `blocked`.

**Commands.** Every change is a command: `{ id, session, kind, payload, expectedVersion? }`.
`apply(state, command)` validates permissions and preconditions and returns the new state plus
feed entries, or a typed refusal. Commands are idempotent by `id`: a repeat returns the stored
result.

## 5. Durable edits over generated terrain

The generated planet is never stored. Only edits are.

- **Road edits** per segment `(alongX, i, j)`: open, close, upgrade to highway. An overlay is
  consulted wherever `segmentExists` is asked, and after any change `connectRoads` rules must
  still hold: an edit that would leave an island is refused, or the connector is built with it.
  Every edit does the three things `AGENTS.md` §14 asks of anything that changes a road: the
  graph, the riders and the drawn ground agree (ground via `refreshGroundTextures()`).
- **Zoning** per block: housing, industry, agriculture, trade, transport, utility, terminal.
  A zoned block is built by the existing family generators with a function matching the zone
  (the district planner already assigns functions to lots), seeded by planet, block and edit
  revision, and passed through the ten checks. Buildings stay breakable through `BlockBuilding`
  (§18) and get rooms for their Bits (§17).
- **Facilities** are structures too: freight terminals from the industrial family, utilities
  from the circuit-board family, portal terminals from the radial family.
- **Kit towers** remain a lot type and cannot be zoned away in the first slice.
- Edits are keyed by planet-scoped ids and a `generatorVersion`, applied in order on load, and
  survive leaving and revisiting a planet because the server holds them.
- The airport's obstacle zoning (`heightCap`) still limits what a zone may build.

## 6. Portals

- **Placement.** Portal sites are a pure function of the planet seed, chosen among `city` and
  `transport` region cells, at the end of a road so the terminal is on the network. They reuse
  the landing-site conventions (`src/world/landingSites.ts`: an id, a name, a position, a map
  marker on `RadarMap` and `GlobeView`). A terminal has a ground gate for vehicles and, later,
  a ring above it for aircraft.
- **States.** Dormant, activating, open, closed (by its operator, a treaty or an event). Lit
  accordingly (§5).
- **Activation.** A player at a dormant portal sends `activate`. The server, in one transaction,
  resolves the destination (planet id, seed, generator version, starting manifest, return
  link), stores it, and only then opens the route. The destination is derived from the season
  seed and the portal id, so two players activating the same gate get the same planet whatever
  the order. A season has a finite activation budget.
- **Player transfer.** A state machine stored on the server:

  `reserved → departed → arrived` (or `cancelled` / `expired` back to the origin).

  The client asks to cross; the server checks access (sovereignty, treaties, closures) and
  vehicle support, and reserves an arrival point on a road by the destination terminal. The
  client saves the craft and reloads with `?planet=` and the transfer id. On load it claims the
  transfer and spawns at the arrival point; the server marks it arrived. Claiming is
  idempotent. A client that disconnects in between finds its pending transfer on reconnect and
  resumes it; a transfer can be claimed once, so nothing is duplicated.
- **Freight transfer.** Shipments queue at a terminal, cross at the terminal's handling rate and
  appear in the paired terminal's queue. Each crossing is a stored record applied exactly once,
  including after a server restart.
- **Views.** City streets; planetary regions and borders; and a portal network map that shows
  known destinations, access, queues and alternative routes.

## 7. Generated planets

On activation the server builds a **starting manifest** and stores it:

- two or more cities, each sited on a `city` region cell, with districts, connected roads,
  utilities, workplaces, storage and a freight terminal, all read from the same generators the
  Grid uses (`districtPlan`, `planetChunk`, `blockSummary`, the road graph);
- residents, jobs, budgets and inventories seeded per city;
- resource endowments and specialities varied by seed.

Validation before the route opens: every starting city sustains its basic services for a set
number of ticks in a dry run of the simulation, and at least one city has a road route
(`findRoute`) to the arrival portal. A manifest that fails is regenerated with the next salt;
the salt used is stored.

Discovered cities start under neutral simulation control. Countries may trade with them and
negotiate voluntary accession, after which a player can become mayor and extend the city.
Players may also found settlements in eligible provinces. Discovering a planet opens a route
and nothing more; sovereignty changes only by the province and treaty rules.

## 8. Government, diplomacy and war

- **Roles and permissions.** Mayor (one city), country offices (treasury, infrastructure,
  foreign policy, defence), member. Each command kind names the permission it needs.
- **Votes.** National commitments above a threshold (spending, treaties, province transfers,
  mobilisation) are proposals that need a vote: electorate, quorum, threshold, deadline. No
  single player can spend the treasury or give away a province.
- **Treaties.** Terms are data the simulation enforces: transit permission, reserved freight
  capacity, payments, expiry, withdrawal notice. Proposing or changing a treaty shows who is
  affected (which cities' routes and queues change).
- **Peaceful change.** Founding a city; a province exchange ratified by both countries;
  voluntary accession of a city (its mayor and both countries approve); leases of ports and
  terminals that grant operation while sovereignty stays with the host. Ratified border changes
  apply atomically in one transaction. The mayor and local construction stay with the city.
- **War** (next milestone). A declared, telegraphed state with response windows. Bridges,
  depots, junctions and portal terminals are objectives. Occupation changes access and supply
  at once and never sovereignty; a ratified settlement can restore control, grant transit,
  share administration or transfer sovereignty. Ceasefires reopen civilian passage.
- **Offline play.** Standing orders (imports, exports, reserves, defences) run while a player
  is away. On return the feed shows what happened, what is pending and why.

## 9. Players who leave

Players may join and never return. No city, vote or route may depend on one person coming back.

- **Joining is cheap.** A new player can sign in as a guest (Supabase anonymous sign-in) and
  later upgrade to a full account with the same player id. They are placed in a vacant or
  caretaker city, or a new settlement, in the country with the fewest active mayors.
- **Activity states** per player. The limits are real time since the player was last
  connected, and are configuration; the defaults are:

  | State | After | The player's city |
  |---|---|---|
  | active | | run by the mayor |
  | away | 24 hours | run by the mayor's standing orders |
  | dormant | 3 days | run by a caretaker: the neutral simulation that runs discovered cities. It stays in its country. |
  | vacant | 10 days | the seat is open: the country may assign it, or a newcomer may claim it |

  A player with under one hour of play goes straight to vacant after 48 hours, so seats taken
  by people who tried the game once are freed quickly. Ten days lets a weekend player miss a
  weekend.

- **Returning.** Before the seat is reassigned, the mayor resumes the city as it stands and gets
  the report of what happened. After reassignment they are offered another city.
- **Government.** The electorate, quorum and thresholds of a vote count active members only.
  An office held by a dormant player is vacated. Treaties and debts belong to the country, not
  to a person.
- **Loose ends.** A disconnected player's vehicle is removed after the idle timeout (as
  `Lobby.sweep` does now). An unclaimed portal transfer expires back to its origin. Guest
  accounts that never returned are deleted when the season is archived.
- **Scoring.** A caretaker city still scores for its country. Departed members carry no penalty.

## 10. Seasons and scoring

The first three seasons are planned in [`seasons.md`](seasons.md).

- The world runs continuously on server time. Defaults: a season of six weeks, an intermission
  of one week, a tick of one minute. All are configuration, with a compressed clock for tests.
- **A season is data:** `SeasonConfig` holds the portal network, the activation budget, the
  countries, rule changes, scheduled disruptions (a bridge closure, a surge that shuts low
  crossings), scoring weights and story text.
- Scoring works in a peaceful season: service reliability, fulfilled contracts, shared
  infrastructure used by others, growth. Territory scores through the services and routes it
  secures, not by area.
- At the end: archive maps, border history, settlements, major projects, discoveries and trade
  routes. Reset territory, armies and stockpiles. Carry forward cosmetics and district
  blueprints; veterans get no extra starting resources.
- **One season shapes the next.** Archiving computes outcome measures (accord index, conflict
  index, disruption response, busiest route, champion, discoveries, scarcest good). The pure
  function `nextSeason(template, outcomes)` picks one branch per hook in the next season's
  template; every hook has a default. Carry-over changes the world and the story only, never a
  team's resources, and no branch makes war necessary.
- Planets persist across seasons by id, seed and generator version. Player edits are archived
  with the season, not kept in play.

## 11. Server

Location: `server/campaign/`, beside the relay, in the same Bun process.

- **Transport.** WebSocket at `/campaign`; Grid Link rooms keep the existing path and protocol
  untouched. Campaign messages get their own version number (`CAMPAIGN_VERSION`) in
  `src/campaign/protocol.ts`.
- **Sessions.** Players sign in with Supabase Auth. At launch: guest (anonymous), Google,
  Discord and an email link with no password. Later: Apple (needs a paid Apple developer
  account) and Twitch. A guest can link any method and keeps the same player id and city.
  The client presents its Supabase JWT on `auth`; the server verifies it and maps the user id
  to a player. The server never sees a password.
- **Archives.** A finished season's archive is written to Supabase Storage; its outcome
  measures are kept in Postgres for `nextSeason`.
- **Messages.** Client: `auth`, `command`, `subscribe` (city, country, planet, portal network),
  `ack`. Server: `snapshot` (versioned), `delta`, `result` (per command id), `feed`.
- **Storage.** A `CampaignStore` interface with two drivers and the same tables (clock,
  append-only command log, snapshots, scheduled events, world events, transfers, players):
  - **Postgres** in production: Supabase Postgres, reached with Bun's built-in SQL client.
  - **SQLite** (`bun:sqlite`) for local play and `bun test`, with no network.

  Each command and each tick batch commits in one transaction.
- **Clock and restarts.** The last applied tick is stored. On start the server computes the
  ticks owed from wall time and applies them, with scheduled events, in order; each event has
  an applied flag set in the same transaction, so overdue events apply exactly once. Pending
  votes, treaty terms, scheduled events, city orders and queued shipments are all state and
  survive restarts.
- **Testing aids.** A local-only command advances time by a number of ticks. A seeding script
  creates the test scenario.

### Deployment: Render and Supabase

| Piece | Where |
|---|---|
| Authoritative campaign server and the Grid Link relay (Bun, WebSocket) | Render web service (`render.yaml`, `server/Dockerfile`) |
| Durable state | Supabase Postgres |
| Accounts and sign-in | Supabase Auth |
| Season archives, district blueprints | Supabase Storage |
| Game client | GitHub Pages as now, or a Render static site |

Rules:

- **Clients never write tables.** Row-level security denies the browser everything. Only the
  server connects with database credentials.
- **Supabase Realtime is not used for the simulation.** The server's own WebSocket is the live
  channel; it is the only path that validates commands.
- **One writer.** The server takes a Postgres advisory lock at start, so two processes can
  never both advance the clock.
- **Secrets.** The database URL and the JWT verification key are Render environment variables.
  The browser gets only the Supabase project URL and its public anon key.
- **Tiers.** Free tiers suit a prototype. A free Render instance sleeps when idle: state
  survives in Postgres and the ticks owed are applied on wake, at the cost of a wait for the
  first player. A free Supabase project pauses when left idle. A live season needs an
  always-on Render instance and a Supabase plan that does not pause.
- **Verify at build time:** current tier limits and prices; and that Render reaches the
  database through Supabase's connection pooler address (the direct address may be IPv6 only).

## 12. Realtime sync and capacity

Every player sees the same world live. A building knocked over is sent to every player on that
planet, and is still down for anyone who arrives later.

Three channels on the campaign socket:

1. **Vehicle state**, 20 Hz, simulated by each player's own client as in Grid Link (`NetState`
   in `src/net/protocol.ts`). The server relays it only within an area of interest: the
   district chunks around each player, at a lower rate with distance.
2. **World events:** the existing `NetEvent` kinds (`fracture`, `explosion`, `nuke`, `emp`) plus
   road closures and edits. The server gives each a sequence number, stores it, broadcasts it
   to the whole planet and replays what is still in force to arrivals.
3. **Campaign deltas** (cities, borders, treaties, freight) to subscribers.

**Persistent damage.** Per planet the server keeps the ordered world-event log and a compacted
record of fractured groups and removed blocks, cleared by repair or by the season reset. Every
client breaks a structure from the same event through the one destruction engine (§18), so the
same blocks fall for all. The final block state is authoritative. The motion of loose debris is
simulated locally and may look different from one player to the next.

**Validation.** The server does not run physics. It checks plausibility (the sender is in
range, holds the weapon, and is within rate limits), reusing `RateLimiter` from
`server/rooms.ts` and the hit rules in `src/net/hits.ts`.

**Capacity.** Estimates from the design, to be replaced by load-test results:

| Load | Estimate | Limit |
|---|---|---|
| Vehicles in one area | 30 to 60; about 100 with distance-based rates | each player hears every nearby player |
| Vehicles per server process | 300 to 500 | CPU relaying 20 updates a second each |
| Players in city and map views | 1,000 to 5,000 | connections and database writes |
| More | one server process per planet | portals already separate planets |

Only lasting changes are written to Postgres, never the 20 Hz vehicle state, so the database is
not in the hot path. Grid Link keeps its 16-player rooms.

## 13. Client

- New entry `campaign.html` with `src/campaign-ui/`, next to `index.html` and `explore.html`.
  It reuses the renderer, the world views and the simulation for driving and flying through
  cities.
- Three connected views:
  1. **City:** the 3D world from above with lattice tools (roads, zones, facilities), budget and
     policy panels, congestion overlay and the activity feed. One key drops into a vehicle on
     the street.
  2. **Planet:** `RadarMap` and `GlobeView` with server-owned borders, provinces, corridors,
     freight volumes and treaties.
  3. **Portal network:** a graph of known planets and links with access, queues and routes.
- The client never decides ownership. It sends commands and draws snapshots.

## 14. Code reused

| Existing code | Use in the campaign |
|---|---|
| `src/arch/` generators, `districtPlan`, the ten checks | all buildings from zoning and all generated cities |
| `src/world/planetCity.ts` (`blockSummary`, `planetChunk`, `chunkAt`) | terrain and block kinds under the edits |
| `src/world/kit.ts`, `KitTowersView` | kit towers stay a lot type |
| `src/sim/roadRules.ts`, `src/sim/roads.ts` (`findRoute` with `blocked`, `nearestNode`) | freight and commuter routing, edit validation |
| `src/sim/roadDamage.ts` | the pattern for closures (bridge closure event) |
| `src/sim/traffic.ts` | visible traffic near the player, scaled by segment load |
| `src/render/cityGround.ts` (`refreshGroundTextures`) | redrawing the ground after edits |
| `src/arch/WorldRegionManager.ts` (`regionSites`, `regionAt`) | provinces, endowments, names |
| `src/sim/teams.ts` (`TEAMS`, `sideLivery`) | country identity and liveries |
| `src/sim/territory.ts` | sandbox ownership only; the map reads the same shape of data from the server in the campaign |
| `src/hud/RadarMap.ts`, `src/render/GlobeView.ts` | borders and the planet view |
| `src/world/landingSites.ts`, `src/world/spawnSites.ts` (`nearestRoadPoint`) | portal terminal conventions and safe arrival points |
| `src/world/BlockBuilding.ts` | everything built can break, by the one engine |
| `server/rooms.ts` (`RateLimiter`, `Peer`, `Lobby.sweep`), `src/net/protocol.ts` (`NetState`, `NetEvent`, validators), `src/net/hits.ts` | vehicle and world-event sync, rate limits and validation on the campaign socket |

## 15. First playable slice

Scenario: the Grid, two countries (Cyan and Amber), two cities each, a handful of region cells
as provinces, a shared capacity-limited freight crossing, food, fuel and construction
materials, one dormant portal to a generated second planet with two working cities and a
paired return portal, a scheduled bridge closure.

Stages, each ending with passing checks and a commit:

1. **Simulation core** (`src/campaign/`): state, tick, commands, economy, freight on the road
   graph, events, scoring, `SeasonConfig` and `nextSeason` (check `npm run seasons`). Check `npm run campaign`: determinism (same commands, same state),
   idempotent commands, conservation of goods, capacity limits, a season that ends with scores
   and no war; a vote passes with absent members; a dormant mayor's city keeps its services;
   a vacant seat is taken over with its edits intact.
2. **Server** (`server/campaign/`): socket, the store interface with the SQLite driver, clock,
   restart recovery, time advance, vehicle and world-event sync with areas of interest. `bun test server`: a restart with a shipment queued at the portal delivers it once;
   overdue events apply once; pending votes and treaties survive; a late arrival sees a building
   that fell before they joined. A load test with headless bot clients measures the capacity
   figures of section 12.
3. **Planet context and ids:** `PlanetConfig`, `?planet=`, planet-scoped ids, territory salt
   from the planet. Existing checks (`planet`, `orbit`, `city`, `teams`, `arch`) must not move
   for the home planet.
4. **City building:** road and zoning overlays, facilities, ground refresh. `npm run drive`,
   `traffic`, `ground`, `city`, `arch`, `buildings` plus new cases: no island after any edit,
   the Navigator can drive to every new terminal.
5. **Client:** `campaign.html`, the three views, the feed.
6. **Portal and second planet:** activation, manifest generation and validation, transfer,
   return. `npm run portals`: two sessions activating the same portal get the same planet; a
   generated city routes to its terminal; edits survive leaving and returning.
7. **Diplomacy and scenario:** one national vote, a ratifiable transit treaty with reserved
   capacity, a peaceful transfer of a rural border province, the bridge closure solved by
   sharing the crossing or funding a bypass.
8. **Deployment:** the Postgres driver, the Supabase schema migration and row-level security,
   Auth verification, Render environment variables.
9. **Handoff:** README sections for startup, Supabase and Render setup, seeding, time
   acceleration, persistence, code reused and deferred work; `AGENTS.md` rules for the
   campaign.

Demonstration at the end: separate browser sessions run different cities, ratify a treaty and
see freight volumes and local congestion change; both reach the same generated planet, drive
through a city there and come back; a province changes hands peacefully; the season ends with
scores and no declaration of war; the sandbox room still works beside it.

## 16. Deferred work and open questions

The slice is what season 1 needs. War arrives with season 2 and federations with season 3
([`seasons.md`](seasons.md)).

Deferred: free-form roads; in-place planet swap; air and orbital portals; per-planet radius,
coast and central plan; war (occupation, ceasefires, objectives); federations; running
one process per planet; LLM mayors for neutral cities.

Open questions:

- How many players per country and per season is the target? It sets snapshot size and the
  subscription model.
- Whether neutral cities are run by simple rules or by a model.
- How district blueprints are stored and shared between seasons.
- Whether the home Grid's hand-planned centre is a city a player can govern, or a neutral
  capital.
