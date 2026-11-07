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
2. **Validate.** `validateCraft` rejects malformed or out-of-range data.
3. **Flight test.** `src/sim/flightTest.ts` flies the craft headless through a test card: rest
   on the runway, take off, climb to 140 m, turn 90°, then fly hands-off with the elevator
   trimmed. It scores the run out of 100 and writes up actionable issues. About 150 simulated
   seconds take about half a second.
4. **Repair.** The **Engineer** model (a different model) gets the errors or test report and
   fixes the design, until it passes or the round budget runs out.
5. **Fly.** The best design lands on the runway and in the **hangar** (localStorage). Each
   entry records its provenance: every model that worked on it, prompt, score, rounds and cost.
6. **Refine.** After flying, "Refine current" sends the craft, your instructions, and a
   summary of your flight (stalls, crashes, lift-off speed, g range) back to the crew.
7. **Paint and score.** The **Painter** does a livery and the **Composer** a soundtrack.

### The crew: one model per job, free first

| Job | Default (free) | Free backups | What it does |
| --- | --- | --- | --- |
| Designer | Nemotron 3 Ultra 550B | Nemotron 3 Nano Omni, Dots 3 Note | Drafts craft from your description |
| Engineer | Dots 3 Note | Nemotron 3 Nano Omni, Nemotron 3 Ultra | Repairs designs from validator and flight-test feedback |
| Painter | Cohere North Mini | Nemotron 3.5 Super, Dots 3 | Text models design a pattern (stripes, camo, sunburst…) that the game draws. Pick an image model to paint a texture instead (paid). |
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
  get cut off mid-answer. The Designer runs at medium effort, and the Engineer and Painter at
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
| W / S | pitch down / up |
| A / D | roll |
| Q / E | yaw (rudder + nose-wheel steering) |
| Shift / Ctrl | throttle up / down |
| Z / X | full / cut throttle |
| B or Space | brakes |
| T / G, Y | trim nose down / up, reset trim |
| R | reset to runway |
| C | chase / orbit camera |
| [ / ] | previous / next craft |
| F3 | debug: force vectors, CoM/CoL/CoT, stats, CoM slider, weather |
| N | toggle the Studio (generate / refine / paint craft, hangar) |
| H | controls & settings |

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

Common to both: A (hold) brakes, Y resets, B toggles the camera, X or D-pad ←/→ change
craft, Start opens the Studio, Back/View opens help, L3 resets trim, R3 toggles debug.
Sticks have a radial deadzone and adjustable expo. Pads rumble on crashes, broken parts and
stall onset, and a toast announces connect/disconnect.

**Touch** (phones and tablets, portrait or landscape)

- **Left thumb:** a throttle lever. Drag up or down and it **stays** where you leave it; on
  rotorcraft the middle is hover. Drag sideways for yaw, which springs back.
- **Right thumb:** a floating stick that centres where you touch. Drag down for nose up, sideways
  to roll. It springs back.
- **BRAKE** (hold), and a top bar with reset, camera, previous/next craft, Studio, debug and
  weather, help, and fullscreen (where the browser supports it).
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

**Weather:** the F3 panel has wind speed and direction, gusts and turbulence. The HUD shows the
wind relative to your nose.

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
| Wheels | `Wheel` | Raycast suspension, tyre friction, steering, brakes. |

Each vehicle type has its own automated test card (`flightTest.ts`, `vehicleTests.ts`), which
both the generation loop and the built-ins use. All four built-ins (trainer, quadcopter,
helicopter, blimp) score 100/100.

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
    livery.ts            painter: text model -> pattern spec -> canvas, or image model -> texture
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

## Roadmap

1. **Flight core** ✅
2. Hangar: snap-together parts, craft saved as JSON part graphs
3. Procedural world: noise terrain, chunk loading in workers, floating origin
4. Rotor module: multirotor drones (blade element rotors + PID flight controllers) ✅
5. Missions: deliveries between generated points of interest
6. Helicopters ✅, blimps ✅, VTOL (next: tilt-rotors from the same Rotor module)

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
