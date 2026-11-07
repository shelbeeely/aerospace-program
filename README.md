# aerospace-program

A browser aircraft sandbox ("KSP for planes") built with three.js + Rapier.
**Stage 1: flight core.** One data-defined test plane, a 10 km flat world with a runway,
per-surface aerodynamics.

```bash
npm install
npm run dev        # http://localhost:5173
npm run sim        # headless flight test in Node (takeoff, turn, stalls, CoM shift, crash)
npm run build      # typecheck + production build
```

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
    autopilot.ts         simple PD/PI autopilot (heading/altitude/speed targets)
    atmosphere.ts        exponential air density
    layout.ts            ground size, runway, spawn
  input/PlayerInput.ts   keyboard + gamepad devices -> a ControlSource with smoothing & trim
  render/                WorldView, CraftView, CameraRig, DebugOverlay (three.js only)
  hud/Hud.ts             plain-DOM HUD
  main.ts                wires it together: fixed-step accumulator + render interpolation
scripts/headless.ts      runs the real sim in Node about 300x faster than real time
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

Longer-term goals that shape the design now:

- **Race other LLMs.** An LLM is too slow to fly the stick, so it would issue high-level commands
  (heading, altitude, speed, waypoints) every few seconds. A fast autopilot `ControlSource`
  turns those into stick inputs. The headless sim, fixed timestep and JSON telemetry are there
  so races can run faster than real time and be replayed. It could also run with no
  autopilot, as a "write your own flight controller" challenge.
- **LLM-generated content.** Craft, worlds and missions are plain JSON with validators, so
  generated data can be checked before it reaches the sim.
