import * as THREE from 'three';
import { TEST_PLANE } from './craft/testPlane.ts';
import { Hud } from './hud/Hud.ts';
import { GamepadDevice, KeyboardDevice, PlayerInput } from './input/PlayerInput.ts';
import { CameraRig } from './render/CameraRig.ts';
import { CraftView } from './render/CraftView.ts';
import { DebugOverlay } from './render/DebugOverlay.ts';
import { WorldView } from './render/WorldView.ts';
import type { ControlSource } from './sim/controls.ts';
import { initPhysics, Simulation } from './sim/Simulation.ts';
import { TUNING } from './tuning.ts';

async function start() {
  await initPhysics();
  document.getElementById('loading')?.remove();

  // --- Rendering
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.3, 20000);
  const worldView = new WorldView(scene, renderer);

  // --- Simulation
  const sim = new Simulation(TEST_PLANE);
  const craftView = new CraftView(sim.craft);
  scene.add(craftView.root);
  const debug = new DebugOverlay(scene, craftView.root);
  const rig = new CameraRig(camera, canvas);
  const hud = new Hud();

  // --- Input. The active pilot is any ControlSource; the human is just one of them.
  const player = new PlayerInput([new KeyboardDevice(), new GamepadDevice()]);
  let pilot: ControlSource = player;

  let debugOn = false;
  const comSlider = document.getElementById('d-com') as HTMLInputElement;
  const comVal = document.getElementById('d-com-val')!;
  comSlider.addEventListener('input', () => {
    const z = parseFloat(comSlider.value);
    comVal.textContent = z.toFixed(2);
    sim.craft.setComOffset(new THREE.Vector3(0, 0, z));
  });
  // Don't let the slider keep keyboard focus (arrow keys / letters would go to it).
  comSlider.addEventListener('change', () => comSlider.blur());

  const reset = () => {
    sim.resetToRunway();
    player.reset();
    rig.snap();
  };

  window.addEventListener('resize', () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight, false);
  });

  // Exposed for debugging, automated tests, and future AI-pilot experiments in the console.
  Object.assign(window, {
    game: {
      sim,
      scene,
      camera,
      telemetry: () => sim.telemetry(),
      setPilot: (p: ControlSource | null) => (pilot = p ?? player),
      reset,
    },
  });

  // --- Fixed-timestep loop with render interpolation
  const renderPos = new THREE.Vector3();
  const renderRot = new THREE.Quaternion();
  const renderOffset = new THREE.Vector3();
  const velocity = new THREE.Vector3();
  let accumulator = 0;
  let last = performance.now();
  let fpsFrames = 0;
  let fpsTime = 0;
  let fps = 0;
  let stepsThisFrame = 0;
  let telemetry = sim.telemetry();

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;

    for (const a of player.poll()) {
      if (a === 'reset') reset();
      else if (a === 'camera') rig.toggle(renderPos);
      else if (a === 'help') hud.toggleHelp();
      else if (a === 'trimReset') player.trim = 0;
      else if (a === 'debug') {
        debugOn = !debugOn;
        sim.recordForces = debugOn;
        debug.setVisible(debugOn);
        hud.setDebugVisible(debugOn);
      }
    }

    accumulator += dt;
    stepsThisFrame = 0;
    let stepMs = 0;
    while (accumulator >= sim.dt && stepsThisFrame < TUNING.maxStepsPerFrame) {
      sim.step(pilot.sample(sim.dt, telemetry));
      stepMs += sim.lastStepMs;
      accumulator -= sim.dt;
      stepsThisFrame++;
    }
    if (stepsThisFrame === TUNING.maxStepsPerFrame) accumulator = 0; // drop time rather than spiral
    telemetry = sim.telemetry();

    const alpha = accumulator / sim.dt;
    renderPos.lerpVectors(sim.prevPosition, sim.position, alpha);
    renderRot.slerpQuaternions(sim.prevRotation, sim.rotation, alpha);
    craftView.update(renderPos, renderRot);

    const v = sim.craft.body.linvel();
    velocity.set(v.x, v.y, v.z);
    rig.update(dt, renderPos, renderRot, velocity);
    worldView.update(camera, renderPos);

    renderOffset.copy(renderPos).sub(sim.position);
    debug.update(sim.debugForces, sim.craft, renderOffset);

    hud.update(telemetry, player.trim, telemetry.controls.brake > 0);
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime > 0.5) {
      fps = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
    }
    if (debugOn) {
      const mp = sim.craft.massProps;
      const col = sim.craft.centerOfLift();
      hud.setStats(
        `fps        ${fps.toFixed(0)}\n` +
          `physics    ${TUNING.physicsHz} Hz, ${stepsThisFrame} steps/frame\n` +
          `step time  ${(stepsThisFrame ? stepMs / stepsThisFrame : 0).toFixed(3)} ms\n` +
          `bodies     ${sim.bodyCount}\n` +
          `mass       ${mp.mass.toFixed(0)} kg\n` +
          `CoM z      ${mp.com.z.toFixed(2)} m   CoL z ${col.z.toFixed(2)} m\n` +
          `margin     ${(col.z - mp.com.z).toFixed(2)} m ${col.z - mp.com.z < 0 ? '(UNSTABLE)' : ''}\n` +
          `draw calls ${renderer.info.render.calls}`,
      );
    }

    renderer.render(scene, camera);
  }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
