# Neon / destruction / electrics / disasters / ray tracing batch

Recovered from the user's prior-session plan. Continue on `ccr-3c559407-13celq`.

## Requirements

Separate Hangar editor and Flight modes; neon synthwave wireframe visuals; exactly four flight-worthy built-ins (single prop, twin prop, jet, quad); impact damage, CCD and BFS block buildings; electric propulsion and electrical bus; lightning/static/fire, tornadoes/hurricanes/earthquakes; coast/ocean and town; analytic ray tracing and photo mode. No new npm dependencies. Keep physics DOM-free and deterministic; fixed 120 Hz Rapier simulation. Constants in src/tuning.ts. Use three/webgpu and TSL with WebGL2 fallback.

## Work units and status

| Unit | Scope | Recovered state |
| --- | --- | --- |
| 1 | Hangar/Flight modes, paused editor, N/Start/touch switching, URL mode, select versus fly | Merged before resumption |
| 2 | Neon edges, dark fills/sky, cyan grid, rain/cloud wireframe, bloom/SMAA | Merged and validated WebGPU/WebGL2 |
| 3 | Trainer/twin/jet/quad; turbofan model; calm/moderate 100-point flight cards; retain heli/blimp cards | Merged before resumption |
| 4 | Contact force events, per-part HP/energy damage, wheel sink exemption, soft CCD | Merged before resumption |
| 5 | Grid block buildings, 6-neighbour support BFS, compound unsupported chunks, capped debris, seeded town x < -700 | Merged; BFS/collision/cap tests and WebGPU/WebGL2 validated |
| 6 | Battery sag/SoC/heat/cutoff, motor Kv/Kt, generators, avionics, solved bus, FC brownout, HUD | Merged; power conservation/damage fixes, 26 electrical checks passed |
| 7 | Seeded events; Rankine tornado, Holland hurricane/surge, earthquake ground acceleration, controls and neon visuals | Merged; 22 deterministic disaster checks and both rendering backends passed |
| 8 | Seeded lightning/strike geometry, electrical spike hook, fuel ignition, heat/spread/burnout, smoke wind and thunder | Merged; 22 hazard and cross-system checks passed |
| 9 | Coast x > 2500; shared CPU/TSL Gerstner waves/surge; water drag/buoyancy/damage | Merged; 15 ocean checks including spatial surge and quake integration passed |
| 10 | Analytic box/sphere/cylinder/plane ray tracer; RGBA32F packed shapes <=256; shadows, 1–2 reflections, Fresnel and accumulation | Merged; CPU intersections/packing and targeted WebGPU/WebGL2 readback passed |
| 11 | Raster/RT selector, desktop hangar default, flight headroom, raster fallback, converged P capture | Merged; both backends, adaptive fallback, capture state and 16-sample P photo verified |

## Execution and preservation

Review existing remote work before restarting units. Waves of at most three agents: (3,4,1), (2,6,5), (7,8,9), (10,11). Use isolated worktrees as explicitly requested in the source plan. Merge each completed unit promptly in dependency-friendly order, resolve shared hooks, validate, commit and push checkpoints. Do not wait for an entire wave to preserve completed work. Use accurate authorship; prior-session Claude metadata does not describe new Codex work. Do not add npm dependencies.

## Validation

Run `npm run typecheck`, `npm run sim`, `npm run weather`, `npm run destruction`, each unit's new script and `npm run build`. Require every built-in flight card PASS 100/100, retaining heli/blimp regression coverage. Check rendered changes in Chromium, capture with game.capture, inspect PNG, and test WebGL2 fallback plus UI transitions. Use the tools actually available in this environment; dependencies are in /workspace/aerospace-program/node_modules, browser automation in /tmp/aerospace-browser/node_modules/playwright-core, Chromium at /usr/bin/chromium. Stop servers started for tests.

Specific checks: safe 0.5 m drop, damaging 30 m drop, 300 m/s thin-wall CCD; BFS anchored/unsupported buildings and craft collision; electrical sag within 1%, monotonic SoC and quad score 100; deterministic storm traces and radial profiles; tallest-object lightning and bounded fire; bounded waves and floating equilibrium without runway changes; known-ray intersections/packing; actual raster/RT fallback and photo capture.

## Recovery correction

The old plan said all workers were lost at c84027d. Remote inspection during this session instead found units 1/3/4 merged at ff2f5e3, and units 2/5/6 saved on remote branches. Preserve those commits.

## Current checkpoint

All 11 units are integrated on `ccr-3c559407-13celq`. No npm dependencies added. Final combined validation passed: typecheck, sim (all 10 vehicle cards100/100), weather9, destruction11, electric26, buildings33, events22, ocean15, hazards24, raytrace22, raymode8, production build. Actual WebGPU and WebGL2 checks passed hangar/flight raster/RT selectors, traced capture, power-saver fallback and renderer target restoration. P downloaded a1280px PNG from16 accumulated samples at768px trace resolution, restoring orbit controls and render target. Ray tracing uses analytic scenery approximations; raster shows the full weather/effect/ocean-wave detail.

User's mobile feedback addressed: Studio stays closed in mobile hangar until Create is tapped, prompt and Generate aircraft come first, model settings collapse, controls toolbar has four readable44px actions, More holds secondary actions, help/weather have close buttons, and stale panels clear on mode changes. Portrait390x844 and landscape844x390 tested with touch emulation, prompt entry, open/close, Fly and throttle dragging. Render selector cannot cover mobile Fly. Instructions updated in README and the controls panel.

Independent review fixed generator power conservation/controller brownouts, last-source detach behavior, GPU box boundary intersections, axis-aware lightning conductors, event-reset rendering, and shoreline origin preservation. Spatial TSL surge matches headless hurricane physics (tested error<1e-12m). Hurricane convection drives lightning; smoke uses the shared atmosphere contributor path.

Optional live OpenRouter access is blocked in this environment. Browser checks use a catalog fixture; paid/live AI generation is not validated. Changes are pushed to the development branch; GitHub Pages deploys from main, so the public site remains unchanged until this branch is merged there.
