import * as THREE from 'three/webgpu';
import { TEST_PLANE } from './craft/testPlane.ts';
import { Hud } from './hud/Hud.ts';
import { GamepadDevice, KeyboardDevice, PlayerInput, TouchDevice } from './input/PlayerInput.ts';
import { ControlsPanel, toast } from './ui/ControlsPanel.ts';
import { vehicleKind } from './sim/vehicleTests.ts';
import { BUILTINS } from './craft/builtins.ts';
import { browserClient } from './gen/openrouter.ts';
import { Library, type LibraryEntry } from './gen/library.ts';
import { CameraRig } from './render/CameraRig.ts';
import { CraftView } from './render/CraftView.ts';
import { DebrisView } from './render/DebrisView.ts';
import { captureFrame } from './render/capture.ts';
import { PerformanceGovernor } from './platform/performance.ts';
import { FlightAudio } from './platform/audio.ts';
import { Callouts } from './platform/speech.ts';
import { runFlightTest } from './sim/flightTestClient.ts';
import { DebugOverlay } from './render/DebugOverlay.ts';
import { WorldView } from './render/WorldView.ts';
import { WeatherView } from './render/WeatherView.ts';
import type { ControlSource } from './sim/controls.ts';
import { FlightLog } from './sim/flightLog.ts';
import { initPhysics, Simulation } from './sim/Simulation.ts';
import { WEATHER_PRESETS } from './sim/atmosphere.ts';
import { TUNING } from './tuning.ts';
import { builtinEntry, CAP_STORAGE, KEY_STORAGE, Studio } from './ui/Studio.ts';
import { HangarView } from './render/HangarView.ts';
import { applyModeClass, modeFromQuery, parseMode, type AppMode } from './app/Mode.ts';

async function start() {
  await initPhysics();
  document.getElementById('loading')?.remove();

  // --- Rendering
  const canvas = document.getElementById('view') as HTMLCanvasElement;
  // Phones/tablets: cap resolution and shadow cost so mid-range devices hold their frame rate.
  const mobile = matchMedia('(pointer: coarse)').matches;
  // WebGPU when available, WebGL2 otherwise (same scene, same materials). `?renderer=webgl`
  // forces the fallback for comparison.
  const params = new URLSearchParams(location.search);
  const forceWebGL = params.get('renderer') === 'webgl';
  const presentToCanvas = !params.has('nopresent');
  const renderer = new THREE.WebGPURenderer({
    canvas,
    antialias: !mobile || window.devicePixelRatio < 2,
    powerPreference: 'high-performance',
    forceWebGL,
  });
  await renderer.init();
  // A lost GPU device (driver reset, GPU process crash) is unrecoverable for this renderer:
  // reload on the WebGL2 backend rather than leave a frozen canvas.
  renderer.onDeviceLost = (info) => {
    console.warn('GPU device lost:', info.message);
    if (!forceWebGL) {
      const url = new URL(location.href);
      url.searchParams.set('renderer', 'webgl');
      location.replace(url);
    }
  };
  const backendName = (renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'WebGPU' : 'WebGL2';
  const basePixelRatio = Math.min(window.devicePixelRatio, mobile ? 1.5 : 2);
  renderer.setPixelRatio(basePixelRatio);
  const perf = new PerformanceGovernor(renderer, basePixelRatio);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.3, 20000);
  const worldView = new WorldView(scene, renderer);
  if (mobile) worldView.sun.shadow.mapSize.set(1024, 1024);
  const weatherView = new WeatherView(scene, worldView);
  // The hangar: a separate scene with its own orbit camera; its lighting is baked once here.
  const hangarView = new HangarView(renderer, canvas);
  hangarView.bakeEnvironment();
  let mode: AppMode = modeFromQuery(location.search);
  /** The scene the craft is drawn in right now (flight world or hangar turntable). */
  const craftScene = () => (mode === 'hangar' ? hangarView.scene : scene);

  // --- Simulation
  const sim = new Simulation(TEST_PLANE);
  let craftView = new CraftView(sim.craft);
  craftScene().add(craftView.root);
  const debug = new DebugOverlay(scene, craftView.root);
  const debrisView = new DebrisView(scene);
  let viewVersion = sim.version;
  let currentLivery: string | null = null;
  /** Rebuild the craft's visuals (new craft, or the sim rebuilt a broken one on reset). */
  const replaceCraftView = () => {
    const old = craftView;
    craftView = new CraftView(sim.craft);
    craftView.setLivery(currentLivery);
    craftScene().add(craftView.root);
    debug.attach(craftView.root); // move the CoM/CoL markers before disposing the old view
    old.root.removeFromParent();
    old.dispose();
  };
  const rig = new CameraRig(camera, canvas);
  const hud = new Hud();

  // --- Input. The active pilot is any ControlSource; the human is just one of them.
  const gamepad = new GamepadDevice();
  const touch = new TouchDevice();
  const player = new PlayerInput([new KeyboardDevice(), gamepad, touch]);
  const audio = new FlightAudio();
  const callouts = new Callouts();
  const controlsPanel = new ControlsPanel(document.getElementById('help')!, player);
  gamepad.onChange = (pad, connected) => {
    toast(
      connected
        ? `🎮 ${pad?.id.split('(')[0].trim() || 'Gamepad'} connected${pad?.standard ? '' : ' (non-standard mapping: some buttons may differ)'}`
        : '🎮 Gamepad disconnected',
    );
    controlsPanel.render();
    if (connected) player.rumble(0.4, 150);
  };
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

  // Weather controls (F3 panel). Same seed = same gusts every run.
  const wx = {
    speed: 'w-speed', dir: 'w-dir', gust: 'w-gust', turb: 'w-turb', temp: 'w-temp', precip: 'w-precip',
    cloud: 'w-cloud', base: 'w-base', thermal: 'w-thermal', storm: 'w-storm', vis: 'w-vis',
  } as const;
  const wxEl = Object.fromEntries(Object.entries(wx).map(([k, id]) => [k, document.getElementById(id) as HTMLInputElement])) as Record<keyof typeof wx, HTMLInputElement>;
  const presetSel = document.getElementById('w-preset') as HTMLSelectElement;
  presetSel.append(new Option('Custom', 'custom'));
  for (const [id, p] of Object.entries(WEATHER_PRESETS)) presetSel.append(new Option(p.label, id));
  const num = (k: keyof typeof wx) => Number(wxEl[k].value);
  const applyWeather = () => {
    const base = num('base');
    sim.atmosphere.configure({
      windSpeed: num('speed'), windFromDeg: num('dir'), gustStrength: num('gust'), turbulence: num('turb'),
      temperatureOffset: num('temp'), precipitation: num('precip'), cloudCover: num('cloud'),
      cloudBase: base, cloudTop: Math.max(base + 800, sim.atmosphere.settings.cloudTop ?? 2500),
      thermals: num('thermal'), storm: num('storm'), visibility: num('vis'),
    });
    const kind = num('temp') + 15 < 0.5 ? 'snow' : 'rain';
    document.getElementById('w-label')!.textContent =
      `${num('speed').toFixed(0)} m/s from ${num('dir').toFixed(0)}°, gusts ${num('gust')}, ` +
      `${(15 + num('temp')).toFixed(0)}°C, ${num('precip') ? `${kind} ${num('precip')} mm/h, ` : ''}` +
      `cloud ${(num('cloud') * 100).toFixed(0)}% @ ${base} m, vis ${(num('vis') / 1000).toFixed(1)} km`;
  };
  const setPreset = (id: string) => {
    const p = WEATHER_PRESETS[id];
    if (!p) return;
    const st = p.settings;
    const set = (k: keyof typeof wx, v: number | undefined) => {
      if (v !== undefined) wxEl[k].value = String(v);
    };
    set('speed', st.windSpeed); set('dir', st.windFromDeg); set('gust', st.gustStrength); set('turb', st.turbulence);
    set('temp', st.temperatureOffset); set('precip', st.precipitation); set('cloud', st.cloudCover);
    set('base', st.cloudBase); set('thermal', st.thermals); set('storm', st.storm); set('vis', st.visibility);
    sim.atmosphere.configure({ cloudTop: st.cloudTop ?? 2500, humidity: st.humidity ?? 0.5 });
    applyWeather();
    sim.settleGroundWater();
  };
  for (const el of Object.values(wxEl)) {
    el.addEventListener('input', () => {
      presetSel.value = 'custom';
      applyWeather();
    });
    el.addEventListener('change', () => el.blur());
  }
  presetSel.addEventListener('change', () => {
    setPreset(presetSel.value);
    presetSel.blur();
  });
  const urlWx = new URLSearchParams(location.search).get('weather');
  if (urlWx && WEATHER_PRESETS[urlWx]) {
    presetSel.value = urlWx;
    setPreset(urlWx);
  } else applyWeather();

  const flightLog = new FlightLog();
  const reset = () => {
    sim.resetToRunway();
    player.reset();
    rig.snap();
    flightLog.reset();
    audio.reset();
    callouts.reset();
  };

  // --- Generation: craft come from the Studio (designer models) and live in the hangar library.
  const stored = (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  };
  // A player-supplied key talks to OpenRouter directly (works on GitHub Pages); otherwise the
  // dev-server proxy holds the key. Default session cap: $1.
  const client = browserClient(stored(KEY_STORAGE), Number(stored(CAP_STORAGE) ?? 1));
  const library = new Library();
  let currentEntry: LibraryEntry | null = null;
  /** Load a craft (null = built-in trainer): on the turntable in the hangar, on the runway in flight. */
  const select = (entry: LibraryEntry | null) => {
    sim.loadCraft(entry ? entry.craft : TEST_PLANE);
    currentLivery = entry?.livery ?? null;
    replaceCraftView();
    viewVersion = sim.version;
    comSlider.value = '0';
    comVal.textContent = '0.00';
    currentEntry = entry;
    player.profile = vehicleKind(sim);
    controlsPanel.render();
    rig.fitCraft(sim.craft.boundingRadius());
    reset();
    if (mode === 'hangar') showOnTurntable();
    studio.renderHangar();
  };

  // --- Hangar / flight modes
  const flyBtn = document.getElementById('fly-btn') as HTMLButtonElement;
  const toHangarBtn = document.getElementById('to-hangar') as HTMLButtonElement;
  const craftCard = document.getElementById('craft-card')!;
  const _hangarPos = new THREE.Vector3();
  const _identity = new THREE.Quaternion();
  /** Pose the craft on the turntable: the runway spawn pose (sim just reset), moved to x = z = 0. */
  const showOnTurntable = () => {
    const spawn = sim.position;
    const mp = sim.craft.massProps;
    // The spawn pose puts the CoM on the runway centreline; keep that, centred on the turntable.
    _hangarPos.set(-mp.com.x, spawn.y + hangarView.turntableTop, -mp.com.z);
    craftView.update(_hangarPos, _identity);
    hangarView.fit(sim.craft.boundingRadius(), _hangarPos.y + mp.com.y);
    updateCraftCard();
  };
  const updateCraftCard = () => {
    const craft = sim.craft;
    const mass = craft.massProps.mass;
    let span = 0;
    for (const p of craft.def.parts) {
      const s = p.shape;
      const half = s.type === 'box' ? s.size[0] / 2 : s.type === 'sphere' ? s.radius : s.axis === 'x' ? s.length / 2 : s.radius;
      span = Math.max(span, Math.abs(p.position[0]) + half);
    }
    for (const r of craft.rotors) span = Math.max(span, Math.abs(r.localPosition.x) + r.def.radius);
    const thrust = craft.engines.reduce((sum, e) => sum + e.def.maxThrust, 0);
    const tw = thrust > 0 ? (thrust / (mass * TUNING.gravity)).toFixed(2) : '—';
    const row = (k: string, v: string) => `<div class="row"><span>${k}</span><b>${v}</b></div>`;
    const name = document.createElement('div');
    name.className = 'card-name';
    name.textContent = craft.def.name;
    craftCard.replaceChildren(name);
    craftCard.insertAdjacentHTML(
      'beforeend',
      row('TYPE', vehicleKind(sim)) +
        row('MASS', `${mass.toFixed(0)} kg`) +
        row('SPAN', `${(span * 2).toFixed(1)} m`) +
        row('T/W', tw),
    );
  };
  const setMode = (m: AppMode) => {
    mode = m;
    applyModeClass(m);
    const hangar = m === 'hangar';
    craftScene().add(craftView.root); // re-parents from the other scene
    rig.setSuspended(hangar);
    hangarView.setActive(hangar);
    accumulator = 0;
    debug.setVisible(!hangar && debugOn); // the CoM/CoL markers ride on the craft view
    if (hangar) {
      // Physics is paused in the hangar: put the craft back at its spawn pose on the turntable.
      sim.resetToRunway();
      if (sim.version !== viewVersion) {
        if (sim.craft !== craftView.craft) replaceCraftView();
        viewVersion = sim.version;
      }
      showOnTurntable();
      audio.silence();
      callouts.reset();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      studio.show();
    } else {
      reset();
    }
    flyBtn.blur();
    toHangarBtn.blur();
  };
  /** Take the selected craft flying from the runway. */
  const fly = (entry?: LibraryEntry | null) => {
    if (entry !== undefined) select(entry);
    if (mode !== 'flight') setMode('flight');
    else reset();
  };
  flyBtn.addEventListener('click', () => fly());
  toHangarBtn.addEventListener('click', () => setMode('hangar'));
  document.getElementById('studio-open')!.addEventListener('click', () => studio.show());
  const studio = new Studio({
    client,
    library,
    current: () => ({ craft: sim.craft.def, entryId: currentEntry?.id ?? null }),
    flightNotes: () => flightLog.summary(),
    // Async results (a design finishing) must not swap the craft out from under a flight.
    select: (entry) => {
      if (mode === 'hangar') select(entry);
    },
    fly: () => fly(),
    applyLivery: (url) => {
      currentLivery = url;
      craftView.setLivery(url);
    },
  });

  // Resize on window changes, phone rotation and mobile browser bars appearing/disappearing.
  const resize = () => {
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    hangarView.resize(window.innerWidth / window.innerHeight);
    renderer.setSize(window.innerWidth, window.innerHeight, false);
    document.body.classList.toggle('portrait', window.innerHeight > window.innerWidth);
  };
  window.addEventListener('resize', resize);
  window.visualViewport?.addEventListener('resize', resize);
  screen.orientation?.addEventListener?.('change', resize);
  resize();

  /** Built-ins first, then the player's hangar. */
  const cycleCraft = (dir: 1 | -1) => {
    const list = [...BUILTINS.map(builtinEntry), ...library.list()];
    const cur = currentEntry ? list.findIndex((e) => e.id === currentEntry!.id) : 0;
    const next = list[(Math.max(0, cur) + dir + list.length) % list.length];
    select(next);
    toast(`${next.name}${BUILTINS.find((b) => `builtin:${b.id}` === next.id)?.hint ? ` · ${BUILTINS.find((b) => `builtin:${b.id}` === next.id)!.hint}` : ''}`);
  };

  // Exposed for debugging, automated tests, and future AI-pilot experiments in the console.
  Object.assign(window, {
    game: {
      sim,
      scene,
      camera,
      telemetry: () => sim.telemetry(),
      renderer,
      backend: backendName,
      perf,
      audio,
      callouts,
      /** Flight-test a craft in the worker (same path the Studio uses). */
      flightTest: runFlightTest,
      /** PNG of the current 3D view (GPU readback; works on WebGPU and WebGL2). */
      capture: (width?: number) =>
        mode === 'hangar'
          ? captureFrame(renderer, hangarView.scene, hangarView.camera, width)
          : captureFrame(renderer, scene, camera, width),
      client,
      library,
      studio,
      hangarView,
      /** Fly the selected craft (or this entry) from the runway. */
      fly,
      /** Show a craft on the turntable (hangar) or runway (flight) without changing mode. */
      select,
      get mode() {
        return mode;
      },
      /** 'hangar' | 'flight' (or 'fly'). */
      setMode: (m: string) => {
        const pm = parseMode(m);
        if (!pm) throw new Error(`Unknown mode "${m}" (use "hangar" or "flight")`);
        if (pm !== mode) setMode(pm);
      },
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
  let failuresSeen = 0;
  let wasHardContact = false;
  let wasStalling = false;
  setMode(mode);

  function frame(now: number) {
    requestAnimationFrame(frame);
    const dt = Math.min(0.25, (now - last) / 1000);
    last = now;
    // Background tab: don't simulate or render (rAF is throttled anyway; this also stops audio
    // and keeps the sim from leaping forward on return).
    if (perf.paused) {
      accumulator = 0;
      return;
    }
    const renderThisFrame = perf.frame(dt);

    for (const a of player.poll()) {
      if (a === 'studio') setMode(mode === 'flight' ? 'hangar' : 'flight');
      else if (a === 'mute') toast(audio.toggleMute() ? '🔇 Sound off' : '🔊 Sound on');
      else if (a === 'nextVehicle') cycleCraft(1);
      else if (a === 'prevVehicle') cycleCraft(-1);
      else if (mode !== 'flight') continue; // the rest only means something in flight
      else if (a === 'reset') reset();
      else if (a === 'camera') rig.toggle(renderPos);
      else if (a === 'help') {
        controlsPanel.render(); // reflect the current profile / devices
        hud.toggleHelp();
      }
      else if (a === 'trimReset') player.trim = 0;
      else if (a === 'debug') {
        debugOn = !debugOn;
        sim.recordForces = debugOn;
        debug.setVisible(debugOn);
        hud.setDebugVisible(debugOn);
      }
    }

    if (mode === 'hangar') {
      // Physics paused; the craft sits on the turntable under the orbit camera.
      accumulator = 0;
      hangarView.update(dt);
      if (presentToCanvas && renderThisFrame) renderer.render(hangarView.scene, hangarView.camera);
      return;
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
    const airframeHit = sim.airframeTouchingGround();
    flightLog.update(telemetry, dt, airframeHit);
    audio.update(telemetry, sim.craft, sim.failures.length, airframeHit, dt);
    callouts.update(telemetry, sim.failures);
    // Structure changed: a part broke off (hide it), or the craft was rebuilt (new view).
    if (sim.version !== viewVersion) {
      if (sim.craft !== craftView.craft) replaceCraftView();
      else craftView.hideParts(sim.craft.detached);
      viewVersion = sim.version;
    }
    debrisView.update(sim.debris);

    // Haptics: parts breaking, hitting the ground hard, entering a stall.
    if (sim.failures.length > failuresSeen) player.rumble(1, 400);
    failuresSeen = sim.failures.length;
    const hardContact = telemetry.airspeed > 8 && sim.airframeTouchingGround();
    if (hardContact && !wasHardContact) player.rumble(0.9, 300);
    wasHardContact = hardContact;
    const stalling = telemetry.stall > 0.35 && !telemetry.onGround && telemetry.airspeed > 5;
    if (stalling && !wasStalling) player.rumble(0.3, 120);
    wasStalling = stalling;

    const alpha = accumulator / sim.dt;
    renderPos.lerpVectors(sim.prevPosition, sim.position, alpha);
    renderRot.slerpQuaternions(sim.prevRotation, sim.rotation, alpha);
    craftView.update(renderPos, renderRot);

    const v = sim.craft.body.linvel();
    velocity.set(v.x, v.y, v.z);
    rig.update(dt, renderPos, renderRot, velocity);
    worldView.update(camera, renderPos);
    weatherView.update(dt, camera, velocity, sim.atmosphere, sim.groundWetness, sim.atmosphere.cloudAt(camera.position, 0).inCloud);

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
    // `?nopresent` (automated tests): simulate and update everything but skip presenting to the
    // canvas. Headless browsers can't composite a WebGPU canvas; game.capture() still renders.
    if (presentToCanvas && renderThisFrame) renderer.render(scene, camera);

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
          `fuel       ${sim.craft.fuelCapacity ? `${sim.craft.fuel.toFixed(1)} / ${sim.craft.fuelCapacity} kg` : 'none (infinite)'}\n` +
          `broken     ${sim.failures.map((f) => `${f.partId} (${(f.load / 1000).toFixed(1)}/${(f.strength / 1000).toFixed(1)} kN)`).join(', ') || 'none'}\n` +
          `renderer   ${backendName}, ${perf.describe()}\n` +
          `draw calls ${renderer.info.render.drawCalls}`,
      );
    }
  }
  requestAnimationFrame(frame);
}

start().catch((err) => {
  console.error(err);
  const el = document.getElementById('loading');
  if (el) el.textContent = `Failed to start: ${err instanceof Error ? err.message : String(err)}`;
});
