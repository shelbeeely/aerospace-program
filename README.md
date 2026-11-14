# aerospace-program

A browser aircraft sandbox ("KSP for planes") built with three.js + Rapier, where **generative
models are part of the core loop**. Describe a craft, a model of your choice (any of the
hundreds on OpenRouter) designs it as a part graph, the physics sim flight-tests it and feeds
problems back to the model, and then you fly it. Physics is emergent, so a bad design really
flies badly.

```bash
npm install
cp .env.example .env   # add your OPENROUTER_API_KEY (optional: flying works without it)
npm run dev            # http://localhost:5173, press N for the Studio
npm run design -- "a twin-boom cargo plane" --model anthropic/claude-sonnet-5.5
npm run sim            # headless physics regression (takeoff, turn, stalls, CoM shift, crash)
npm run weather        # weather impact checks (rain, icing, ground effect, vortex ring, wet runway)
npm run ground         # ground vehicles: flat ground, skid steering, Outlands highways and rubble, spawn sites
npm run arch           # digital world: five families vs the ten checks, districts, interiors, Outlands
npm run drive          # road network: one graph, every destination by road, the Navigator driving
npm run weapons        # weapons: fitted multiples, cannon cratering, tank bulldozer, bombs, missiles, laser, discs, armour
npm run craft          # vehicle rules: connected parts, the 1982 palette, the vehicle grammar, ground-vehicle design loop (offline)
npm run engines        # fast flight: compressibility, ramjet/scramjet/solid/turbojet, thrust vectoring, airbrake, chute, cone/capsule parts, weight floors
npm run air            # AI air traffic: flights between fields and pads, clearance, one per runway, go-arounds
npm run radar          # radar and planet map: contacts, heading-up scope, wrap-aware geometry
npm run lock           # target lock, homing missiles, turret traverse/elevation and auto-aim, chase mode
npm run turrets        # tower turrets: placement, streaming, armed-only fire, line of sight, kills, fracture
npm run teams          # teams: liveries, territory, the AI war, friendly fire, capture, freelancers, mercenaries
npm run wmd            # railgun, nuke and EMP: buying, the dropped nuke (chute, airburst, drop marker), the fireball and shock ring, the EMP's effects
npm run strikes        # called-in strikes and orders: focus points, barrage, EMP strike, nuke bomber, interception, attack orders
npm run adsb           # ADS-B: callsigns, speeds, squawk codes, track history; strike-globe picking and close-view geometry
npm run hacking        # the hacking beam: charges, the 3 s hold, takeovers of aircraft, turrets and light cycles, reverting
npm run netdamage      # networked damage: hit tests, the shooter's scanner, the victim's checks, kills
npm run enemies        # enemy aircraft: red-team colours, patrol vs hunt, gunnery, hit points, kills, determinism
npm run orbit          # the Navigator's "To orbit" mode flies the Orbiter to a stable orbit
npm run build          # typecheck + production build
```

## The generation loop

```
 describe ──► designer model ──► validate ──► flight test (headless sim) ──► fly it yourself
                   ▲                 │                │                          │
                   └── format errors ┘                │                          │
                   └──────── test report: "CoM behind CoL", "can't rotate"… ──────┘
                   └──────────────── Refine: your flight notes + what to change ─┘
```

1. **Design.** In the Studio (N), describe a craft. The **Designer** model drafts it, using
   the full craft format and the sim's physics conventions
   (`src/gen/craftDesigner.ts → DESIGNER_SYSTEM_PROMPT`).
   With **parallel drafts** (default 2) the designer writes several independent drafts at
   once; each is tested and the best one goes on to repair.
   Designers may use up to 200 parts (the format itself allows 500); replies get up to 64K
   tokens, clamped to each model's own output limit.
2. **Validate and auto-fix.** `validateCraft` rejects malformed or out-of-range data.
   `src/gen/autofix.ts` then fixes the mistakes models make most: control gain signs (checked
   against the torque each surface makes about the CoM) and wheel springs (sized from the
   static load on each wheel). The engineer is told what was corrected.
3. **Flight test.** `src/sim/flightTest.ts` flies the craft headless through a test card: rest
   on the runway, take off, climb to 140 m, turn 90°, then fly hands-off with the elevator
   trimmed. It scores the run out of 100 and writes up actionable issues. About 150 simulated
   seconds take about 5 s (in a Web Worker in the browser); a 200-part craft about twice that.
4. **Repair.** The **Engineer** model (a different model) gets the errors or test report and
   fixes the design, until it passes or the round budget runs out.
4b. **Detail.** Once it passes, the Designer gets one more round to add visual secondary and
   tertiary geometry (armour plates, fairings, intakes, canopy frames, fender arcs, hubs,
   struts, antennas, nozzle rings, panel seams and light lines), aiming at 30-90 parts.
   `src/gen/detailer.ts` keeps the physics exactly as tested: every tested part is restored as
   it was, new parts are forced visual-only (no collider, no modules, at most 2 kg each and 2%
   of the craft's mass together) and must connect to the craft. The detailed craft is flown
   again and kept only if it still passes. "Add detail" in the Studio does the same for the
   craft you're in (built-ins too); the "Detail pass" box switches the automatic round off.
4c. **Agent** (always, in the Studio; `npm run design -- "…" --agent [--effort low|medium|high] [--think]`). Instead of one
   JSON reply per round, the designer runs the whole pipeline itself through tools
   (`src/gen/agent.ts`): `submit_craft` (a full draft), `patch` (add / update / remove parts by
   id, no rewrites), `check` (validation, floating parts), `analyze` (mass, CoM, static margin,
   wing loading, T/W, stall speed, wheels), `flight_test`, `add_detail` (after a pass; physics
   locked as in 4b) and `finish`. The harness owns the gates: every craft is validated,
   auto-fixed, connectivity-checked and restyled before it counts, and the final craft must
   pass a flight test the harness itself runs. Budgets: 28 model turns, 8 flight tests. Models
   without tool calling (or that won't use the tools) run the fixed rounds instead (CLI; the
   Studio lists only tool-calling models for the Designer, and Add detail is an agent job too).
   **Live:** replies stream. The Studio's agent console shows the model's reasoning and text as
   they arrive and every tool call and result, and the hangar turntable builds the vehicle as
   its parts stream in through `submit_craft`, `patch` and `add_detail`. *Reasoning effort*
   (Low / Medium / High) and the *flight-test budget* are in *Models & generation settings*.
   Muse Ember (`meta/muse-ember`, paid but about $0.10 / $0.50 per million tokens) is a
   recommended agent.
5. **Fly.** The best design lands on the runway and in the **hangar** (localStorage). Each
   entry records its provenance: every model that worked on it, prompt, score, rounds and cost.
6. **Refine.** After flying, "Refine current" sends the craft, your instructions, and a
   summary of your flight (stalls, crashes, lift-off speed, g range) back to the crew.
7. **Theme.** Tick *Compose a theme track for it* and the **Composer** (Lyria 3, free) writes a
   theme while the agent builds the vehicle, in a style picked from the description (light
   cycle race, solar sailer, Outlands, master control or the Grid; early-80s synth and
   orchestra). It is saved with the vehicle (IndexedDB, `src/gen/tracks.ts`; ♪ in the hangar)
   and plays through the game's own audio whenever you fly it, looping and faded in, under the
   game volume (M mutes). The Studio's Music section composes or removes the theme of the
   vehicle you're in.
   **Test bench** (Studio → "Test bench: compare models", or open the game with `?bench`):
   run the same prompt through up to eight designer models with identical settings
   (reasoning effort, flight-test budget, detail) and the same test card, one to four at a
   time, optionally several runs per model to see how consistent each is. Each run is
   measured alone (no fail-over to other models). A live table shows every run's turn and
   last tool call, then its calm and gusty scores, parts, turns, flight tests, time and cost;
   a summary ranks the models by pass rate, then mean score. Watch a run build on the
   turntable, view, save or fly any result, and download the comparison as CSV or as JSON with
   every craft. Every bench run is also kept as training data.
   There are no custom liveries: every vehicle wears the 1982 palette.
   Every vehicle, stock or generated, is also dressed by the **vehicle grammar**
   (`src/craft/grammar.ts`): the building rules applied to vehicles. From what each part does it
   adds secondary machinery (hull spines and armour plates, wingtip caps and fences, nozzle
   rings and petals, intake cowls, canopy frames, fender arcs, rotor guards) and tertiary seams
   and light lines, seeded by the craft. Lights are functional: running lights brighten when
   the vehicle is active, nozzles glow with the engine's spool and flare on afterburner,
   damaged parts flicker. It is drawn only, so it never changes how a craft flies.

### The crew: one model per job, free first

**Model search:** the Studio's *Models & generation settings* searches the whole OpenRouter
catalog by name, id or description; matches are listed first in every job's picker (the
Designer jumps to the best hit). *Tools* keeps only models that can call tools (Agent mode);
those are marked "tools" in the pickers.

**Agentic-only endpoints.** Some free endpoints may only be used through an agentic harness.
Inkling 2 Small (free, `thinkingmachines/inkling-2-small:free`) is one: it is offered for the
Designer in Agent mode only (its own group in the picker, never a default or a fallback, never
for the fixed rounds, Add detail, the Engineer or the Composer; `src/gen/catalog.ts`
`AGENTIC_ONLY`). Its provider logs prompts and outputs on the free endpoint and uses them,
disassociated from your account, to improve its models (TML Free Research API Terms of
Service, Privacy Notice); the Studio shows that notice while it is selected. Don't put
confidential information or personal data in descriptions sent to it.

| Job | Default (free) | Free backups | What it does |
| --- | --- | --- | --- |
| Designer | Nemotron 3 Ultra 550B | Nemotron 3 Nano Omni, Dots 3 Note | Drafts craft from your description |
| Engineer | Dots 3 Note | Nemotron 3 Nano Omni, Nemotron 3 Ultra | Repairs designs from validator and flight-test feedback |
| Composer | Lyria 3 Clip | Lyria 3 Pro | Soundtrack clip (audio output) |

- **Free only** is on by default, so the pickers show only free models. Turn it off to choose
  from all ~430 models, priced, with paid recommendations.
- **Rate limits:** free models are often rate-limited upstream. Every request carries the
  job's free backups, and OpenRouter fails over to the next one automatically. Backups for a
  free model are always free, so free-first never silently costs money. The hangar records
  which model actually answered.
- **Spend:** there's a per-session spend cap in the Studio (default $1), and the dev proxy has
  its own cap (`OPENROUTER_MAX_SPEND_USD`, default $2).
- **Lyria:** the Lyria models are listed at $0, but they don't have a `:free` id. OpenRouter
  refuses them on a key that is over its credit limit, so the key needs some headroom.
- **Reasoning effort:** free reasoning models can spend their whole output budget thinking and
  get cut off mid-answer. The Designer runs at medium effort, and the Engineer at
  low effort. The defaults were picked by testing each free model on a real repair; ones that still ran out
  of budget (Flint, Nemotron 3.5 Super, Cohere on long jobs) were dropped from those jobs.
- **CLI:** `npm run design -- "..." --designer <id> --engineer <id>`.

### Where the API key lives

- **Dev server** (`npm run dev`): the page calls `/api/openrouter/*`, and
  `tools/openrouterProxy.ts` adds `OPENROUTER_API_KEY` server-side. It only allows the
  models and chat endpoints.
- **Static hosting / GitHub Pages:** there's no server, so each player pastes their own
  OpenRouter key under *Key & spend*. It's stored in their browser and sent only to
  openrouter.ai. The model list is public, so the crew pickers fill in even before a key is
  entered.

### Deploying to GitHub Pages

1. Repo **Settings → Pages → Source: GitHub Actions**.
2. Merge to `main` (or run the *Deploy to GitHub Pages* workflow manually).
   `.github/workflows/pages.yml` runs the physics regression, builds with
   `BASE_PATH=/<repo>/`, and publishes `dist/`.
3. Open `https://<user>.github.io/<repo>/`. Flying works for anyone. Generation needs the
   player's own key, and free models cost nothing.

Sample output: `crafts/bushmaster-stol.json` was designed by a free model through
`npm run design`. It flies but scrapes its belly at rest; the report shows why.

## Controls

Keyboard, gamepad and touch all work, and you can mix them. Press **H** (or **?** on touch, or
Back/View on a pad) for the controls of the craft you're flying, plus settings: invert pitch,
stick expo, haptics, and touch controls auto/on/off.

**Keyboard**

| Key | Action |
| --- | --- |
| W / S | pitch down / up (ground vehicles: go / brake, and S from a stop reverses) |
| A / D | roll |
| Q / E | yaw (rudder + nose-wheel steering) |
| Shift / Ctrl | throttle up / down |
| Z / X | full / cut throttle |
| B or Space | brakes |
| T / G, Y | trim nose down / up, reset trim |
| , / . (or F6 / F7) | flaps up / down a notch (3 notches, 10° each) |
| R | new plane on the runway (the world, wreckage and weather stay) |
| Backspace | reset the whole world |
| C | chase / orbit camera |
| [ / ] | previous / next craft |
| F3 | debug: force vectors, CoM/CoL/CoT, stats, CoM slider, weather |
| N | toggle the Studio (generate / refine craft, hangar) |
| H | controls & settings |
| V (hold) | fire guns / cannon (armed craft: the tank by default) |
| O (hold) | drop bombs / fire missiles |
| I | weapons loadout: fitted (when the craft has weapon parts), unarmed, guns, cannon, guns + bombs, guns + missiles, tank, laser + discs, pulse + missiles, full |
| Tab | planet map: every vehicle in the world (or click the radar) |
| Shift+Tab | the strike globe: pick a spot, send aircraft, call in strikes, zoom in to the buildings (or the map's Globe button) |
| ` | drop the nuke or launch the EMP carried (bought in the ' panel's Armory); on foot, set it down on a fuse (or pick a set one back up) |
| ; (hold) | hacking beam on the locked target (needs a hacking charge from the Armory) |
| ← → ↑ ↓ | turret traverse and elevation (tank, or any craft with a turret part); gamepad: LB + right stick |
| / | turret back to the nose |
| Enter | chase the locked vehicle (Navigator *Chase lock*; Enter again, or the stick, ends it) |
| \\ | radar range: 2 / 5 / 12 km |

> Browsers don't let pages block Ctrl+W, so tapping Ctrl for throttle-down next to W can
> close the tab. Prefer Z/X or a gamepad if that bites you.

**Gamepad** (Gamepad API, standard mapping: Xbox, PlayStation, Switch Pro and most phone pads).
The layout follows the craft:

| | Airplane / blimp | Rotorcraft (mode 2, like an RC transmitter) |
| --- | --- | --- |
| Left stick | pitch / roll | ↕ collective (centred = hover), ↔ yaw |
| Right stick | ↔ yaw | pitch / roll (tilt) |
| RT / LT | throttle up / down | fine collective |
| LB / RB | yaw | |
| D-pad ↑ / ↓ | trim | |

Common to both: A (hold) brakes, Y new plane, LB+Y resets the world, B toggles the camera, X or D-pad ←/→ change
craft, Start opens the Studio, Back/View opens help, L3 resets trim, R3 toggles debug.
Sticks have a radial deadzone and adjustable expo. Pads rumble on crashes, broken parts and
stall onset, and a toast announces connect/disconnect.

**Touch** (phones and tablets, portrait or landscape)

The screen changes with what you are driving (`src/hud/profiles.ts`): the HUD's readouts, the
lever's name, the hints and the buttons follow the vehicle.

| Vehicle | HUD strip | Left thumb | Right thumb |
|---|---|---|---|
| Airplane | airspeed, altitude, V/S, heading, power | power lever (stays put); sideways = rudder | stick: drag down = nose up, sideways = bank |
| Helicopter | speed, altitude, V/S, heading, lift | lift lever, middle hovers; sideways = turn | stick: tilt and fly that way |
| Blimp | speed, altitude, V/S, heading, power | power lever; sideways = turn | stick: nose up / down, turn |
| Ground vehicle | speed, heading, cruise, fuel | cruise-power lever; sideways = steer | stick: up = go, down = brake (and reverse from a stop), sideways = steer |
| On foot (your Bit) | none | BOARD gets back in | stick: drag up = walk, sideways = turn; FIRE / DROP become YES / NO |

- **The HUD strip** shows only those readouts, in large type; tap it to open everything else
  (weather, fuel, battery, credits, lock, hostiles), tap again to close. Readouts that mean
  nothing for the vehicle are hidden (no AOA or flaps on a light cycle; no AOA or G on the
  ground).
- **NAV chip** under the HUD: the Navigator's mode and where it is taking you. Tap it to set a
  course.
- **Top bar** (icons): ✦ hangar and Studio, ◉ camera, ? controls (and the hints again),
  ☰ more: Navigator, Nav hold, new plane, reset world, craft selection, weather and credits,
  flaps, weapons, map, globe, on foot, mercenaries, strategic, sound, photo, fullscreen.
- **BRAKE** (hold) beside the lever; **weapons** (FIRE, DROP, HACK) in one column at the right
  edge when armed, with the stick moved clear of them. The radar sits in its own corner.
- **Hints** under each thumb show the first three times you use a kind of vehicle, then fade;
  **?** brings them back.
- **Create / Studio:** in the hangar, tap **Create**, type in **Describe your aircraft**, then
  tap **Generate aircraft**. GitHub Pages requires your OpenRouter key under **Key & spend**.
  Model choices are under **Models & generation settings**. Studio stays closed on mobile
  until opened; its ✕ closes it. Controls and weather panels have labeled close buttons.
- The layout adapts to orientation and notches (safe areas); nothing overlaps in either
  orientation. Phones render at capped resolution with smaller shadow maps to hold the frame
  rate, and vibrate on crashes.

To fly: press Z, roll down the runway, and pull back gently (S) at about 60 kt. Lift-off comes
around 65–75 kt. Open F3 and drag the CoM slider aft past the blue CoL marker to watch the plane
become pitch-unstable.

**Other vehicles** (pick them in the Studio's hangar):
- **Quadcopter / helicopter:** throttle is collective, and about 50% hovers. W/S/A/D tilt (the
  flight controller holds the attitude you ask for, and centring the stick levels it). Q/E yaw.
- **Blimp:** it's about 1% heavier than air. Add power and pitch up (S) to climb on hull lift;
  steer with the rudder.

**Weather:** the F3 panel has presets (clear, summer thermals, gusty crosswind, drizzle, heavy
rain, thunderstorm, freezing fog, snow) and sliders for wind, gusts, turbulence, temperature,
rain/snow rate, cloud cover and base, thermals, storm strength and visibility. Link straight
to one with `?weather=rain` (any preset id). The HUD shows wind relative to your nose, outside
air temperature, precipitation and cloud (IMC), and flags ICE, VORTEX RING and AQUAPLANING.
What you see comes from the same model the physics flies through: rain and snow fall with the
wind's drift, the cloud deck is drawn from the same drifting cells that make showers, thermals
and icing, fog follows visibility, and the runway darkens when wet.

## AI air traffic

Other programs fly around you (`src/sim/aiTraffic.ts`): the built-in aircraft and, in single
player, your own hangar designs (F3 → *AI air traffic*: how many, and whether yours fly too).
Civil aircraft fly real flights between the airfields and helipads within 10 km of you:

- **Aeroplanes** wait on a stand beside the runway, taxi to the hold, line up when the runway
  is free and nobody is on short final, roll, and climb straight out to the field's sector
  altitude before turning on course. They cruise at a level set by their direction of flight
  (eastbound on the odd hundreds of metres, westbound on the even), join the destination's
  pattern (downwind, base, the extended centreline), come down the 3° slope, flare, roll out,
  clear the runway and turn round for the next flight. Runways are used into the wind.
- **One aircraft per runway.** An aeroplane goes around if it is not lined up and on the slope
  700 m out, or if the runway is taken: by another aircraft, or by you. After two missed
  approaches it diverts to another field.
- **Rotorcraft** lift straight off a pad (street-level or rooftop), fly across, slow to a hover
  and let down onto another; one to a pad.
- **Separation:** traffic at the same height within 700 m (yours included) parts vertically.
- **Airships**, and everything where there is nowhere to land, wander: to a point, round it a
  while, on to another.

Everything scans its path 15 s ahead, and the circle it could turn through, and climbs over
what is in the way. The flight model is a kinematic coordinated turn (banking into turns), so
two dozen cost almost nothing; each carries a kinematic collider, so you can fly into one,
park beside one or shoot it down (it derezzes in its circuit colour and another takes its
place). Check: `npm run air`.

## Bits: the people of the Grid

Bits are people, not vehicles: hovering polyhedra with no legs to animate, who say everything
by which of four figures they show (`src/people/bit.ts`).

| State | Figure | Colour |
| --- | --- | --- |
| Idle 1 | compound of icosahedron and dodecahedron | blue |
| Idle 2 | small triambic icosahedron | blue |
| YES | octahedron | yellow |
| NO | stellated icosahedron | red |

- **They live on the lots** (`src/sim/bits.ts`). Each block of a lot adds up to six, more
  toward the downtown hubs. Outdoors they walk the kerb around their lot at their own pace,
  stand a while, turn back, and go and find a neighbour: two that meet stop, face each other,
  and one answers YES or NO. Idle, each pulses between the two blue figures. The same world
  always has the same people in the same places; they stream in around you like the traffic.
- **They live indoors too.** About three in four buildings have a room their people use
  (`inhabit` and `structureRoom` in `src/arch/InteriorGenerator.ts`): the industrial halls and
  stepped blocks that were already hollow, and now any structure with a large box mass on the
  ground or on a low foundation, which is hollowed into a *commons* with lit doorways, clear
  aisles in from each door, terminal banks along the walls, memory columns, and a meeting ring
  under a halo. A room on a foundation has steps down from its door. The slab a circuit
  structure stands on becomes an undercroft carried on columns, and a round drum (stack
  towers, control mesas) gets a ring wall with real doorways and a chamber inside. The foot of
  any other mass is opened as a shell that keeps its outline: a spire's pyramid base gets a
  lit tunnel through its thick wall into a commons, a trumpet's flare and the stepped radial
  tiers a round chamber. A radial structure or tower that still cannot be opened gets an
  entrance hall at its foot (a drum for the radial family, a battered block for towers). The
  imported kit towers have a ground-floor room cut into them at import, with lit doorways.
  Bits are at home when
  their lot comes into view, walk round the kerb to a door and go in, stand at places down the
  aisle, move about and talk, and come out again. On foot you can walk in through the same
  doors; the walls are real.
- **They react.** A vehicle bearing down on them fast, or an explosion nearby, and they say NO
  and step back from the road. One that is run over derezzes into chips.
- **You can be one.** `=` (touch: More → *On foot*) steps out of a stopped vehicle as a Bit.
  W/S walk, A/D turn, Q/E sidestep; V says YES and O says NO, and the Bits in earshot turn and
  answer. Walls stop you, kerbs and low steps don't. The vehicle stays parked where you left
  it; `=` beside it gets back in. A new vehicle (R) starts with you aboard.
- **Style your Bit.** The BIT row in the hangar card picks its idle light (bright blue, cyan or
  white), its size, which idle figure it shows (pulsing between the two, compound only or
  triambic only) and how fast it spins (`src/people/bitStyle.ts`, remembered in the browser).
  YES is always yellow and NO always red: those colours are words.
- **Errands on foot** (`src/sim/errands.ts`), the first of the roadmap's deliveries. Some
  Bits have work for you, redrawn every 90 s: a small lit cube over one indoors means a packet
  to deliver, a small lit ring over one on the kerb means it wants to be shown the way to a new
  home. Walk up and say YES (V). The TASK row in the HUD gives the distance, bearing and pay,
  and a thin beam of light stands at the destination's door. A packet is delivered when you
  walk into the destination room; an escorted Bit follows you a few metres behind, on the
  trail you walk (so never through a wall), and goes in when you reach the door. Pay is 40
  credits plus 1 for every 6 m. NO (O) drops the errand and the Bit walks home.
- **Charges by hand.** On foot, `` ` `` sets the carried nuke or EMP down where you stand on a
  fuse (nuke 60 s, EMP 15 s); the HUD counts it down. `` ` `` beside a set charge picks it back
  up, except in its last 5 s. Get clear: the fireball derezzes Bits and you on foot.
- Drawn by `src/render/BitsView.ts` (one instanced mesh per figure, so a crowd costs four draw
  calls) and `src/render/BitFigure.ts` (your own). Check: `npm run bit`.
- **Destruction reaches them.** When a building is wrecked its people say NO and run out by
  the door, and nobody goes back in. Falling rubble and blasts derez Bits, and you on foot:
  a moment later you are back in your vehicle.
- Rooms in 762 of 996 sampled structures: radial 91 of 95, towers 114 of 116, every kit tower,
  circuit 310 of 450, cavern 142 of 173, industrial 105 of 162. The rest stay solid (their
  people stay on the kerb): no mass there can be opened, or opening it costs one of the ten
  checks.
- Not yet: other players do not see you on foot; and the world still streams around your
  parked vehicle, so stay within a few hundred metres of it.

## Light-cycle traffic

Programs ride the street grid (`src/sim/traffic.ts`), two lanes each way, laying short jetwalls:

- **Following.** Each rider accelerates to its own speed for the road and keeps a time gap to
  whatever is ahead in its lane (the Intelligent Driver Model): another cycle, the end of that
  cycle's jetwall, a stop line, your vehicle. A jetwall is as long as 1.2 s of riding, so
  queues close up and nobody rides into the wall ahead.
- **Intersections.** Highway crossings are signalled: green, amber, all-red, with the greens
  running as a wave along the highways; the signals are drawn as stop bars of light (red,
  amber, pale cyan). Where a street meets a highway the highway has priority and street riders
  wait for a gap. Street crossings and dead ends are taken one rider at a time. Left turns
  give way to the oncoming lanes (and clear as the lights change); nobody enters a crossing it
  cannot leave; riders brake for a jetwall across their lane.
- **Lanes.** Left turns leave from the inner lane, right turns from the outer. Riders move over
  before a turn, pull out to pass, and drift back to the outer lane, with a square 90° jog.

Check: `npm run traffic`.

## Teams, territory and the war

Three teams hold the planet: **Cyan**, **Red** and **Amber** (`src/sim/teams.ts`). Each starts
with a third of the region cells, so territory comes in large contiguous patches
(`src/sim/territory.ts`); the planet map washes every district in its holder's colour.

**The world starts at peace.** No two teams are at war when you start or reset the world:
their turrets and aircraft hold fire, other teams patrol peacefully, and no freelancers come
out. Each pair of teams has its own war flag (Cyan-Red, Cyan-Amber, Red-Amber), and every
system asks the same question (`hostile()`), so turrets, AI pilots, radar colours and hit
rules all follow it.

- **A war starts** when your fire (rounds, missiles, a blast, a nuke or EMP over their district)
  strikes another team's aircraft or turret, when another team's player opens fire on you, or
  when you declare it on the strike globe (pick a district: *Declare war on …*). It is a war
  with that team only.
- **A cease fire** (strike globe: *Cease fire*) is accepted once the two sides have gone 30 s
  without trading fire. Backspace (world reset) restores peace everywhere.
- You can lock another team's craft at peace; firing is what starts the war. Strikes and the
  hacking beam need a war with the district's or the craft's team.
- In multiplayer a declaration or a cease fire is sent to the room (protocol v4, event `war`).

- **Pick your team** in the hangar (TEAM, above SPAWN; remembered). Your craft is restyled in
  its livery (`teamLivery` / `sideLivery`: the team's light on its bodies, within the light
  budget), and spawn sites in another team's territory say so. Your designs are saved without
  the livery.
- **Turrets take sides:** a tower turret belongs to its district's holder. Your team's never fire
  on you; those of a team you are at war with do (while you're armed), and they fire on
  aircraft of the teams they are at war with.
- **The AI war:** at war, team aircraft fight every side they are at war with, not only you (F3: *Friendly aircraft*
  0-6, *Enemy aircraft* 0-8 split between the two other teams). With nothing to fight,
  friendlies escort you and go first for anything attacking you. Enemy aircraft also attack
  turrets of the teams they fight, diving on them and firing homing missiles from outside their
  guns' reach.
- **Capture:** when the last turret of a district falls, the district goes to the team whose
  fire destroyed it (yours if you did it) and its turrets rise again in the new colours 20 s
  later. AI teams capture too, so the front line moves on its own. A world reset (Backspace)
  restores the starting map.
- **No friendly fire:** your rounds don't hurt your side's aircraft or turrets, and theirs
  don't hurt you; the lock never picks a friend.
- **Freelancers** (F3, 0-4, default 1) belong to no one and fight everyone: white light on steel.
  They never capture.
- **Mercenaries** are wingmen you hire with credits (`'`, or *Mercenaries* in the touch menu).
  You earn 100 credits per aircraft shot down, 150 per turret and 300 per district captured
  (kept between sessions; the CREDITS row). To test without earning them: F3 (on a phone: *More* → *Debug & credits*) → *Credits
  (testing)* (+1,000, +10,000, set an amount, reset), or `game.giveCredits(n)` in the console. A contract lasts five minutes and costs 200-650 by
  design (`src/sim/mercenaries.ts`), up to three at once. A mercenary flies for you whatever
  your team, in bright blue with an M on the radar; it escorts, goes for anything attacking you,
  then your enemies, and leaves when its time is up.
- **Multiplayer:** your team is sent to the room (in the hello and whenever you change it);
  other players show as friend or foe by team, team-mates are never locked, and your AI and
  turrets treat enemy-team players as foes. Territory, the AI and captures are still simulated
  by each client.

## Weapons of mass destruction

- **Railgun** (loadout *Railgun + missiles*, or fitted as a `rail` weapon module): an instant
  slug out to 4 km that punches through three things in a line (aircraft, turrets, riders,
  structure pieces), six hit points each; 0.4 shots a second, 20 rounds, a hard kick. Its streak
  lingers white-hot for half a second.
- **Nuke and EMP** (`src/sim/strategic.ts`) are bought with credits in the Armory (the `'`
  panel): nuke 1500, EMP 800, one carried at a time (remembered). **`** releases it. On foot
  as a Bit, **`** sets it down on a fuse instead (nuke 60 s, EMP 15 s; see *Bits*): it goes
  off where it stands, as if it had burst at ground level.
  - **Nuke:** a free-fall bomb dropped from the bomb bay with your craft's speed; it never homes.
    A drogue of light opens after 1.5 s and slows its fall toward 45 m/s; it arms after 4 s and
    bursts 300 m above the ground (an impact before it arms is a dud). While you carry one in the
    air, a **DROP** marker in the view and a ring on the radar show where it would burst if you
    let go now (*DUD: TOO LOW* when it couldn't arm in time). Its 400 m fireball fractures
    and flattens the structures in it (nearest first, up to the fractured-structure cap) and
    derezzes a craft inside; the shock ring out to 1.2 km derezzes aircraft, turrets and light
    cycles and wrecks a craft caught in it. Drawn as geometry and light: a flash, a fireball of
    lattice lines, a column of rings spreading into a disc, a ring racing out along the Grid.
  - **EMP:** within 800 m it destroys nothing but switches things off: aircraft lose engines and
    lights for 8 s and glide, turrets go dark for 20 s, light cycles stall, homing missiles lose
    their lock, and your own engines cut for 8 s if you're caught (the HUD flickers). It is a
    heavy missile that homes on your lock.
- **Hacking beam** (`src/sim/hacking.ts`): hacking charges come three for 600 credits from the
  Armory (up to nine, kept with the credits). Lock an enemy aircraft or turret, or a light
  cycle, within 1.5 km and in clear line of sight, and **hold `;`** (touch: *HACK*). A thin
  tether of light reaches from your nose to it, and the LOCK row counts `HACK 47%`. After 3 s
  unbroken (4 s for a turret, half that under an EMP) it is yours for 60 s and the charge is
  spent; letting go, losing the lock or the line resets it at no cost.
  - A hacked **aircraft** flies for your side in your livery, its lights flickering, escorting
    you and fighting its old side; your rounds don't hurt it (and its kills don't pay).
  - A hacked **turret** fires for your team from its tower and no longer holds its district,
    so destroying the rest captures it (and the hacked one stays yours).
  - A hacked **light cycle** rides in your colour and its jetwall can't derez you.
  - After 60 s each goes back to its old side, with a notice. The radar and the globe mark
    hacked units with an **H**.

**Airfields are safe to take off from.** No turret stands where it could reach a runway
(railgun turrets keep 3.8 km clear, gun turrets 2.1 km), and for the first 20 s after you spawn,
and while you are on a runway, nothing engages you, armed or not.

## Called-in strikes and attack orders

From the strike globe (below) you can send the war somewhere else. Wherever an order or a strike
is aimed becomes a **focus point**: turrets stream in there and aircraft are kept there just as
round your own craft, so the attack plays out for real with the same pilots, turrets and rounds
(`src/sim/strikes.ts`, `Simulation.focusPoints()`).

- **Send aircraft:** your team's friendlies and your mercenaries fly to the spot, fight anything
  within 3 km of it and circle it while it's quiet. The order ends after 3 minutes or 20 s with
  nothing left; **Recall** brings them back to escort you.
- **Strikes,** paid with credits, set out from the nearest district your team holds (at least
  3 km from the target):

  | Strike | Credits | What arrives |
  |---|---|---|
  | Missile barrage | 400 | six cruise missiles at 1.5 km, each diving (weaving) on a different enemy turret within 1.5 km of the target |
  | EMP strike | 900 | one cruise missile that bursts an EMP over the middle of the enemy turrets there |
  | Nuke bomber | 2500 | a heavy bomber in your livery flies there at 1.8 km, drops the nuke at the release point its fall predicts, and turns for home |

  Turrets on the way and at the target engage them: cruise missiles can be shot down and the
  bomber can be lost. Their kills and captures pay you like your own.

## The strike globe

`Shift+Tab` (or **Globe** on the planet map, or *Globe* in the touch menu) opens the whole
planet as a real 3D globe (`src/render/GlobeView.ts`): the surface map with the team territory
washed over it, lit from one side with a glowing limb. Drag to turn it and the wheel zooms.
Click a spot to target it: the side panel (`src/ui/StrikePanel.ts`) shows the district, who
holds it, the enemy turrets standing there and how far it is, and offers *Send aircraft*,
*Recall* and the three strikes with their ETAs. Strikes in flight show on their paths and
attack orders as rings.

- **ADS-B on everything** (`src/sim/adsb.ts`): every aircraft, light cycle, player and your own
  craft broadcasts a callsign (`RED-14`, `CYN-7`, `FRL-3`, `MRC-9`, `CIV-2`, `LC-120`, a
  player's name, `YOU`), its type, altitude, ground speed, track, vertical rate and a squawk
  code (7700 when badly hit, 7600 under an EMP). Zoomed in, each vehicle carries a tag
  (`RED-14 1,840 m ▲ 410 kt`, decluttered) and a fading minute of track. Click a vehicle for
  its live card with what it is doing (*attacking CYN-7*, *on order*, *strike run*), with
  **Target here** and **Follow**.
- **Basic and detailed:** basic draws markers; detailed draws the real aircraft models on the
  globe and the full architecture up close. It is chosen for the device (detailed on desktops,
  basic on phones and at low quality) and switchable in the panel's header (remembered).
- **Zoom right in** and the globe hands over to a close view of that spot
  (`src/render/GlobeCloseView.ts`), like a map app's 3D mode: a tilted camera over the ground
  map, the districts' buildings streamed in around it (their full procedural architecture in
  detailed mode, plain blocks in basic), the Outlands landforms, the aircraft as their models,
  light cycles, turrets, strikes and the same tags. Drag to pan, right-drag to turn and tilt,
  click to target or to pick a vehicle; zoom far out and it hands back to the globe.

In the cockpit the same broadcasts tag the nearest vehicles in the view and the nearest blips on
the radar (callsign and altitude relative to you, in hundreds of metres). The **ADS-B** button
on the radar turns both off and on.

## Networked damage

In a multiplayer room your rounds can hurt the other players (`src/net/hits.ts`). Your game
tests your rounds, beams, railgun slugs and blasts against the other players of other teams as
they are drawn on your screen, and reports each hit; the server drops any between team-mates;
the victim's game applies it only if it comes from another team, lands near where that craft
really is, and isn't part of a flood (20 a second per shooter), then damages the struck part as
a hostile round would. When a craft goes down within 12 s of someone's hit, everyone sees it in
the kill feed and the shooter earns 200 credits. Nukes and EMPs play out in every game.

## Enemy aircraft

Enemy programs fly among the traffic in their team's colours: the fast aeroplanes of the same
pool, each with its own guns and missiles and six hit points.

- **They hunt only an armed craft.** While yours carries no weapons (the Trainer, or loadout
  *Unarmed*; `I` cycles it) they patrol like everyone else. Arm it within 4 km of one and it
  turns on you; disarm, derez, or get 6.5 km away and it goes back to its patrol.
- **How they fight** (`fight()` in `src/sim/aiTraffic.ts`): lead pursuit, flying the nose onto
  where you will be when the rounds arrive (closing speed and bullet drop included), with an aim
  that wanders about half a degree. Guns inside 750 m when the nose is on; a missile from
  400-1500 m, one every six seconds. They break off to one side and climb rather than ram, then
  come round again; a hit sends them into a hard break turn. They fly the same kinematic model
  as the traffic, harder (65° of bank), and never through the ground or a structure.
- **Their fire hurts.** A round takes a share of the struck part's hit points
  (`TUNING.weaponHitShare`): wings and tails break off, and the craft derezzes when its heaviest
  part gives out, or when a warhead goes off against it. The banner reads *SHOT DOWN*.
- **Finding them:** thin red brackets mark every hostile within 6 km (brighter while it attacks,
  a ring on the screen's edge when it is out of view), with its range; the HUD's `HOSTILE` row
  gives the count, the nearest one's range and bearing and your kills, and flashes
  `UNDER FIRE`. Their lights follow the light states: dim on patrol, full in the attack,
  flickering once hit.

Hostiles are deterministic for the seed and use their own random stream, so the peaceful
traffic flies the same with or without them.

## Tower turrets

Hostile turrets stand on the flat roofs of tall towers (`src/sim/groundTurrets.ts`; F3 →
*Tower turrets*: Off / Sparse / Dense, default Sparse, remembered). Which towers carry one is a
pure function of the world seed and the district — the same towers always do, never beside a
rooftop helipad — and the ones within 5 km of you are live. Each is a red-team emplacement
(`src/craft/towerTurret.ts`): a pedestal with a lit collar, a head that traverses at 90°/s,
twin guns and a missile barrel that elevate from −10° to +85° (they shoot at aircraft overhead).

- **They watch everyone, but fire only on an armed craft.** Within 2.5 km and with a clear line
  of sight (sampled against the terrain and the towers), a turret's head follows you and its
  lights come up; while your craft carries weapons it fires its guns inside 1.8 km when the
  barrels are on your lead point, and a homing missile every 10 s from 600 m out (the `MISSILE`
  warning). Their rounds hurt like the hostile aircraft's.
- **Shooting them:** ten gun rounds (fewer with cannon or missiles) derez one; a tower brought
  down takes its turret with it. Kills count on the HOSTILE row. A destroyed turret stays down
  until the world is reset (Backspace).
- **Railgun turrets:** about one site in four (one in two on towers 120 m and up) carries a
  railgun turret instead (`RAIL_TURRET`): one long twin-rail barrel, 14 hit points, a 3.5 km
  reach. The slug is instant, so it aims straight at you; once on, it **charges for 0.8 s** (its
  lights pulse up and the HUD flashes `RAIL`) and fires if it's still on, one shot every 2.5 s,
  punching through up to three things. Break its line during the charge to dodge it. It follows
  the same rules as the gun turrets (team, armed-only, EMP, capture), and shows as a square with
  a diamond on the radar and `RAIL` on its bracket.
- **Finding them:** red brackets in view, small red squares on the radar and planet map (solid
  while firing), and they can be locked: missiles home on them and the tank's turret lays on them.

## Radar and planet map

A radar scope sits in the corner of the view (`src/hud/RadarMap.ts`): heading up, with range
rings, a north mark, the landing sites and every vehicle in range. `\` (or the range button)
steps it through 2, 5 and 12 km; a hostile or another player beyond the range sits on the rim.
`Tab` (or a click on the scope, or *Map* in the touch menu) opens the planet map: the whole
planet unrolled north-up and centred on your craft, with the city (paler where the skyline is
taller), the Outlands, the sea, every runway by name, the radar's reach, and every vehicle in
the world, counted in its header. **Globe** in its header opens the 3D strike globe (see *The
strike globe*).

Aircraft are arrowheads on their heading, outlined in their circuit colour; hostiles are solid
red, brighter while they attack; light cycles are dots in their team colour; other players are
pale diamonds with their names. Both are wrap-aware (`src/sim/contacts.ts`): a vehicle across
the planet's seam is drawn as near as it really is. The world only keeps vehicles near you
(aircraft within 12 km, light cycles on the streets around you), so that is where the map shows
them.

## Going fast: engines, parts and modules

- **No speed wall.** Rapier clamps bodies to 400 m/s × its length unit, which kept every
  craft below ~Mach 1.2; the simulation now runs at length unit 10 (4 km/s, ~Mach 13 high
  up) with its contact tolerances scaled back so collisions are unchanged
  (`TUNING.physicsLengthUnit`).
- **Compressibility** (`src/modules/compressibility.ts`): wing wave drag rises from the
  critical Mach to a peak just past Mach 1 (smaller for thin sections) and falls as
  1/√(M²−1); the lift slope follows Prandtl-Glauert then Ackeret; bodies get a transonic
  drag bump.
- **Engines:** `turbojet` (no bypass, Mach 3-4), `ramjet` (no static thrust, Mach 0.5-6, best
  2.5-4), `scramjet` (Mach 3.5-12, best 6-9, works high), `solid` booster (lit once, burns
  `burnTime` at full thrust, can't be throttled), plus the existing prop, turbofan and rocket.
  Any engine can vector its thrust (`gimbalDeg`) from the pitch and yaw stick.
- **Parts:** `cone` (nose cones, nozzles, spikes) and `capsule` (rounded fuselages, pods)
  shapes, with colliders, mass and inertia, voxel damage and rendering.
- **Modules:** `airbrake` (panels on the brake input) and `chute` (a drag chute that streams
  out on the brake at speed, one use, drawn as a canopy).
- **Weight:** modules stay massless (a part's mass covers what it carries, as every design
  already assumes), but parts can't be lighter than their modules allow: jets thrust/8g,
  props thrust/4g, rockets thrust/100g, ramjets /15g, scramjets /10g, solids their
  propellant, batteries 250 Wh/kg. The design pipeline raises a part that's too light and
  tells the model (`src/craft/moduleMass.ts`).

A ramjet dart (solid booster to Mach 2, then a ramjet) passes Mach 3.2 in `npm run engines`.

## Target lock, homing missiles and turrets

**Lock** (`src/sim/lock.ts`): while your craft carries weapons, the vehicle nearest your aim
line — the nose, or the barrel on a turreted craft — within 3 km and 20° is tracked (a thin cyan
diamond, `TRACK`), and after 1.2 s on the line it is **locked** (a solid diamond, `LOCK`, the
HUD's LOCK row, a ring on the radar and planet map). Aircraft, hostiles, light cycles and other
players can all be locked. The lock holds until the vehicle leaves 30° or 3.5 km, or derezzes.

**Homing missiles:** a missile fired while locked steers onto the target's lead point at up to
45°/s and goes off within 6 m of it (a proximity fuse); if the target leaves its 60° seeker cone
it flies on straight. Without a lock missiles fly straight, as before. **Hostile aircraft fire
homing missiles at you too**, turning at 25°/s so a hard break can shake them; while one is
tracking you the screen flashes `MISSILE`.

**Turrets** (`src/craft/turret.ts`): a craft with a part of kind `turret` (the Program Tank, or
any design that has one) turns it. The turret, its barrels (parts of kind cannon or barrel) and
anything whose id starts with `turret.` traverse at 40°/s, all the way round; the barrels and the
turret's weapons elevate from −8° to +30° at 20°/s. The arrow keys aim it (gamepad: LB and the
right stick), `/` brings it back to the nose, and the cannon and coaxial gun fire where the barrel
points. Left alone for a moment with a lock held, the turret lays the gun on the target by
itself, allowing for the shell's flight time, its drop and the target's motion (`AUTO` on the
TURRET row). The swing is visual and ballistic: the colliders stay where they are.

**Chase lock** (Navigator, `Enter` or the J panel): the aircraft chases the locked vehicle
on its own. An aeroplane flies lead pursuit, banking up to 75° and pulling the g that holds its
height in the bank, faster than the target while far and bleeding off speed on the way in, then
holds station a couple of hundred metres behind it, never below the terrain and structures
ahead. A rotorcraft holds 250 m behind and 30 m above it, nose on. It never fires: that stays
on V and O, with the locked missiles doing the aiming. The chase ends (back to Hold) when the
target derezzes or stays out of reach for 5 s, or when you move the stick.

## Structural integrity

Everything that breaks is broken into blocks by one engine (`src/world/BlockBuilding.ts`), and
the blocks bear load.

- **Load.** A block standing on the ground, or on a block that does, is part of a column and
  passes its weight straight down. Every other block hangs from the nearest columns and shares
  its weight among them. A column cell is **crushed** when it carries more than 2.5 times what
  it carried while the structure was whole (`TUNING.loadSafety`); a block **snaps off** when it
  hangs farther from a column than the structure's own longest overhang, or 24 m if that is
  more (`TUNING.maxOverhang`). The limits come from the intact structure, so nothing fails just
  for being built with a cantilever. A collapse runs over several steps: lose a fifth of a
  tower's foot and it stands, lose most of it and it comes down floor by floor.
- **Rooms.** A hollow building breaks as a hollow shell: the room stays empty in the block
  grid and its doorway stays open, and furniture and steps go to chips instead of turning into
  whole blocks.
- **Things that rest on others.** A skybridge hangs from the two buildings it spans; when one
  goes from under its end, the bridge falls. A Solar Sailer beam goes dark where its pylon has
  fallen. Rooftop pads and tower turrets already went with their tower.
- **Roads.** A crater of 5 m radius or more on a road throws up a field of solid slabs and
  closes that stretch (`src/sim/roadDamage.ts`). Red bars mark each rim. Riders turn away or
  swing round, the Navigator re-routes, and new routes avoid it. Up to 24 closures at
  once; a world reset reopens them.
- **Outlands landforms.** A mesa, pillar, dome or orb struck hard or caught in a blast is
  fractured like a building: the terrain forgets it and blocks fill its exact shape, so an
  undercut mesa collapses. A landform standing on others falls once fewer than half of them
  are left.
- Checks: `npm run buildings` (the load model), `npm run destruction` (real structures,
  bridges, pylons, landforms), `npm run drive` and `npm run traffic` (broken roads),
  `npm run bit` (people).
- Not yet: earthquakes do not break landforms; a landform broken by a direct collision (not a
  blast) is not sent to other players; broken roads are not repaired except by a world reset.

## Weapons and derez

Weapons are physical parts: a `weapon` module (`gun`, `cannon`, `missile` rail, `bomb` bay,
`laser`, `disc`, `pulse`) is fitted to a part, drawn on the craft and fired from where it sits.
Fit as many as you like; each adds its own rate of fire, and missile rails and bomb bays show
their rounds leaving them. The tank fits its cannon and coaxial gun, the jet twin cheek guns,
a missile rail under each wing and a belly bomb bay. The TRON weapons: the **laser** is an
instant beam of light out to 1.5 km, the **identity disc** ricochets off structures up to three
times, cutting what it strikes, and the tank's **pulse** bolt bounces once. Bombs are
front-heavy (they leave level and pitch nose-down into the fall) with a lit band and ring
tail; missiles and bombs draw light trails. Craft without fitted weapons can take a preset
loadout (**I** cycles them); its mounts come from the craft's geometry: a cannon at the tip of
a barrel part (else the nose), guns either side of the nose (coaxial on a turret), energy
weapons on the turret or nose, bombs under the belly, missiles under the wings.
Projectiles are integrated in `sim/weapons.ts` and swept with Rapier ray casts every step (a
600 m/s round can't tunnel through a wall), excluding the firing craft. A hit derezzes the
rider it strikes (and any within a blast), shoves loose bodies, craters structures (they
fracture into Rapier blocks), and flashes and shatters into voxels in the shooter's circuit
colour. Everything runs on Rapier: ray sweeps, impulses and fracture cover what weapons need,
so there is no second physics engine (Ammo.js) to keep in step.

**Derez.** A derezzing vehicle shatters into thousands of cubical voxels in its circuit colour
that scatter on the Grid like broken glass and stay there; about 4% are rogue red/orange
fragments that keep derezzing, flickering until they wink out. A fast-moving derez also
erupts as a high-energy splash: droplets of its energy leave the grid at the impact site on
parabolic arcs under gravity, crest and dissipate.

## Physics model

Everything below is emergent from parts and modules; nothing is scripted per vehicle.

| Effect | Where | Notes |
| --- | --- | --- |
| Rigid body, collisions | Rapier | One body per craft. Mass, CoM and inertia come from the parts plus the fuel on board. |
| Lift and drag per surface | `AeroSurface` | Airflow includes body rotation and **wind**, soft stall, control surfaces. |
| **Ground effect** | `AeroSurface` | Within about one span of the ground: higher effective aspect ratio, so more lift slope and much less induced drag (McCormick). |
| **Wind, gusts, turbulence** | `Atmosphere` | Log wind profile (calmer near the ground), "1-cosine" gusts, smooth turbulence that varies in space and time. Seeded, so every run and race gets the same weather. |
| Thrust, spool, prop falloff | `Engine` | Density-scaled. |
| **Prop torque and P-factor** | `Engine` | Reaction torque rolls the airframe against the prop. Crossflow shifts the thrust centre on the disk. Twin engines can counter-rotate. |
| **Fuel burn** | `FuelTank` + `Engine` | Fuel mass sits at each tank, and mass properties are recomputed as it burns, so the CoM moves. Engines starve when it's gone. |
| **Structural failure** | `Simulation.checkStructure` | Modules report the load they put on their part. A filtered load above the part's strength breaks it off into a free-falling **debris** body, and the craft loses its mass, lift and fuel. Reset rebuilds it. |
| **Buoyancy** | `Buoyancy` | (ρ_air − ρ_gas)·V·g with helium, hydrogen or hot air. Lift fades with altitude, so blimps find a ceiling. |
| **Blade-element rotors** | `Rotor` | Radial blade stations with a soft-stalling section polar. Inflow comes from Glauert momentum theory, solved with Newton's method. That gives translational lift, climb and descent effects, reaction torque and in-plane drag. RPM mode for drones; collective plus cyclic for helicopters. |
| **Flight controller** | `FlightController` | Angle-mode stabilisation with an automatic mixer built from rotor positions and spin directions. Helicopter mode drives the cyclic and has a yaw-rate loop on the tail rotor. |
| Wheels | `Wheel` | Raycast suspension, tyre friction, steering, brakes. **Wet runway**: grip roughly halves with a water film; above the dynamic hydroplaning speed (9·√psi kt) on standing water the tyres **aquaplane**. |
| **Standard atmosphere** | `atmosphere.ts` | ISA temperature lapse, pressure, density, speed of sound, Sutherland viscosity, with temperature offset (hot/cold day), QNH and humidity (moist air is lighter). Density altitude and Mach in telemetry. |
| **Compressibility, Reynolds** | `AeroSurface` | Prandtl–Glauert lift rise, wave drag above the critical Mach, Reynolds-number drag and stall-angle scaling (small, slow surfaces are worse). |
| **Dynamic stall, camber, flaps** | `AeroSurface` | Separation lags the angle of attack (and reattaches more slowly); camber and flaps shift zero lift and add a nose-down moment. |
| **Downwash** | `AeroSurface.link` | Tails sit in the wing's downwash, delayed by the travel time between them, which moves the neutral point forward like on a real aircraft. |
| **Slender bodies** | `Body` | Fuselage axial and crossflow drag, and the destabilising Munk moment. |
| **Rain** | `AeroSurface`, `Rotor`, `Craft` | Water film roughness costs lift and stall margin and adds drag (worse at low Reynolds number, so small drones suffer most); drop momentum; rotor blades sweeping drops need extra torque; a water film adds mass. |
| **Icing** | `AeroSurface`, `Rotor` | In supercooled cloud, ice builds fastest on thin, fast leading edges (minus kinetic heating on rotor blades). It wrecks lift and drag, adds mass, melts above freezing and sheds from fast rotors. |
| **Clouds, thermals, storms** | `Atmosphere` | Drifting cloud cells with patchy showers; thermals under cumulus with sink between; storm downdrafts with microburst outflow (wind shear near the ground). |
| **Rotor motors** | `Rotor` | Rotor inertia, a BLDC torque–speed line (drones) or power-limited governed engine (helicopters). The airframe feels motor torque, so spin-up yaws; an unpowered rotor windmills (autorotation). |
| **Rotor ground effect, VRS, gyro** | `Rotor` | Cheeseman–Bennett plus multirotor terms (Sanchez-Cuevas 2017); vortex ring state thrust loss and surging in fast vertical descent; gyroscopic precession of rigid props. |

Each vehicle type has its own automated test card (`flightTest.ts`, `vehicleTests.ts`), which
both the generation loop and the built-ins use. All four built-ins (trainer, quadcopter,
helicopter, blimp) score 100/100.

`npm run weather` checks that weather really changes flight (headless, real sim). Current results
for the 25 kg quadcopter: heavy rain (50 mm/h) needs 9% more power to hover, a downpour 25%
more; 3 minutes in −6 °C cloud puts 2.3 mm of ice on the blades and needs 83% more power;
hovering at 0.15 m takes 7% less power (ground effect); descending vertically at 6 m/s puts it
in vortex ring state. The trainer's braking distance from 30 m/s grows 37% on a wet runway and
72% on a flooded one.

## Architecture

```
src/
  tuning.ts              every feel-related constant, commented
  craft/
    types.ts             JSON craft format (parts + module defs); what the hangar will save
    testPlane.ts         the trainer, as data
    builtins.ts          quadcopter, helicopter, blimp (+ trainer) as data
    validate.ts          validates untrusted craft JSON before it reaches physics
    massProperties.ts    parts -> total mass, CoM, inertia tensor (diagonalised for Rapier)
    Craft.ts             ONE Rapier rigid body + one collider per part + force modules
  modules/
    ForceModule.ts       the module interface and StepContext
    AeroSurface.ts       lift/drag per surface, soft stall, control-surface deflection
    Engine.ts            thrust along part axis, spool lag, prop falloff, density scaling
    Wheel.ts             raycast suspension + tyre friction, steering, brakes
    Drag.ts              simple quadratic drag (the smallest example module)
    FuelTank.ts          fuel mass at the tank; burns move the CoM
    Buoyancy.ts          gas cells (helium / hydrogen / hot air)
    Rotor.ts             blade-element rotor with momentum inflow, cyclic, torque reaction
    FlightController.ts  stabilisation + automatic rotor mixing (multirotor / helicopter)
    registry.ts          def.type -> module factory, step order
  sim/
    Simulation.ts        headless sim: world, ground, fixed 120 Hz step, NaN guard, telemetry
    controls.ts          ControlInputs + ControlSource (anything that can fly the craft)
    telemetry.ts         JSON flight-state snapshot (HUD and future AI pilots)
    autopilot.ts         Autopilot (planes) and HoverPilot (rotorcraft): targets -> stick
    flightTest.ts        airplane test card + design metrics, scored report
    vehicleTests.ts      rotorcraft and lighter-than-air test cards, vehicle detection
    flightLog.ts         summary of the player's flight (feedback for Refine)
    atmosphere.ts        air density + Atmosphere (wind profile, gusts, turbulence)
    layout.ts            ground size, runway, spawn
  gen/
    openrouter.ts        browser/Node OpenRouter client: retries, cost tracking, JSON extraction
    catalog.ts           the crew: jobs -> capable models, free-first defaults + free backups
    craftDesigner.ts     designer prompt + generate/validate/flight-test/repair loop
    music.ts             composer: audio model (Lyria) -> soundtrack clip
    library.ts           hangar: saved craft with provenance (localStorage), import/export
  ui/Studio.ts           in-game generation workflow
  input/
    PlayerInput.ts       merges devices -> a ControlSource with smoothing, trim, profiles, haptics
    KeyboardDevice.ts    keyboard
    GamepadDevice.ts     Gamepad API: per-vehicle mappings, radial deadzone, expo, rumble
    TouchDevice.ts       on-screen throttle lever + floating stick + buttons (Pointer Events)
    types.ts             RawInput, actions, settings (persisted)
  ui/ControlsPanel.ts    help panel: controls per device and profile, input settings, toasts
  render/                WorldView, CraftView, CameraRig, DebugOverlay (three.js only)
  hud/Hud.ts             plain-DOM HUD
  main.ts                wires it together: fixed-step accumulator + render interpolation
scripts/headless.ts      runs the real sim in Node about 300x faster than real time
scripts/design.ts        CLI: generate + flight-test + save a craft to crafts/
tools/openrouterProxy.ts dev-server proxy that keeps the API key server-side
```

Key ideas:

- **Physics comes from the parts.** Each part has mass, a shape, a transform and optional force
  modules. `computeMassProperties` sums mass, CoM and inertia (rotated part tensors plus the
  parallel-axis theorem) and feeds them to a single Rapier body, so there are no joints and no
  wobble. Nothing is scripted: stability comes from where the surfaces sit relative to the CoM.
  For example, the wing tips are set at a lower angle than the roots (washout), so the roots
  stall first and the ailerons keep working through a stall.
- **Each physics step:** reset forces, let every module compute forces from the body state, and
  apply them with `addForceAtPoint`. Then `world.step()`. Airflow at each surface includes
  `ω × r`, so roll and pitch damping, adverse yaw and weathervaning come out of the physics.
- **The sim is separate from rendering.** `Simulation` never touches three.js scene objects,
  the DOM or input devices. It only uses three's math classes. The browser renders it with
  interpolation, and `npm run sim` runs it headless.
- **Pilots are pluggable.** Anything implementing `ControlSource.sample(dt, telemetry)` can fly:
  the keyboard/gamepad `PlayerInput`, the `Autopilot`, a replay, or later an AI pilot. In the
  browser console, `game.setPilot(...)`, `game.telemetry()` and `game.sim` are exposed.

## Adding a new force module

Example: a parachute, a rotor, or a buoyancy cell.

1. **Define its data** in `src/craft/types.ts`:
   ```ts
   export interface ParachuteDef { type: 'parachute'; offset?: Vec3Tuple; cdA: number }
   export type ModuleDef = AeroSurfaceDef | EngineDef | WheelDef | DragDef | ParachuteDef;
   ```
2. **Implement `ForceModule`** in `src/modules/Parachute.ts`. Use `Drag.ts` as the template:
   ```ts
   step(ctx: StepContext) {
     ctx.toWorldPoint(this.localPosition, p);   // craft-local -> world
     ctx.airVelocity(p, v);                     // relative to the air: rotation + wind
     // ...compute a world-space force...
     ctx.applyForce('drag', force, p);          // NaN-safe, also feeds the F3 overlay
   }
   reset() { /* clear internal state */ }
   ```
   Other context helpers: `applyTorque`, `drawFuel`, `structuralLoad(partId, N)` (so the part
   can break), `groundHeight`, `atmosphere`. Implement `link(modules)` if your module needs to
   find others (as the flight controller does with rotors).
   Expose any live state (deployment, RPM...) as public fields so the renderer can animate it.
3. **Register it** in `src/modules/registry.ts` (add a `case 'parachute'`). TypeScript's
   exhaustiveness check flags the switch until you do.
4. **Validate it** in `src/craft/validate.ts` (a range check for each field).
5. (Optional) **Visualise it** in `src/render/CraftView.ts`, and add a colour in `DebugOverlay`
   if you add a new `ForceKind`.
6. Attach it to a part in a craft definition and check behaviour with `npm run sim`.

## Tuning

All feel constants are in `src/tuning.ts`: stall angle and softness, post-stall lift and drag,
control effectiveness, spool time, tyre grip, brakes, input smoothing and more. The plane's
geometry (incidence, dihedral, washout, control throws, spring rates) is in `testPlane.ts`.
After a change, `npm run sim` prints lift-off speed, stall altitude loss and the instability
test, so you can see the effect without flying.

## Multiplayer (Grid Link)

Up to 16 programs per room share the Grid: aircraft, cars and light cycles, with their trails.
The relay is a small [Bun](https://bun.sh) server (WebSocket only, no accounts, nothing stored).

```bash
npm run server          # bun server/index.ts, ws://localhost:8787 (PORT=… to change)
npm run dev             # then press O (or the ◈ GRID LINK button): CREATE ROOM, or JOIN a code
npm run test:server     # bun test server: two clients join, relay, isolation, size limits
```

- **Invite:** COPY INVITE gives `…/?mode=fly&room=CODE&server=ws://host:8787`; opening that
  link joins straight away. The server defaults to `ws://<page host>:8787`.
- **What's shared:** each player's pose, velocity and controls at 20 Hz, drawn from their
  CraftDef and interpolated 100 ms behind; their jetwalls, ribbons and contrails (in their
  colour); structure fractures (by structure name, so everyone sees the same tower fall);
  explosions; derezzes; chat. Remote jetwalls near you are solid: ride into one and you derez.
- **Not shared:** the weather, the town's loose blocks and rubble physics (each client simulates
  its own collapse from the same fracture), and craft-to-craft collisions.
- **Deploy the relay on Render** (free, TLS included): Render dashboard → **New → Blueprint** →
  this repository. `render.yaml` builds `server/Dockerfile` (Bun) into a web service at
  `https://grid-relay.onrender.com` (or the name Render gives it), health-checked on `/health`,
  redeployed when `server/` or the protocol changes on `main`. Then repo **Settings → Secrets
  and variables → Actions → Variables → `GRID_SERVER` = `wss://grid-relay.onrender.com`** and
  re-run the Pages deploy: every player's Grid Link connects there by default (a typed server
  or an invite's `?server=` still wins). Free instances sleep after 15 idle minutes (the first
  player waits about a minute; sleeping drops open rooms); the `starter` plan stays up.
  Locally: `docker build -f server/Dockerfile -t grid-relay . && docker run -p 8787:8787 -e PORT=8787 grid-relay`.
- **Server:** `GET /health` reports rooms and players. Messages are shape-checked, size-capped
  (32 KB, 256 KB for a craft) and rate-limited; silent players are dropped after 20 s.
  Protocol: `src/net/protocol.ts` (versioned; client and server share it). Room logic:
  `server/rooms.ts`. Client: `src/net/NetClient.ts`, `src/render/RemoteCraftView.ts`,
  `src/ui/MultiplayerPanel.ts`. Not connected, the game is single-player as before.

## Disasters

F3 has explicit **Tornado**, **Hurricane**, **Earthquake**, and **Clear events** buttons.
In the game, **tornadoes also form at random** (weather panel: *Random tornadoes*): seeded,
one at a time, 1.4-3.2 km from you, heading roughly your way. Headless runs have no random
events. Tornadoes move along seeded paths, add Rankine-vortex swirl/inflow/updrafts, and are
drawn as a solid mass: a dark, opaque funnel that sways and carries rotating spiral striations
under a wall cloud, with a dust skirt and a debris cloud of voxel fragments orbiting its base. Hurricanes add a
Holland wind field and spiral rain bands; earthquakes physically shake the runway with an
analytic, seeded ground motion. Reset clears the event timeline.

The headless API is `sim.atmosphere.events`: `trigger(kind, { x, z, duration, strength })`,
`schedule(kind, absoluteWeatherTime, options)`, `clear()`, `groundAcceleration()` and
`surgeHeight(x, z)`. Weather time restarts on reset. Additional smoke/wind sources may register
an additive callback in `sim.atmosphere.windContributors`. Browser helpers are
`game.worldEvents` and `game.triggerDisaster(kind)`. `npm run events` checks deterministic
wind, surge, rain, scheduler lifecycle and actual Rapier ground motion.

## Roadmap

1. **Flight core** ✅
2. Hangar: snap-together parts, craft saved as JSON part graphs
3. Procedural world: noise terrain, chunk loading in workers, floating origin
4. Rotor module: multirotor drones (blade element rotors + PID flight controllers) ✅
5. Missions: deliveries between generated points of interest (begun: packet and escort errands on foot)
6. Helicopters ✅, blimps ✅, VTOL (next: tilt-rotors from the same Rotor module)
7. **The Grid as a planet** (in progress): R 8 km, wraps around, real orbits ✅, curved
   rendering ✅; next: dense procedural city over the whole globe (streamed in chunks),
   neon terrain and oceans, airports and helipads in every region.
8. **Ground vehicles**: wheel-based craft built from the same parts and Wheel module, with
   steering, drive and brakes from the controls. Light cycles first: two-wheel neon bikes that
   lean into turns and leave solid light walls behind them on the data highways (a jet wall
   you crash into, destructible like everything else). Then cars, trucks and tanks.
9. **Multiplayer** (needs a backend server):
   - A small authoritative relay (WebSocket, later WebTransport) that holds rooms, assigns a
     host, and fans out state. Static hosting (GitHub Pages) stays for the client; the server
     is a separate deploy (e.g. a Node or Cloudflare Durable Object service).
   - Each player simulates their own craft (the sim is deterministic per step) and sends
     inputs plus periodic state snapshots at 20-30 Hz; others are interpolated, with
     dead-reckoning between snapshots.
   - Shared world state: destruction events (which structure fractured, crater, quake seed)
     replicate as events, not as block positions, so everyone's Grid breaks the same way.
   - Modes: free flight, races (the LLM racing work becomes "humans vs models"), light-cycle
     arenas, and co-op deliveries. Room codes and share links; craft travel as JSON.
   - Later: accounts, persistent hangars and leaderboards (needs storage on the server).
10. **Portals and planets.** Planets are linked by a persistent network of paired portals
    ([design](docs/campaign-design.md#6-portals)).
    - Every planet has its own id, seed, generator version and surface configuration; cities,
      provinces and structures carry planet-scoped ids.
    - A portal terminal is a structure of the radial/communication family (§2E) at the end of a
      pathed road, so the Navigator can route any ground vehicle to it. A closed terminal
      is a closed road (§14).
    - Crossing is server-confirmed: the server checks access, reserves the transfer and moves
      the player and vehicle once to a safe arrival point. The client reloads into the
      destination planet behind a short transit screen. A disconnect or retry can neither
      strand nor duplicate anyone. (A seamless in-place swap comes later.)
    - Dormant portals are discovered and activated during a season. The server resolves and
      stores the destination before the route opens, so everyone who activates the same gate
      reaches the same planet.
    - A generated planet arrives with several working cities, at least one of them routed to
      the arrival portal, built by the same city and architecture generators.
    - Freight crosses too: surface travel, queues and handling take time, terminals have
      capacity, and access is a matter for treaties.
    - Checks: `npm run portals`.
11. **Campaign: a persistent city-builder RTS.** One season is one continuous match on server
    time ([design](docs/campaign-design.md)). It sits beside the Studio, flight, driving,
    exploration and Grid Link, which stay as they are.
    - **Cities and mayors.** Each player governs a city: lays roads (snapped to the street
      lattice at first), zones housing and industry, places utilities, sets budgets and
      reserves, and connects to a regional freight terminal. Road layout and traffic decide
      delivery capacity and growth.
    - **Countries and provinces.** A team is a country of several player-run cities and the
      provinces round them (region cells). Mayors run their cities; the country holds the
      treasury, intercity infrastructure, foreign policy and defence, and votes on major
      commitments. Sovereignty, occupation, facility operation and treaty access are tracked
      separately.
    - **Flows.** Food, fuel and construction materials, commuters and services move on the
      real road graph; offscreen traffic is aggregated. Cities specialise.
    - **Peace is play.** Trade and transit treaties with enforceable terms, shared
      infrastructure, founding settlements, ratified province exchanges, voluntary accession
      and leases. A season can be peaceful from opening day to the finale.
    - **War is a choice** (a later milestone): telegraphed mobilisation, bridges, depots and
      terminals as objectives, occupation distinct from sovereignty, ratified settlements.
    - **Offline play.** Standing orders for imports, exports, reserves and defences, and a
      report on return.
    - **Seasons and scoring.** Scores reward reliable services, fulfilled contracts and
      useful shared infrastructure. The season is archived, then territory, armies and
      stockpiles reset; cosmetics and district blueprints carry over.
    - **Three seasons are planned** as one story ([seasons](docs/seasons.md)): First Light,
      Open Gates and The Dimming. How each season ends adjusts the next one's world and
      story, never a team's starting resources.
    - **Server-authoritative.** Validated idempotent commands on the Bun server beside the
      Grid Link relay, hosted on Render, with durable state in Supabase Postgres and sign-in
      through Supabase Auth. Everyone sees the same world live: a building knocked over falls
      for every player on that planet and stays down for those who arrive later.
    - **Single player is the same game:** the same rules, seasons and story, run in the browser
      with computer-run countries; it can be paused and sped up. Every season starts at peace.
    - **Players who leave.** Guests can join without signing up. An absent mayor's city runs
      on standing orders, then under a caretaker, then the seat reopens; votes count active
      members only. The sandbox keeps its
      local resets, free team switching and last-turret captures.
    - **First playable slice:** Cyan and Amber on the Grid, two cities each, a shared freight
      crossing, one dormant portal to a generated second planet, one national vote, one
      transit treaty, one peaceful province transfer and a scheduled bridge closure.
    - Checks: `npm run campaign`, `bun test server`.

Generation roadmap, using more of OpenRouter's model types:

- **LLM pilots and races** (next). The `pilot` task: a model receives JSON telemetry every few
  seconds and sets autopilot targets or waypoints. Races run headless, faster than real time,
  model against model on the same craft and course, with replays.
- **Generated courses and missions.** Text models emit gate lists and delivery jobs as
  validated JSON, flight-tested for feasibility like craft are.
- **Radio chatter.** Speech models for ATC and race commentary. Transcription for voice
  commands.
- **Adaptive music.** The Composer exists. Next is making the soundtrack follow the flight
  (calm cruise, tense stall, race finale).
- **Embeddings** for searching the hangar and part library by description.
- **Video** models for race trailers from replays.
- **Procedural worlds** (Stage 3) seeded and themed by a model: biome palette, landmarks,
  airports.


### Lightning, static and fire

Thunderstorm intensity drives seeded lightning. Descending leaders intercept nearby tall
buildings or aircraft, damage parts along an entry-to-exit path, couple surges into avionics,
and can ignite fuel tanks. Precipitation and storm fields build airframe static, shown as
violet St. Elmo coronas; charge leaks away in clear air. Thunder arrives after distance / 343
seconds of simulation time, so pausing flight also pauses the delay.

Finite per-part combustible mass burns, heats adjacent parts, consumes real tank fuel, weakens
hot structure, and produces a smoke updraft. Detached parts stop contributing to the attached
aircraft fire model. Neon leaders, wire flames and smoke rings follow that headless state.
Reset repairs damage, restores fuel and clears hazards.

Run `npm run hazards` for deterministic strike, heat propagation, burnout, electrical damage,
and reset regressions. In the browser console, `game.sim.triggerLightning()` triggers a strike
near the aircraft using the same conductor rules; `game.sim.fire.ignite(partId)` starts a fire.


## The digital world (1982)

The world is generated in the visual language of the original 1982 TRON digital world (see
[AGENTS.md](AGENTS.md) for the rules, [docs/architecture-grammar.md](docs/architecture-grammar.md)
for how it works). Open **`explore.html`** (the Digital World Explorer) to fly or walk through it
with the debug panel and the archetype lab; in the game, **K** opens the inspector.

- **Hierarchy:** World → Region → District → Structure → Component, all from one seed. Seven
  civilised region identities (control centres, machine cities, industrial zones,
  communication districts, transport networks, open plains, electronic caverns) and five
  Outlands archetypes (grid plains, Sea of Simulation, electronic canyons, geometric wastelands,
  mechanical caverns), blended at their borders.
- **Five architectural families** (circuit-board structures, monumental processing towers,
  industrial megastructures, electronic caverns, radial/communication structures) plus the
  imported kit towers, each structure validated by ten architectural checks. Accessible halls
  have real interiors you can drive or walk into.
- **Weather in the same language:** raymarched volumetric clouds shaped by the simulation's own
  cloud cells (the ones that rain, ice and buffet you), shaded in posterised airbrush bands with
  a warm rim and a survey grid on their bases; from altitude the planet's limb glows through a
  stylised scattering shell. The flat gridded deck remains on `?quality=low`.
- **Light is architecture:** selective edges and emissive faces by role (structure, data,
  energy, entrance, process, warning) and per-structure activity states (active, idle, damaged,
  inactive). Painted skies and haze follow the region below.
- **Roads:** every road is on one network. The Navigator's **Go to** drives ground
  vehicles there (J): right lane, corner speeds, re-routing. Ground vehicles start on a road.

## The Grid (city, airport, autopilot)

- **The Grid** covers the land with procedurally generated districts (see *The digital world*
  above): data highways every sixth street with light-cycle traffic, a ~490 m Grid Spire at
  the main hub, landmarks at every hub, Solar Sailer routes between them. The airport keeps real obstacle-limitation
  zoning (airfield clear, approach/departure funnels rising 2%, a 40 m climb-out corridor).
- **Everything is destructible.** Every structure is a block grid: cheap static colliders while
  intact (streamed within 1 km of the craft), fractured into breakable blocks on a hard hit.
  Blocks around the impact die, a BFS anchor check from the ground-level blocks finds what is
  still supported, and everything else falls as rigid-body rubble that shatters on landing.
  Aircraft break apart too: a wing that hits a tower detaches and the lift goes asymmetric.
- **Aircraft voxels and explosions.** Every part is a 0.25 m voxel grid. Hard contacts bite
  voxels out at the contact point and throw glowing chips (buildings chip too); a damaged part
  is drawn voxel by voxel, keeps mass, lift and thrust in proportion to what is left, and
  breaks off below 35%. A crash that changes the craft's velocity by more than 30 m/s in
  0.15 s blows it up: fireball, shockwave, boom, the parts thrown clear and nearby buildings
  cratered. Four seconds later a new plane appears on the runway, the wreckage left where it
  is (R does the same any time); Backspace rebuilds the whole world.
- **Earthquakes** bring the city down: intact structures within 1.2 km of the craft whose tops
  would shake past their strength (tall, slender towers and raised highways first) fracture,
  then the shaking knocks blocks out and whatever they held up falls as rubble.
- **The Outlands.** Immense abstract landscapes outside the cities (~24% of the land), in five
  archetypes blended at their borders: grid plains with elevated platforms, the Sea of
  Simulation's pale domes and floating orbs, electronic canyons of stepped mesas and narrow
  passages, sparse geometric wastelands, and mechanical caverns of roof slabs on pillars. Every
  landform is an exact convex solid that physics collides with (`src/arch/DigitalTerrainGenerator.ts`).
  Outlands highways (every 37th street line) cut clean through, and sparse landmarks stand deep
  inside, linked by Solar Sailer routes.
- **Outlands vehicles.** Street light cycles are not built for rocky ground. Built for it: the
  **Light Crawler** (six-wheel drive, counter-steering rear axle), the **Light Runner** (fast
  four-wheel drive on tall wheels), the **Light Snowmobile** (two steering skis and a driven
  track) and the **Outlands Light Cycle** (big wheels, long travel, two-wheel drive). All on
  long-travel suspension; `npm run ground` drives them across an Outlands rubble field.
- **The system boundary.** The edge of the Grid sits at 100 km, above every orbit: anything
  that crosses it derezzes. The HUD warns from 85 km (`TUNING.systemBoundary`).
- **Light cycles and trails (Rule 4: movement produces visible information).** The Light Cycle
  (built-ins) drives on the streets: W go, S brake, A/D steer; a gyro stabiliser keeps it
  upright, leaning into turns. **L** cycles its trail: **jetwall** (solid light: ride into
  one and you derez) → **light ribbon** (fades ~90 m behind, solid only while lit, so it never
  permanently blocks open ground) → **off**. When a cycle derezzes or respawns, its trails
  derez with it. **Every vehicle has light ribbons**: craft without their own trail get them
  automatically, from the outermost points on each side for aircraft (wingtips, rotor arms, a
  blimp's flanks; light only, dissolving a speed-scaled distance behind) or a rear jetwall for
  ground vehicles. Check: `npm run trails`.
- **Light Car and Program Tank (built-ins).** The **Light Car** is a four-wheel neon runabout
  (cyan lines, red and amber accents): front wheels steer, rear wheels drive, and it lays a
  jetwall / light ribbon from its tail. The **Program Tank** is heavy, slow, fully
  reinforced and armoured (`armor: 4`: four times the strength, impact HP and crash
  tolerance), on six road wheels per side, and lays a red jetwall. It **bulldozes** through
  structures it drives into (they fracture into Rapier blocks it shoves aside) and carries a
  cannon and coaxial gun. It **skid-steers**: a wheel
  with `skid: 1 | -1` (its side) is driven by the yaw channel, the two sides in opposite
  directions, so A/D turns it on the spot. Both score 100/100 on the ground card in calm and
  moderate weather and drive down the Outlands highways. Check: `npm run ground`.
- **Spawn anywhere (hangar → craft card → Spawn).** Any runway (its threshold, facing down the
  strip), any helipad (its centre, at pad height: rooftops too) or, for ground vehicles,
  **Nearest street** (a clear point on the street grid nearest to where the craft was). The
  choice lasts the session: R, the automatic respawn after a crash and Backspace's world reset
  all use it. `window.game.spawnAt(id)` does the same from the console.
- **Reinforcement (hangar → craft card → Reinforce):** levels 0-3 per part, each +15% part
  mass, +60% strength and +80% impact HP. Saved with the craft; designers can set it too.
- **Airport:** taxiway, apron, terminal with jet bridges and parked airliners, control tower and
  beacon, runway/approach/taxi lights with sequenced flashers, working PAPIs, a windsock that
  follows the real wind.
- **Autopilot (U / gamepad R3 / touch "Autopilot"):** holds heading, altitude and speed (hover,
  heading and forward speed on rotorcraft), takes off by itself from the runway, and climbs to
  clear buildings ahead. While engaged, stick pitch/roll and the throttle adjust its targets.
- **The Navigator** (J, the **NAV** chip on screen, or touch More → *Navigator*; it used to be
  called the flight computer): one computer for every way of getting about, always on screen as
  the NAV chip, which shows what it is doing and where it is taking you. MechJeb-style modes on
  top of the autopilot (`src/sim/flightAutopilot.ts`, navigation in `src/sim/nav.ts`): Hold (or
  a V/S hold), Takeoff, Land (airplanes: join → initial fix → 3° glideslope and localizer →
  flare → rollout on a runway long enough, at 1.3 × the design's stall speed; rotorcraft: any
  helipad, rooftops included), Go to (every landing site, the hubs and the Grid Spire, clearing
  buildings and terrain, then Orbit), Orbit and Level. Ground vehicles: Go to drives the road
  network. **On foot** (`src/sim/footNav.ts`): *Walk to* takes your Bit to a destination along
  the roads, on the kerb, and *Back to vehicle* (also U on foot) walks it back and gets in. The
  HUD shows approach guidance while landing; a firm stick input (or walking yourself) takes
  over. Blimps are not flown by it yet. The airplane test card ends with an autoland.

Checks: `npm run city`, `npm run autopilot`, `npm run navigator`, `npm run destruction`, `npm run design-pipeline`.

### Credits

Volumetric clouds and atmosphere scattering: rewritten in a stylised form for this renderer from
"Universal Planetary Volumetric Clouds & Scattering Atmosphere Engine"
(https://github.com/leoawen/volumetric_cloud_atmosphere_scattering) by Leonardo Soares
Gonçalves, MIT License (`src/render/arch/VolumetricClouds.ts`, `SkyAtmosphere.ts` scatterNode).

Tower kit: This work is based on "Tron Buildings 1"
(https://sketchfab.com/3d-models/tron-buildings-1-88ca3618bfbe42dea14f5b438250c9e2) by
SpringSociety (https://sketchfab.com/jcreadingtutor) licensed under CC-BY-4.0
(http://creativecommons.org/licenses/by/4.0/). Converted with `npm run import-towers`
(baked, re-oriented, voxelized into block grids, and a ground-floor room with doorways cut into
each tower); original files in `assets/towerKit/`.

Bit figures: "BIT" by Fernando Jerez, licensed under CC-BY 4.0
(http://creativecommons.org/licenses/by/4.0/), built on polyhedra from Kit Wallace's OpenSCAD
generator (http://kitwallace.co.uk/3d/solid-index.xq), George Hart's stellations of the
icosahedron (https://www.georgehart.com/virtual-polyhedra/stellations-icosahedron-index.html)
and David McCooey's coordinates. Converted with `npm run import-bit` (welded, centred, Y-up,
unit radius); the four figure files are in `assets/bit/`. The printing stands are not used.
