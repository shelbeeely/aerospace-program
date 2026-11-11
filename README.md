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
npm run drive          # road network: one graph, every destination by road, the flight computer driving
npm run weapons        # weapons: fitted multiples, cannon cratering, tank bulldozer, bombs, missiles, laser, discs, armour
npm run craft          # vehicle rules: connected parts, the 1982 palette, the vehicle grammar, ground-vehicle design loop (offline)
npm run engines        # fast flight: compressibility, ramjet/scramjet/solid/turbojet, thrust vectoring, airbrake, chute, cone/capsule parts, weight floors
npm run air            # AI air traffic: count, clearance, destinations and circling, shot down and replaced
npm run orbit          # the flight computer's "To orbit" mode flies the Orbiter to a stable orbit
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

- **Left thumb:** a throttle lever. Drag up or down and it **stays** where you leave it; on
  rotorcraft the middle is hover. Drag sideways for yaw, which springs back.
- **Right thumb:** a floating stick that centres where you touch. Drag down for nose up, sideways
  to roll. It springs back.
- **BRAKE** (hold). The top bar has **Hangar**, **Camera**, **Controls**, and **More**.
  **More** contains New plane, Reset world, craft selection, weather, flaps, sound, photos and fullscreen.
- **Create / Studio:** in the hangar, tap **Create**, type in **Describe your aircraft**, then
  tap **Generate aircraft**. GitHub Pages requires your OpenRouter key under **Key & spend**.
  Model choices are under **Models & generation settings**. Studio stays closed on mobile
  until opened; its ✕ closes it. Controls and weather panels have labeled close buttons.
- The layout adapts to orientation and notches (safe areas). Portrait gets a compact HUD strip
  and the Studio as a bottom sheet; landscape gets a corner HUD and the Studio as a side
  drawer. Phones render at capped resolution with smaller shadow maps to hold the frame
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
Each picks a destination 1.5-6 km from you, flies there, circles for 30-90 s, then picks
another; it scans its path 15 s ahead (and the whole circle before circling) and climbs over
anything in the way. The flight model is a kinematic coordinated turn (banking into turns), so
two dozen cost almost nothing; each carries a kinematic collider, so you can fly into one or
shoot it down (it derezzes in its circuit colour and another takes its place).

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
events. Tornadoes travel winding, seeded tracks (~9 m/s, random ones 7-20 m/s, swinging on
slow sine terms rather than sliding on a ruler line) and carry a Rankine-vortex wind: swirl, a
surface "corner flow" inflow about as strong as the swirl near the ground, and a core updraft
of 0.7x the peak swirl. They leave a **path of destruction**: every loose body nearby (rubble,
craft debris, a ground vehicle you're driving) feels bluff-body drag on that wind, up to 3x in
the core (pressure deficit, suction vortices), so things are drawn in and taken up the funnel;
the core tears through every structure it crosses (blocks ripped out whole as flying rubble,
more shredded, what they held up falls), catches riders and their light walls, takes aircraft
flying low through it, and scours a scar into the grid every ~30 m of its track
(`sim.tornadoToll` counts it). Tornadoes are drawn as a solid mass: a dark, opaque funnel that sways and carries rotating spiral striations
under a wall cloud, with a dust skirt and a debris cloud of voxel fragments orbiting its base. Hurricanes add a
Holland wind field and spiral rain bands; earthquakes physically shake the runway with an
analytic, seeded ground motion. Reset clears the event timeline.

The headless API is `sim.atmosphere.events`: `trigger(kind, { x, z, duration, strength })`,
`schedule(kind, absoluteWeatherTime, options)`, `clear()`, `groundAcceleration()` and
`surgeHeight(x, z)`. Weather time restarts on reset. Additional smoke/wind sources may register
an additive callback in `sim.atmosphere.windContributors`. Browser helpers are
`game.worldEvents` and `game.triggerDisaster(kind)`. `npm run events` checks deterministic
wind, surge, rain, scheduler lifecycle, actual Rapier ground motion, and the tornado's winding
track, inflow, lofting of loose objects and its path of destruction through a structure.

## Roadmap

1. **Flight core** ✅
2. Hangar: snap-together parts, craft saved as JSON part graphs
3. Procedural world: noise terrain, chunk loading in workers, floating origin
4. Rotor module: multirotor drones (blade element rotors + PID flight controllers) ✅
5. Missions: deliveries between generated points of interest
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
- **Roads:** every road is on one network. The flight computer's **Go to** drives ground
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
- **Flight computer (J / touch More → "Flight computer"):** MechJeb-style modes on top of the
  autopilot (`src/sim/flightAutopilot.ts`, navigation in `src/sim/nav.ts`): Hold (or a V/S
  hold), Takeoff, Land (airplanes: join → initial fix → 3° glideslope and localizer → flare →
  rollout on a runway long enough, at 1.3 × the design's stall speed; rotorcraft: any helipad,
  rooftops included), Go to (every landing site, the hubs and the Grid Spire, clearing
  buildings and terrain, then Orbit), Orbit and Level. The HUD shows approach guidance while
  landing; a firm stick input takes over. The airplane test card ends with an autoland.

Checks: `npm run city`, `npm run autopilot`, `npm run destruction`, `npm run design-pipeline`.

### Credits

Volumetric clouds and atmosphere scattering: rewritten in a stylised form for this renderer from
"Universal Planetary Volumetric Clouds & Scattering Atmosphere Engine"
(https://github.com/leoawen/volumetric_cloud_atmosphere_scattering) by Leonardo Soares
Gonçalves, MIT License (`src/render/arch/VolumetricClouds.ts`, `SkyAtmosphere.ts` scatterNode).

Tower kit: This work is based on "Tron Buildings 1"
(https://sketchfab.com/3d-models/tron-buildings-1-88ca3618bfbe42dea14f5b438250c9e2) by
SpringSociety (https://sketchfab.com/jcreadingtutor) licensed under CC-BY-4.0
(http://creativecommons.org/licenses/by/4.0/). Converted with `npm run import-towers`
(baked, re-oriented, voxelized into block grids); original files in `assets/towerKit/`.
