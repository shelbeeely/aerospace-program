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

1. **Design.** In the Studio (N), pick a designer model and describe a craft. The model gets
   the full craft format and the sim's physics conventions
   (`src/gen/craftDesigner.ts → DESIGNER_SYSTEM_PROMPT`).
2. **Validate.** `validateCraft` rejects malformed or out-of-range data and returns the
   errors to the model to fix.
3. **Flight test.** `src/sim/flightTest.ts` flies the craft headless through a test card: rest
   on the runway, take off, climb to 140 m, turn 90°, then fly hands-off with the elevator
   trimmed. It scores the run out of 100 and writes up actionable issues. Problems go back to
   the model until it passes or the round budget runs out. About 150 simulated seconds take
   about half a second.
4. **Fly.** The best design lands on the runway and in the **hangar** (localStorage). Each
   entry records its provenance: model, prompt, score, rounds and cost.
5. **Refine.** After flying, "Refine current" sends the craft, your instructions, and a
   summary of your flight (stalls, crashes, lift-off speed, g range) back to the designer.
6. **Paint.** A painter (image-output) model generates a livery texture for the craft.

Models are chosen **per task** from the live OpenRouter catalog (`src/gen/catalog.ts`): text
models for design, image models for liveries, and the slots are ready for audio and others.
Spend is shown per session. The dev server enforces a hard cap (`OPENROUTER_MAX_SPEND_USD`,
default $2), and free models are listed separately.

**API keys never reach the browser.** The page calls `/api/openrouter/*` on the Vite dev
server, and `tools/openrouterProxy.ts` adds the key server-side and allows only the models
and chat endpoints. This is for local play only. A public deployment needs a real backend
with user auth and rate limits.

Sample output: `crafts/bushmaster-stol.json` was designed by a free model through
`npm run design`. It flies but scrapes its belly at rest; the report shows why.

## Controls

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
| F3 | debug: force vectors, CoM/CoL/CoT, stats, CoM slider |
| N | toggle the Studio (generate / refine / paint craft, hangar) |
| H | toggle help |

Gamepad (standard mapping): left stick pitch/roll, right stick or bumpers yaw, triggers
throttle, A brake, Y reset, Back camera.

> Browsers don't let pages block Ctrl+W, so tapping Ctrl for throttle-down next to W can
> close the tab. Prefer Z/X or a gamepad if that bites you.

To fly: press Z, roll down the runway, and pull back gently (S) at about 60 kt. Lift-off comes
around 65–75 kt. Open F3 and drag the CoM slider aft past the blue CoL marker to watch the plane
become pitch-unstable.

## Architecture

```
src/
  tuning.ts              every feel-related constant, commented
  craft/
    types.ts             JSON craft format (parts + module defs); what the hangar will save
    testPlane.ts         the Stage 1 plane, as data
    validate.ts          validates untrusted craft JSON before it reaches physics
    massProperties.ts    parts -> total mass, CoM, inertia tensor (diagonalised for Rapier)
    Craft.ts             ONE Rapier rigid body + one collider per part + force modules
  modules/
    ForceModule.ts       the module interface and StepContext
    AeroSurface.ts       lift/drag per surface, soft stall, control-surface deflection
    Engine.ts            thrust along part axis, spool lag, prop falloff, density scaling
    Wheel.ts             raycast suspension + tyre friction, steering, brakes
    Drag.ts              simple quadratic drag (the smallest example module)
    registry.ts          def.type -> module factory
  sim/
    Simulation.ts        headless sim: world, ground, fixed 120 Hz step, NaN guard, telemetry
    controls.ts          ControlInputs + ControlSource (anything that can fly the craft)
    telemetry.ts         JSON flight-state snapshot (HUD and future AI pilots)
    autopilot.ts         PID autopilot (heading/altitude/speed targets)
    flightTest.ts        automated test card + design metrics, scored report
    flightLog.ts         summary of the player's flight (feedback for Refine)
    atmosphere.ts        exponential air density
    layout.ts            ground size, runway, spawn
  gen/
    openrouter.ts        browser/Node OpenRouter client: retries, cost tracking, JSON extraction
    catalog.ts           tasks (design, pilot, livery, music…) -> capable models, defaults
    craftDesigner.ts     designer prompt + generate/validate/flight-test/repair loop
    livery.ts            image model -> livery texture
    library.ts           hangar: saved craft with provenance (localStorage), import/export
  ui/Studio.ts           in-game generation workflow
  input/PlayerInput.ts   keyboard + gamepad devices -> a ControlSource with smoothing & trim
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
     ctx.pointVelocity(p, v);                   // includes angular velocity
     // ...compute a world-space force...
     ctx.applyForce('drag', force, p);          // NaN-safe, also feeds the F3 overlay
   }
   reset() { /* clear internal state */ }
   ```
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
4. Rotor module: multirotor drones (blade element rotors + PID flight controllers)
5. Missions: deliveries between generated points of interest
6. Helicopters, VTOL, blimps

Generation roadmap, using more of OpenRouter's model types:

- **LLM pilots and races** (next). The `pilot` task: a model receives JSON telemetry every few
  seconds and sets autopilot targets or waypoints. Races run headless, faster than real time,
  model against model on the same craft and course, with replays.
- **Generated courses and missions.** Text models emit gate lists and delivery jobs as
  validated JSON, flight-tested for feasibility like craft are.
- **Radio chatter.** Speech models for ATC and race commentary. Transcription for voice
  commands.
- **Music.** Audio models (e.g. Lyria) for a soundtrack that follows the flight.
- **Embeddings** for searching the hangar and part library by description.
- **Video** models for race trailers from replays.
- **Procedural worlds** (Stage 3) seeded and themed by a model: biome palette, landmarks,
  airports.
