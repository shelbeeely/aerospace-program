import type { CraftDef } from './craft/types.ts';
import * as THREE from 'three/webgpu';
import { PLANET } from './sim/layout.ts';
import { TEST_PLANE } from './craft/testPlane.ts';
import { Hud } from './hud/Hud.ts';
import { GamepadDevice, KeyboardDevice, PlayerInput, TouchDevice } from './input/PlayerInput.ts';
import { ControlsPanel, toast } from './ui/ControlsPanel.ts';
import { vehicleKind } from './sim/vehicleTests.ts';
import { BUILTINS } from './craft/builtins.ts';
import { landingSite, landingSites } from './world/landingSites.ts';
import { STREET_SITE } from './world/spawnSites.ts';
import { obstacleTop } from './world/structures.ts';
import { browserClient } from './gen/openrouter.ts';
import { Library, type LibraryEntry } from './gen/library.ts';
import { loadTheme } from './gen/tracks.ts';
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
import { OceanView } from './render/OceanView.ts';
import { TownView } from './render/TownView.ts';
import { FireView } from './render/FireView.ts';
import { LightningView } from './render/LightningView.ts';
import { setCloudQuality, WeatherView } from './render/WeatherView.ts';
import { AirportView } from './render/AirportView.ts';
import { LandingSitesView } from './render/LandingSitesView.ts';
import { DESKTOP_RANGES, DigitalWorldView, MOBILE_RANGES } from './render/arch/DigitalWorldView.ts';
import { TerrainView } from './render/arch/TerrainView.ts';
import { KitTowersView } from './render/KitTowersView.ts';
import { InfrastructureView } from './render/arch/InfrastructureView.ts';
import { ArchitectureInspector } from './ui/ArchitectureInspector.ts';
import { GLOBE_VIEW } from './render/cityGround.ts';
import { TrailView } from './render/TrailView.ts';
import { TrafficView } from './render/TrafficView.ts';
import { BitsView } from './render/BitsView.ts';
import { BIT_STYLE_CHOICES, sanitizeBitStyle, STYLE_LIGHT } from './people/bitStyle.ts';
import { ChargesView } from './render/ChargesView.ts';
import { bearingOf } from './sim/errands.ts';
import { ExplosionView } from './render/ExplosionView.ts';
import { applyCurvature, curveOn, curveOrigin } from './render/curvature.ts';
import { updateSkyPlanet } from './render/neon.ts';
import { ChipsView } from './render/ChipsView.ts';
import { WeaponsView } from './render/WeaponsView.ts';
import { CraterView } from './render/CraterView.ts';
import { BoomView } from './render/BoomView.ts';
import { AiTrafficView } from './render/AiTrafficView.ts';
import { GroundTurretsView } from './render/GroundTurretsView.ts';
import { isSea } from './sim/layout.ts';
import { STRATEGIC } from './sim/strategic.ts';
import { predictDrop } from './sim/weapons.ts';
import { StrategicView } from './render/StrategicView.ts';
import type { TurretDensity } from './sim/groundTurrets.ts';
import { hostile, isTeam, sideLivery, TEAMS, type Team } from './sim/teams.ts';
import { craftRecord } from './sim/adsb.ts';
import { MercPanel } from './ui/MercPanel.ts';
import { flyerKind, type Foe } from './sim/aiTraffic.ts';
import { HostileMarkers, LockMarker, type HostileMark } from './hud/HostileMarkers.ts';
import type { LockTarget } from './sim/lock.ts';
import { RadarMap } from './hud/RadarMap.ts';
import { AdsbTags } from './hud/AdsbTags.ts';
import { GlobeView } from './render/GlobeView.ts';
import { HackBeamView } from './render/HackBeamView.ts';
import { StrikePanel } from './ui/StrikePanel.ts';
import { simContacts, wrapDelta, type Contact } from './sim/contacts.ts';
import { terrainHeight } from './sim/terrain.ts';
import { craftBounds } from './sim/weapons.ts';
import { LOADOUT_ORDER, LOADOUTS, WEAPONS, type Loadout, type WeaponKind } from './sim/weapons.ts';
import type { ControlSource } from './sim/controls.ts';
import { FlightLog } from './sim/flightLog.ts';
import { FlightAutopilot, type AutopilotKind } from './sim/flightAutopilot.ts';
import { wallSegmentsNear } from './sim/lightWalls.ts';
import { analyzeDesign } from './sim/flightTest.ts';
import { AutopilotPanel } from './ui/AutopilotPanel.ts';
import { initPhysics, Simulation } from './sim/Simulation.ts';
import { WEATHER_PRESETS } from './sim/atmosphere.ts';
import { TUNING } from './tuning.ts';
import { BIT } from './people/bit.ts';
import { builtinEntry, CAP_STORAGE, KEY_STORAGE, Studio } from './ui/Studio.ts';
import { HangarView } from './render/HangarView.ts';
import { applyModeClass, modeFromQuery, parseMode, type AppMode } from './app/Mode.ts';
import { DisasterView } from './render/DisasterView.ts';
import type { EventKind } from './sim/events/WorldEvents.ts';
import { RayTraceMode, type RenderMode } from './render/raytrace/RayTraceMode.ts';
import { flightShapes, hangarShapes } from './render/raytrace/sceneShapes.ts';
import { PostFX, QUALITIES, type Quality } from './render/postfx.ts';
import { NetClient } from './net/NetClient.ts';
import { MultiplayerPanel } from './ui/MultiplayerPanel.ts';

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
  renderer.shadowMap.enabled = false; // neon look: unlit glowing lines, nothing casts shadows
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(65, window.innerWidth / window.innerHeight, 0.3, 20000);
  const worldView = new WorldView(scene, renderer);
  const weatherView = new WeatherView(scene, worldView);
  const disasterView = new DisasterView(scene);
  const lightningView = new LightningView(scene);
  const fireView = new FireView(scene);
  // The hangar: a separate scene with its own orbit camera; its lighting is baked once here.
  const hangarView = new HangarView(renderer, canvas);
  hangarView.bakeEnvironment();
  let mode: AppMode = modeFromQuery(location.search);
  // Neon post chain (bloom makes the lines glow) for each scene. `?quality=low|medium|high`.
  const qParam = params.get('quality') as Quality | null;
  const quality: Quality = qParam && QUALITIES.includes(qParam) ? qParam : mobile ? 'low' : 'medium';
  const flightFX = new PostFX(renderer, scene, camera);
  const hangarFX = new PostFX(renderer, hangarView.scene, hangarView.camera);
  flightFX.setQuality(quality);
  hangarFX.setQuality(quality);
  // Volumetric clouds on medium/high (fewer march steps on phones); the flat deck on low.
  weatherView.volumetric = quality !== 'low';
  setCloudQuality(quality === 'high' ? 48 : mobile ? 18 : 32);
  /** The scene the craft is drawn in right now (flight world or hangar turntable). */
  const craftScene = () => (mode === 'hangar' ? hangarView.scene : scene);

  // --- Simulation
  const sim = new Simulation(TEST_PLANE);
  let captureBusy = false;
  const requestedRender: Record<AppMode, RenderMode> = {
    hangar: mobile || params.get('render') === 'raster' ? 'raster' : 'raytrace',
    flight: params.get('render') === 'raytrace' ? 'raytrace' : 'raster',
  };
  const suspendedRT: Record<AppMode, boolean> = { hangar: false, flight: false };
  const rayModes = new Map<AppMode, RayTraceMode>();
  const renderSelects = ['render-mode', 'hangar-render-mode'].map(id => document.getElementById(id) as HTMLSelectElement);
  const renderStatus = document.getElementById('render-status')!;
  const actualRenderMode = (): RenderMode => requestedRender[mode] === 'raytrace' && !mobile && !perf.powerSaver &&
    !suspendedRT[mode] && (mode === 'hangar' || perf.rayTraceHeadroom || rayModes.has('flight')) ? 'raytrace' : 'raster';
  const syncRenderControls = () => {
    for (const select of renderSelects) {
      select.value = requestedRender[mode];
      const option = select.querySelector<HTMLOptionElement>('option[value="raytrace"]')!;
      option.disabled = mobile || perf.powerSaver || (mode === 'flight' && !perf.rayTraceHeadroom && actualRenderMode() !== 'raytrace');
    }
    renderStatus.textContent = actualRenderMode() === 'raytrace' ? 'Ray traced · progressive' : requestedRender[mode] === 'raytrace'
      ? 'Raster fallback · power or frame budget' : 'Raster';
  };
  const setRenderMode = (value: RenderMode) => {
    if (value !== 'raster' && value !== 'raytrace') throw new Error('Use raster or raytrace');
    requestedRender[mode] = value;
    suspendedRT[mode] = false;
    syncRenderControls();
    return actualRenderMode();
  };
  for (const select of renderSelects) select.addEventListener('change', () => {
    setRenderMode(select.value as RenderMode); select.blur();
  });
  let craftView = new CraftView(sim.craft);
  craftScene().add(craftView.root);
  const debug = new DebugOverlay(scene, craftView.root);
  const debrisView = new DebrisView(scene);
  const townView = new TownView(scene, sim.town);
  // The digital world: procedural architecture (src/arch) streamed by district, the Outlands'
  // landforms, and the Solar Sailer routes.
  const archView = new DigitalWorldView(scene, sim.staticWorld, mobile ? MOBILE_RANGES : DESKTOP_RANGES);
  const terrainView = new TerrainView(scene, mobile ? MOBILE_RANGES : DESKTOP_RANGES);
  const routeView = new InfrastructureView(scene);
  worldView.weatherDriven = true;
  // The imported kit towers ("Tron Buildings 1"): the centre's, plus those of registered planet chunks.
  const kitView = new KitTowersView(scene, sim.staticWorld, import.meta.env.BASE_URL);
  let kitContent = -1;
  const updateKits = () => {
    if (sim.staticWorld.contentVersion !== kitContent) {
      kitContent = sim.staticWorld.contentVersion;
      const groups = [];
      for (const c of sim.staticWorld.outerChunks.values()) for (let g = c.groupStart; g < c.groupEnd; g++) if (sim.staticWorld.structures.groups[g].kit) groups.push(sim.staticWorld.structures.groups[g]);
      kitView.setOuter(groups);
    }
    kitView.update(camera.position);
  };
  const airportView = new AirportView(scene);
  const sitesView = new LandingSitesView(scene, sim.staticWorld);
  const trailView = new TrailView(scene, sim.trails);
  const trafficView = new TrafficView(scene, sim.traffic);
  const bitsView = new BitsView(scene, sim.bits, sim.walker);
  const chargesView = new ChargesView(scene);
  bitsView.setErrands(sim.errands);
  const chipsView = new ChipsView(scene, sim.chips);
  const explosionView = new ExplosionView(scene);
  const weaponsView = new WeaponsView(scene, () => sim.allWeapons());
  const hackBeamView = new HackBeamView(scene);
  const _beamFrom = new THREE.Vector3(), _beamTo = new THREE.Vector3();
  const craterView = new CraterView(scene);
  const boomView = new BoomView(scene);
  const aiTrafficView = new AiTrafficView(scene, sim.airTraffic);
  const turretsView = new GroundTurretsView(scene, sim.groundTurrets);
  const strategicView = new StrategicView(scene);
  let blastSeen = -Infinity;
  let boomHeardAt = -Infinity;
  let wasSupersonic = false;
  let explosionHeardAt = -Infinity;
  let explodedAt: number | null = null;
  const _wind10 = new THREE.Vector3();
  const _tmpWindPoint = new THREE.Vector3();
  const oceanView = new OceanView(scene, sim.ocean, sim.atmosphere.events);
  let viewVersion = sim.version;
  let wrapsSeen = 0;
  let curvatureTick = 0;
  /** Rebuild the craft's visuals (new craft, or the sim rebuilt a broken one on reset). */
  const replaceCraftView = () => {
    const old = craftView;
    craftView = new CraftView(sim.craft);
    craftScene().add(craftView.root);
    debug.attach(craftView.root); // move the CoM/CoL markers before disposing the old view
    old.root.removeFromParent();
    old.dispose();
  };
  const rig = new CameraRig(camera, canvas);
  const hud = new Hud();
  // Multiplayer (Grid Link): inert until connected; `?room=CODE&server=ws://host:port` joins.
  const net = new NetClient({ sim, scene, mode: () => mode });
  // K: the architecture inspector (region, district, streaming, structure under the cursor).
  const inspector = new ArchitectureInspector({ world: archView, terrain: terrainView, routes: routeView, sky: worldView, camera, canvas, active: () => mode === 'flight' });
  const netPanel = new MultiplayerPanel(net);

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
  const autopilot = new FlightAutopilot(player);
  // Autonomous ground driving steers clear of every light wall: ours, traffic's, other players'.
  autopilot.driver.walls = (x, z, r) => wallSegmentsNear(sim, x, z, r, net.remoteWalls());
  autopilot.driver.closed = sim.roadDamage.closed;
  autopilot.onDisengage = (thr) => { player.throttle = thr; };
  autopilot.fractured = sim.staticWorld.fractured;
  // Flight computer: approach speeds come from the design's estimated stall speed.
  let apPerf = { stallSpeed: 30 };
  let apPerfVersion = -1;
  const autopilotPerf = () => {
    if (apPerfVersion !== sim.version) {
      apPerf = { stallSpeed: analyzeDesign(sim).stallSpeed };
      apPerfVersion = sim.version;
    }
    return apPerf;
  };
  const autopilotKind = (): AutopilotKind | null => {
    const k = vehicleKind(sim);
    return k === 'airplane' || k === 'rotorcraft' || k === 'ground' ? k : null;
  };
  const apPanel = new AutopilotPanel({
    autopilot,
    kind: autopilotKind,
    telemetry: () => telemetry,
    engage: (opts) => {
      const kind = autopilotKind();
      if (!kind) return;
      autopilot.engage(telemetry, kind, autopilotPerf(), opts.mode === 'chase' ? { ...opts, target: sim.lock.target } : opts);
      if (autopilot.state.notice) toast(autopilot.state.notice);
    },
    disengage: () => autopilot.disengage(),
  });
  let pilot: ControlSource = autopilot;

  let debugOn = false;
  document.getElementById('debug-close')!.addEventListener('click', () => {
    debugOn = false; sim.recordForces = false; debug.setVisible(false); hud.setDebugVisible(false);
  });
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

  // Explicit disaster triggers keep ordinary flights calm. Place the event safely to the left.
  const triggerDisaster = (kind: EventKind) => sim.atmosphere.events.trigger(kind, {
    x: sim.position.x - (kind === 'hurricane' ? 1200 : 500), z: sim.position.z - 500,
  });
  // Tornadoes form at random in the game (seeded with the weather; headless tests stay calm).
  const randomTornado = document.getElementById('w-random-tornado') as HTMLInputElement | null;
  sim.atmosphere.events.randomTornadoes = randomTornado?.checked ?? true;
  randomTornado?.addEventListener('change', () => (sim.atmosphere.events.randomTornadoes = randomTornado.checked));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-disaster]')) {
    button.addEventListener('click', () => {
      const kind = button.dataset.disaster;
      if (kind === 'clear') sim.atmosphere.events.clear();
      else triggerDisaster(kind as EventKind);
      button.blur();
    });
  }

  const flightLog = new FlightLog();
  /** world: true rebuilds every structure and restarts the weather; false only respawns the craft. */
  const reset = (world = true) => {
    autopilot.disengage();
    if (world) sim.resetToRunway();
    else sim.respawn();
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
  // AI air traffic: the built-in aircraft, plus your own designs in single player.
  const aiCount = document.getElementById('w-ai-count') as HTMLInputElement | null;
  const aiMine = document.getElementById('w-ai-mine') as HTMLInputElement | null;
  const aiCountLabel = document.getElementById('w-ai-count-v');
  const hostileMarkers = new HostileMarkers(document.getElementById('hostile-marks'));
  const radarMap = new RadarMap();
  const adsbTags = new AdsbTags(document.getElementById('hostile-marks'));
  const lockMarker = new LockMarker(document.getElementById('hostile-marks'));
  const dropMarker = new LockMarker(document.getElementById('hostile-marks'), 'lock-mark drop-mark');
  const _dropFrom = new THREE.Vector3();
  const _lockPos = new THREE.Vector3();
  const playerTargets = new Map<string, LockTarget>();
  const playerFoes = new Map<string, Foe>();
  const _nose = new THREE.Vector3();
  const _globeEuler = new THREE.Euler();
  /** A war slider's value, shown beside it. */
  const sideSlider = (id: string): number => {
    const input = document.getElementById(id) as HTMLInputElement | null;
    const v = Number(input?.value ?? 0);
    const label = document.getElementById(`${id}-v`);
    if (label) label.textContent = String(v);
    return v;
  };
  const updateAirPool = () => {
    const own = aiMine?.checked !== false && !net.connected ? library.list().map((e) => e.craft) : [];
    sim.airTraffic.pool = [...BUILTINS.map((b) => b.craft), ...own];
    sim.airTraffic.count = Number(aiCount?.value ?? 8);
    if (aiCountLabel) aiCountLabel.textContent = String(sim.airTraffic.count);
    sim.airTraffic.friendlies = sideSlider('w-friends');
    sim.airTraffic.enemies = sideSlider('w-enemies');
    sim.airTraffic.freelancers = sideSlider('w-free');
    sim.groundTurrets.density = Math.max(0, Math.min(2, Number(turretInput?.value ?? 1))) as TurretDensity;
    if (turretLabel) turretLabel.textContent = ['Off', 'Sparse', 'Dense'][sim.groundTurrets.density];
  };
  // Tower turrets: off / sparse / dense (remembered).
  const turretInput = document.getElementById('w-turrets') as HTMLInputElement | null;
  const turretLabel = document.getElementById('w-turrets-v');
  const TURRET_STORAGE = 'turretDensity';
  if (turretInput && stored(TURRET_STORAGE) !== null) turretInput.value = String(Math.max(0, Math.min(2, Number(stored(TURRET_STORAGE)) || 0)));
  turretInput?.addEventListener('input', () => {
    try {
      localStorage.setItem(TURRET_STORAGE, turretInput.value);
    } catch { /* private mode: not remembered */ }
    updateAirPool();
  });
  // The war's aircraft: friendly, enemy (split between the other two teams), freelancers. Remembered.
  for (const id of ['w-friends', 'w-enemies', 'w-free']) {
    const input = document.getElementById(id) as HTMLInputElement | null;
    if (!input) continue;
    const saved = stored(`slider:${id}`);
    if (saved !== null) input.value = String(Math.max(Number(input.min), Math.min(Number(input.max), Number(saved) || 0)));
    input.addEventListener('input', () => {
      try {
        localStorage.setItem(`slider:${id}`, input.value);
      } catch { /* private mode: not remembered */ }
      updateAirPool();
    });
  }
  // Your team (remembered): your craft wears its colours; its turrets and aircraft are on your side.
  const TEAM_STORAGE = 'team';
  const savedTeam = Number(stored(TEAM_STORAGE));
  if (isTeam(savedTeam) && savedTeam !== sim.team) {
    sim.setTeam(savedTeam);
    replaceCraftView();
  }
  const chooseTeam = (team: Team) => {
    sim.setTeam(team);
    try {
      localStorage.setItem(TEAM_STORAGE, String(team));
    } catch { /* not remembered */ }
    replaceCraftView();
    net.setTeam(team);
    toast(`You fly for ${TEAMS[team].name}`);
  };
  // Credits (remembered) and the mercenaries they hire.
  const CREDIT_STORAGE = 'credits';
  sim.credits = Math.max(0, Math.floor(Number(stored(CREDIT_STORAGE)) || 0));
  // Hacking charges are kept with the credits.
  const HACK_STORAGE = 'hackCharges';
  sim.hackCharges = Math.max(0, Math.min(9, Math.floor(Number(stored(HACK_STORAGE)) || 0)));
  let savedHacks = sim.hackCharges;
  let savedCredits = sim.credits;
  { const shown = document.getElementById('w-credits-v'); if (shown) shown.textContent = sim.credits.toLocaleString(); }
  const STRATEGIC_STORAGE = 'strategic';
  const carried = stored(STRATEGIC_STORAGE);
  sim.strategic = carried === 'nuke' || carried === 'emp' ? carried : null;
  let savedStrategic = sim.strategic;
  const mercPanel = new MercPanel(sim, () => sim.airTraffic.pool.filter((d) => flyerKind(d) !== 'ground'), (t) => toast(t));
  // The 3D strike globe (the map's Globe button, Shift+Tab): pick a spot, send aircraft, call strikes.
  // Detailed (real models, full architecture up close) unless the device is a phone or set low.
  const globe = new GlobeView(!mobile && quality !== 'low' && !perf.powerSaver);
  const strikePanel = new StrikePanel(sim, globe, (t) => toast(t));
  const toggleGlobe = (on = !globe.visible) => {
    if (on) radarMap.toggleMap(false);
    globe.toggle(on, sim.position);
  };
  radarMap.onGlobe = () => toggleGlobe(true);
  radarMap.setGlobe(false);
  // Testing the credit system (F3 → Credits, or game.giveCredits(n) in the console).
  const setCredits = (n: number, why: string) => {
    sim.credits = Math.max(0, Math.floor(n));
    toast(`${why}: ${sim.credits.toLocaleString()} credits (debug)`);
    mercPanel.refresh(true);
  };
  const giveCredits = (n: number) => setCredits(sim.credits + n, `${n >= 0 ? '+' : ''}${n.toLocaleString()}`);
  for (const b of document.querySelectorAll<HTMLButtonElement>('[data-credits]')) {
    b.addEventListener('click', () => (b.dataset.credits === 'reset' ? setCredits(0, 'Reset') : giveCredits(Number(b.dataset.credits))));
  }
  document.getElementById('w-credits-apply')?.addEventListener('click', () => {
    const v = Number((document.getElementById('w-credits-set') as HTMLInputElement | null)?.value);
    if (Number.isFinite(v)) setCredits(v, 'Set');
  });
  let noticeAt = -Infinity;
  aiCount?.addEventListener('input', updateAirPool);
  aiMine?.addEventListener('change', updateAirPool);
  updateAirPool();
  setInterval(updateAirPool, 5000); // new designs join the traffic; multiplayer drops your own
  let currentEntry: LibraryEntry | null = null;
  /** While the agent builds a vehicle on the turntable: the craft that was there before. */
  let previewSaved: CraftDef | null = null;
  /** Load a craft (null = built-in trainer): on the turntable in the hangar, on the runway in flight. */
  /** Play the theme saved for a hangar entry (or fade out if it has none). */
  const playThemeFor = (id: string) => {
    void loadTheme(id).then((t) => {
      if ((currentEntry?.id ?? 'builtin:trainer') === id) void audio.playTheme(t?.audio ?? null);
    });
  };
  const select = (entry: LibraryEntry | null) => {
    previewSaved = null; // a real selection ends any agent preview
    playThemeFor(entry?.id ?? 'builtin:trainer');
    sim.loadCraft(entry ? entry.craft : TEST_PLANE);
    replaceCraftView();
    viewVersion = sim.version;
    comSlider.value = '0';
    comVal.textContent = '0.00';
    currentEntry = entry;
    player.profile = vehicleKind(sim);
    controlsPanel.render();
    rig.fitCraft(sim.craft.boundingRadius());
    reset(false);
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
    const mp = sim.craft.massProps;
    // The spawn pose puts the CoM on the runway centreline; keep that, centred on the turntable
    // (at the craft's resting height: the spawn site may be a rooftop or a hillside street).
    _hangarPos.set(-mp.com.x, sim.craft.restingHeight() + hangarView.turntableTop, -mp.com.z);
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
    craftCard.replaceChildren(craftPicker());
    craftCard.insertAdjacentHTML(
      'beforeend',
      row('TYPE', vehicleKind(sim)) +
        row('MASS', `${mass.toFixed(0)} kg`) +
        row('SPAN', `${(span * 2).toFixed(1)} m`) +
        row('T/W', tw),
    );
    craftCard.append(teamPicker(), bitPicker(), spawnPicker(), loadoutPicker(), reinforcePanel());
  };
  /**
   * Choose the craft on the main (hangar) screen: every built-in and saved design in one list,
   * with ‹ › to step through them (the same list as [ / ]).
   */
  const craftPicker = () => {
    const wrap = document.createElement('div');
    wrap.className = 'card-name craft-pick';
    const list = [...BUILTINS.map(builtinEntry), ...library.list()];
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Craft');
    const group = (title: string, entries: LibraryEntry[]) => {
      if (!entries.length) return;
      const g = document.createElement('optgroup');
      g.label = title;
      for (const e of entries) {
        const o = document.createElement('option');
        o.value = e.id;
        o.textContent = e.name;
        g.append(o);
      }
      sel.append(g);
    };
    group('Built-in', list.filter((e) => e.id.startsWith('builtin:')));
    group('Your designs', list.filter((e) => !e.id.startsWith('builtin:')));
    const cur = previewSaved ? 'building' : currentEntry?.id ?? 'builtin:trainer';
    if (previewSaved) {
      // The agent is building a vehicle on the turntable right now.
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = `Building: ${sim.craft.def.name}`;
      sel.prepend(o);
    } else if (!list.some((e) => e.id === cur)) {
      // An unsaved craft (fresh from the Studio): show it at the top.
      const o = document.createElement('option');
      o.value = cur;
      o.textContent = sim.craft.def.name;
      sel.prepend(o);
    }
    sel.value = cur;
    sel.addEventListener('change', () => {
      const e = list.find((x) => x.id === sel.value);
      if (e) select(e);
      sel.blur();
    });
    const step = (label: string, dir: 1 | -1) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'craft-step';
      b.textContent = label;
      b.setAttribute('aria-label', dir > 0 ? 'Next craft' : 'Previous craft');
      b.addEventListener('click', () => { cycleCraft(dir); b.blur(); });
      return b;
    };
    wrap.append(step('‹', -1), sel, step('›', 1));
    return wrap;
  };
  /** Weapons loadout for the craft (the same choice as I in flight). */
  const loadoutPicker = () => {
    const label = document.createElement('label');
    label.className = 'spawn-at';
    const name = document.createElement('span');
    name.textContent = 'ARM';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Weapons loadout');
    for (const id of LOADOUT_ORDER) {
      const o = document.createElement('option');
      o.value = id;
      o.textContent = LOADOUTS[id].label;
      sel.append(o);
    }
    sel.value = sim.weapons.loadout;
    sel.addEventListener('change', () => {
      sim.weapons.arm(sim.craft.def, sel.value as Loadout);
      sel.blur();
    });
    label.append(name, sel);
    return label;
  };
  /**
   * "Spawn at": any runway, any helipad, or (ground vehicles) the nearest street. The choice
   * lasts the session and is where respawn (R), auto-respawn and a world reset put the craft.
   */
  const spawnSiteFor = (id: string) => (id === 'street' ? STREET_SITE : landingSite(id) ?? null);
  let spawnChoice = (() => {
    try {
      const id = sessionStorage.getItem('spawnAt') ?? 'grid';
      return spawnSiteFor(id) ? id : 'grid'; // a stale id (e.g. a rooftop that no longer exists)
    } catch {
      return 'grid';
    }
  })();
  sim.spawnSite = spawnSiteFor(spawnChoice);
  /** Choose a spawn site (landing-site id, 'street' or 'grid') and put the craft there. False for an unknown id. */
  const chooseSpawn = (id: string): boolean => {
    const site = spawnSiteFor(id);
    if (!site) return false;
    spawnChoice = id;
    try {
      sessionStorage.setItem('spawnAt', id);
    } catch { /* private mode: the choice still lasts until reload */ }
    sim.spawnSite = site;
    reset(false);
    if (mode === 'hangar') showOnTurntable();
    return true;
  };
  // The street search reads the city's obstacle height map: build it while idle, not mid-respawn.
  setTimeout(() => obstacleTop(0, 0), 4000);
  /** TEAM: which side you fly for (your livery, your turrets, your wingmen). */
  // The player's own Bit: its style, chosen in the hangar and remembered.
  const BIT_STYLE_STORAGE = 'bitStyle';
  let bitStyle = sanitizeBitStyle((() => { try { return JSON.parse(localStorage.getItem(BIT_STYLE_STORAGE) ?? 'null'); } catch { return null; } })());
  bitsView.setStyle(bitStyle);
  const bitPicker = () => {
    const wrap = document.createElement('div');
    wrap.className = 'spawn-pick bit-pick';
    const name = document.createElement('span');
    name.textContent = 'BIT';
    name.title = 'Your Bit on foot (= steps out of a stopped vehicle)';
    wrap.append(name);
    for (const key of ['light', 'size', 'idle', 'spin'] as const) {
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Bit ${key}`);
      for (const [v, label] of BIT_STYLE_CHOICES[key]) {
        const o = document.createElement('option');
        o.value = v;
        o.textContent = label;
        if (key === 'light') o.style.color = STYLE_LIGHT[v as keyof typeof STYLE_LIGHT];
        sel.append(o);
      }
      sel.value = bitStyle[key];
      if (key === 'light') sel.style.color = STYLE_LIGHT[bitStyle.light];
      sel.addEventListener('change', () => {
        bitStyle = sanitizeBitStyle({ ...bitStyle, [key]: sel.value });
        bitsView.setStyle(bitStyle);
        if (key === 'light') sel.style.color = STYLE_LIGHT[bitStyle.light];
        try { localStorage.setItem(BIT_STYLE_STORAGE, JSON.stringify(bitStyle)); } catch { /* not remembered */ }
        sel.blur();
      });
      wrap.append(sel);
    }
    return wrap;
  };
  const teamPicker = () => {
    const label = document.createElement('label');
    label.className = 'spawn-pick team-pick';
    const name = document.createElement('span');
    name.textContent = 'TEAM';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Team');
    for (const t of TEAMS) {
      const o = document.createElement('option');
      o.value = String(t.id);
      o.textContent = t.name;
      o.style.color = t.light;
      sel.append(o);
    }
    sel.value = String(sim.team);
    sel.style.color = TEAMS[sim.team].light;
    sel.addEventListener('change', () => {
      chooseTeam(Number(sel.value) as Team);
      sel.style.color = TEAMS[sim.team].light;
      sel.blur();
    });
    label.append(name, sel);
    return label;
  };
  const spawnPicker = () => {
    const label = document.createElement('label');
    label.className = 'spawn-at';
    const name = document.createElement('span');
    name.textContent = 'SPAWN';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Spawn at');
    const group = (title: string, sites: Array<{ id: string; name: string }>) => {
      const g = document.createElement('optgroup');
      g.label = title;
      for (const s of sites) {
        const o = document.createElement('option');
        o.value = s.id;
        // Where the sites are in enemy hands, say so.
        const at = s as unknown as { x?: number; z?: number };
        const owner = at.x !== undefined && at.z !== undefined ? sim.groundTurrets.territory.ownerAt(at.x, at.z) : null;
        o.textContent = owner !== null && owner !== sim.team ? `${s.name} (${TEAMS[owner].name} territory)` : s.name;
        g.append(o);
      }
      sel.append(g);
    };
    const sites = landingSites();
    if (vehicleKind(sim) === 'ground') group('Streets', [STREET_SITE]);
    group('Runways', sites.filter((s) => s.kind === 'runway'));
    group('Helipads', sites.filter((s) => s.kind === 'helipad'));
    // Show where a respawn really goes: a street choice with an aircraft (or a pad on a fallen
    // tower) uses Grid International, and the choice is kept for the next ground vehicle.
    sel.value = sim.effectiveSpawnSite()?.id ?? 'grid';
    sel.addEventListener('change', () => {
      chooseSpawn(sel.value);
      sel.blur();
    });
    label.append(name, sel);
    return label;
  };
  /**
   * Per-part reinforcement (hangar): levels 0-3, each +15% part mass, +60% strength, +80% impact
   * HP. Saved into the craft definition (and the library entry, for generated craft).
   */
  let reinforceOpen = false;
  const reinforcePanel = () => {
    const def = sim.designDef;
    const details = document.createElement('details');
    details.className = 'reinforce';
    details.open = reinforceOpen;
    details.addEventListener('toggle', () => (reinforceOpen = details.open));
    const extra = def.parts.reduce((s, p) => s + p.mass * 0.15 * (p.reinforce ?? 0), 0);
    const summary = document.createElement('summary');
    summary.textContent = `REINFORCE${extra > 0 ? ` · +${extra.toFixed(0)} kg` : ''}`;
    details.append(summary);
    const list = document.createElement('div');
    list.className = 'reinforce-list';
    for (const p of def.parts) {
      const label = document.createElement('label');
      const name = document.createElement('span');
      name.textContent = p.id;
      name.title = p.kind;
      const sel = document.createElement('select');
      sel.setAttribute('aria-label', `Reinforcement for ${p.id}`);
      for (let lv = 0; lv <= 3; lv++) {
        const o = document.createElement('option');
        o.value = String(lv);
        o.textContent = lv ? `${'▮'.repeat(lv)} +${(p.mass * 0.15 * lv).toFixed(p.mass * 0.15 < 1 ? 1 : 0)} kg` : 'none';
        sel.append(o);
      }
      sel.value = String(p.reinforce ?? 0);
      sel.addEventListener('change', () => {
        const next = structuredClone(def);
        const part = next.parts.find((x) => x.id === p.id)!;
        const lv = Number(sel.value);
        if (lv) part.reinforce = lv;
        else delete part.reinforce;
        applyCraftEdit(next);
      });
      label.append(name, sel);
      list.append(label);
    }
    details.append(list);
    return details;
  };
  /** Swap in an edited version of the current craft (keeps its library entry in step). */
  const applyCraftEdit = (def: CraftDef) => {
    sim.loadCraft(def);
    replaceCraftView();
    viewVersion = sim.version;
    if (currentEntry) {
      library.update(currentEntry.id, { craft: def });
      currentEntry = { ...currentEntry, craft: def };
    }
    if (mode === 'hangar') showOnTurntable();
    else updateCraftCard();
  };
  const setMode = (m: AppMode) => {
    if (captureBusy) return;
    curveOn.value = m === 'flight' ? 1 : 0; // the hangar is flat
    autopilot.disengage();
    if (m === 'hangar') apPanel.hide();
    mode = m;
    syncRenderControls();
    applyModeClass(m);
    if (mobile) {
      document.getElementById('help')!.classList.add('hidden');
      debugOn = false; sim.recordForces = false; hud.setDebugVisible(false);
    }
    const hangar = m === 'hangar';
    craftScene().add(craftView.root); // re-parents from the other scene
    rig.setSuspended(hangar);
    hangarView.setActive(hangar);
    accumulator = 0;
    debug.setVisible(!hangar && debugOn); // the CoM/CoL markers ride on the craft view
    if (hangar) {
      // Physics is paused in the hangar: put the craft back at its spawn pose on the turntable.
      sim.respawn(); // the world (and its wreckage) stays as it is
      if (sim.version !== viewVersion) {
        if (sim.craft !== craftView.craft) replaceCraftView();
        viewVersion = sim.version;
      }
      showOnTurntable();
      audio.silence();
      callouts.reset();
      if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
      if (mobile) {
        studio.root.classList.add('hidden');
        document.getElementById('studio-open')?.setAttribute('aria-expanded', 'false');
      } else studio.show();
    } else {
      reset(false);
    }
    flyBtn.blur();
    toHangarBtn.blur();
  };
  /** Take the selected craft flying from the runway. */
  const fly = (entry?: LibraryEntry | null) => {
    if (entry !== undefined) select(entry);
    if (mode !== 'flight') setMode('flight');
    else reset(false);
  };
  flyBtn.addEventListener('click', () => fly());
  toHangarBtn.addEventListener('click', () => setMode('hangar'));
  document.getElementById('studio-open')!.addEventListener('click', () => studio.show());
  const studio = new Studio({
    client,
    library,
    current: () => ({ craft: sim.designDef, entryId: currentEntry?.id ?? null }),
    flightNotes: () => flightLog.summary(),
    // Async results (a design finishing) must not swap the craft out from under a flight.
    select: (entry) => {
      if (mode === 'hangar') select(entry);
    },
    fly: () => fly(),
    playTheme: (id) => playThemeFor(id),
    // The agent building a vehicle: show it on the turntable as its parts stream in. The craft
    // that was there is remembered and comes back if the job is cancelled or fails.
    preview: (def) => {
      if (mode !== 'hangar') return;
      if (def === null) {
        if (previewSaved) {
          const saved = previewSaved;
          previewSaved = null;
          showDef(saved);
        }
        return;
      }
      previewSaved ??= sim.designDef;
      showDef(def);
    },
  });
  function showDef(def: CraftDef): void {
    try {
      sim.loadCraft(def);
    } catch {
      return; // a partial craft that doesn't validate yet: keep the last good frame
    }
    replaceCraftView();
    viewVersion = sim.version;
    rig.fitCraft(sim.craft.boundingRadius());
    showOnTurntable();
  }

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

  const activeRayMode = () => {
    let rt = rayModes.get(mode);
    if (!rt) {
      rt = new RayTraceMode(renderer, mode === 'hangar' ? hangarView.scene : scene, mode === 'hangar' ? hangarView.camera : camera);
      rayModes.set(mode, rt);
    }
    rt.setShapes(mode === 'hangar' ? hangarShapes(sim, craftView.root.position, craftView.root.quaternion)
      : flightShapes(sim, craftView.root.position, craftView.root.quaternion, camera.position));
    return rt;
  };
  const renderActive = () => {
    if (actualRenderMode() === 'raytrace') {
      if (perf.rayTraceOverloaded) {
        suspendedRT[mode] = true;
        syncRenderControls();
      } else {
        try { activeRayMode().render(); return; }
        catch (error) {
          suspendedRT[mode] = true;
          console.warn('Ray tracing unavailable; using raster.', error);
          toast('Ray tracing unavailable; using raster.');
          syncRenderControls();
        }
      }
    }
    (mode === 'hangar' ? hangarFX : flightFX).render();
  };
  let captureInfo = { renderMode: 'raster' as RenderMode, samples: 1, width: 0, traceWidth: 0 };
  const capture = async (width = 1280, samples = 1) => {
    if (captureBusy) throw new Error('A photo is already being captured');
    captureBusy = true;
    const controlsEnabled = hangarView.controls.enabled;
    hangarView.controls.enabled = false;
    const capturedMode = mode;
    const method = actualRenderMode();
    try {
      const rt = method === 'raytrace' ? activeRayMode() : null;
      const pass = rt ? rt.photoPass(samples, Math.min(width, samples > 1 ? 768 : 320)) : capturedMode === 'hangar' ? hangarFX : flightFX;
      const image = await captureFrame(renderer, capturedMode === 'hangar' ? hangarView.scene : scene,
        capturedMode === 'hangar' ? hangarView.camera : camera, width, pass);
      captureInfo = { renderMode: method, samples: rt?.samples ?? 1, width, traceWidth: rt?.renderWidth ?? 0 };
      return image;
    } finally {
      hangarView.controls.enabled = controlsEnabled;
      captureBusy = false;
    }
  };
  const takePhoto = async () => {
    try {
      toast('Rendering photo…');
      const blob = await capture(1280, 16);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = `aerospace-${mode}-${captureInfo.renderMode}.png`; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 30_000);
      toast(`Saved ${captureInfo.renderMode === 'raytrace' ? 'ray traced' : 'raster'} photo`);
    } catch (error) { toast(`Photo failed: ${error instanceof Error ? error.message : String(error)}`); }
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
      /** Fly a built-in by id ('runner', 'crawler', ...), as the vehicle picker would. */
      selectBuiltin: (id: string) => {
        const b = BUILTINS.find((x) => x.id === id);
        if (!b) throw new Error(`Unknown built-in "${id}"`);
        select(builtinEntry(b));
      },
      /** PNG of the current 3D view (GPU readback; works on WebGPU and WebGL2). */
      capture,
      takePhoto,
      /** Camera rig (chase / orbit; rig.setOrbitDistance(m) pulls the orbit camera back). */
      rig,
      get captureInfo() { return captureInfo; },
      get renderMode() { return actualRenderMode(); },
      get requestedRenderMode() { return requestedRender[mode]; },
      get raytrace() { return rayModes.get(mode); },
      setRenderMode,
      /** Post-processing quality for both scenes: 'low' | 'medium' | 'high'. */
      setQuality: (q: Quality) => {
        if (!QUALITIES.includes(q)) throw new Error(`Unknown quality "${q}"`);
        flightFX.setQuality(q);
        hangarFX.setQuality(q);
        weatherView.volumetric = q !== 'low';
        setCloudQuality(q === 'high' ? 48 : mobile ? 18 : 32);
      },
      worldEvents: sim.atmosphere.events,
      /** The digital world: architecture, terrain and route views, the inspector (K). */
      arch: { world: archView, terrain: terrainView, routes: routeView, inspector, worldView },
      triggerDisaster,
      /** Credits (testing the mercenaries and the armory): read, or give some. */
      get credits() { return sim.credits; },
      giveCredits,
      globe,
      toggleGlobe,
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
      setPilot: (p: ControlSource | null) => (pilot = p ?? autopilot),
      autopilot,
      /** Reset the whole world (respawn() keeps the world and only replaces the craft). */
      reset: () => reset(true),
      respawn: () => reset(false),
      /** Choose where respawns put the craft: a landing-site id, 'street' or 'grid' (as the hangar's Spawn at select). */
      spawnAt: (id: string) => {
        if (!chooseSpawn(id)) throw new Error(`Unknown spawn site "${id}" (a landing-site id, 'street' or 'grid')`);
        updateCraftCard();
      },
      net,
      netPanel,
    },
  });

  // --- Fixed-timestep loop with render interpolation
  const renderPos = new THREE.Vector3();
  const footPos = new THREE.Vector3();
  const footRot = new THREE.Quaternion();
  const _up = new THREE.Vector3(0, 1, 0);
  let wasOnFoot = false;
  let routesSeen = -1;
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
  netPanel.autoJoin(params);

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
    if (captureBusy) { accumulator = 0; return; }
    const renderThisFrame = perf.frame(dt);
    syncRenderControls();

    for (const a of player.poll()) {
      if (a === 'studio') setMode(mode === 'flight' ? 'hangar' : 'flight');
      else if (a === 'mute') toast(audio.toggleMute() ? '🔇 Sound off' : '🔊 Sound on');
      else if (a === 'autopilot') {
        if (autopilot.state.engaged) {
          autopilot.disengage();
          toast('Autopilot off');
        } else {
          const kind = vehicleKind(sim);
          if (kind === 'lighter-than-air' || kind === 'ground') toast('No autopilot for this craft');
          else {
            autopilot.engage(telemetry, kind, autopilotPerf());
            const st = autopilot.state;
            toast(`Autopilot on · HDG ${Math.round(st.heading).toString().padStart(3, '0')} · ${st.altitude.toFixed(0)} m${kind === 'airplane' ? ` · ${(st.speed * 1.944).toFixed(0)} kt` : ''} — stick and throttle adjust it`);
          }
        }
      }
      else if (a === 'trail') {
        const m = sim.trails.cycleMode(sim.craft, sim.isAirplane(), sim.time);
        toast(m === 'wall' ? 'Jetwall: solid light' : m === 'ribbon' ? 'Light ribbon: fades behind you' : 'Trail off');
      }
      else if (a === 'map') { if (globe.visible) toggleGlobe(false); radarMap.toggleMap(); }
      else if (a === 'globe') toggleGlobe();
      else if (a === 'radarRange') toast(`Radar ${radarMap.cycleRange() / 1000} km`);
      else if (a === 'recentre') {
        if (sim.craft.turretRig) { sim.recentreTurret(); toast('Turret: back to the nose'); }
      } else if (a === 'chase') {
        const kind = autopilotKind();
        if (autopilot.state.engaged && autopilot.state.mode === 'chase') {
          autopilot.disengage();
          toast('Chase off');
        } else if (kind !== 'airplane' && kind !== 'rotorcraft') toast('Chase: aircraft only');
        else {
          autopilot.engage(telemetry, kind, autopilotPerf(), { mode: 'chase', target: sim.lock.target });
          toast(autopilot.state.mode === 'chase' ? `Chasing ${sim.lock.target?.name} — the stick takes over` : autopilot.state.notice);
        }
      }
      else if (a === 'loadout') {
        const l = sim.weapons.cycle();
        toast(l === 'none' ? 'Weapons: unarmed' : `Weapons: ${LOADOUTS[l].label} · V fires guns/cannon, O bombs/missiles`);
      }
      else if (a === 'screenshot') void takePhoto();
      else if (a === 'nextVehicle') cycleCraft(1);
      else if (a === 'prevVehicle') cycleCraft(-1);
      else if (mode !== 'flight') continue; // the rest only means something in flight
      else if (a === 'reset') { reset(false); toast('New plane — the world stays as it is'); }
      else if (a === 'resetWorld') { reset(true); toast('World reset'); }
      else if (a === 'camera') rig.toggle(sim.walker.active ? footPos : renderPos);
      else if (a === 'apPanel') apPanel.toggle();
      else if (a === 'mercs') mercPanel.toggle();
      else if (a === 'foot') {
        // Step out as a Bit, or get back in.
        const why = sim.walker.active ? sim.boardVehicle() : sim.exitVehicle();
        if (why) toast(why);
        else if (sim.walker.active) { autopilot.disengage(); toast('On foot · W/S walk, A/D turn, Q/E sidestep · V says YES, O says NO · = gets back in'); }
        else { player.reset(); toast('Aboard'); }
      }
      else if (a === 'strategic') { if (sim.walker.active) { const why = sim.placeStrategic(); if (why) toast(why); } else toast(sim.launchStrategic() ?? 'Launched'); }
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

    net.update(dt);
    if (mode === 'hangar' && sim.walker.active) sim.boardVehicle(); // the hangar shows the vehicle
    if (mode === 'hangar') {
      // Physics paused; the craft sits on the turntable under the orbit camera.
      accumulator = 0;
      hangarView.update(dt);
      if (presentToCanvas && renderThisFrame) renderActive();
      return;
    }

    // Weapons triggers (held keys / buttons); the flight computer never fires.
    const trig = player.firing();
    const onFoot = sim.walker.active;
    sim.weapons.trigger.primary = trig.primary && !onFoot;
    sim.weapons.trigger.secondary = trig.secondary && !onFoot;
    sim.hackHeld = trig.hack && !onFoot;
    document.body.classList.toggle('hacking', sim.hackCharges > 0);
    // On foot the triggers are the Bit's two answers; the people in earshot answer back.
    if (onFoot && (trig.primary || trig.secondary)) {
      const word = sim.speak(trig.primary ? 'yes' : 'no');
      if (word) toast(word);
    }
    if (onFoot !== wasOnFoot) {
      wasOnFoot = onFoot;
      rig.fitCraft(onFoot ? 2.4 : sim.craft.boundingRadius());
      rig.snap();
    }
    const aim = player.aim();
    sim.turretInput.yaw = aim.yaw;
    sim.turretInput.pitch = aim.pitch;
    // Other players can be locked too (missiles home on them; the radar rings them).
    sim.extraLockTargets = [];
    sim.extraFoes = [];
    for (const p of net.players.values()) {
      let h = playerTargets.get(p.id);
      if (!h) {
        const id = p.id;
        h = {
          id: `player:${id}`, kind: 'player', name: p.name, radius: 4,
          alive: () => !!net.players.get(id)?.pose.visible,
          position: (o) => o.copy(net.players.get(id)?.pose.position ?? o),
          velocity: (o) => {
            const q = net.players.get(id);
            return q ? o.set(0, 0, -q.pose.speed).applyQuaternion(q.pose.rotation) : o.set(0, 0, 0);
          },
        };
        playerTargets.set(p.id, h);
      }
      if (!p.pose.visible) continue;
      // Team-mates are never locked; players of other teams are foes to your aircraft and turrets.
      if (p.team !== sim.team) {
        sim.extraLockTargets.push(h);
        let foe = playerFoes.get(p.id);
        if (!foe) playerFoes.set(p.id, (foe = { side: p.team, lock: h, kind: 'remote', engage: true, ground: false }));
        foe.side = p.team;
        sim.extraFoes.push(foe);
      }
    }
    accumulator += dt;
    stepsThisFrame = 0;
    let stepMs = 0;
    while (accumulator >= sim.dt && stepsThisFrame < TUNING.maxStepsPerFrame) {
      const inputs = pilot.sample(sim.dt, telemetry);
      if (sim.walker.active) sim.walkInput = player.walk();
      sim.step(inputs);
      stepMs += sim.lastStepMs;
      accumulator -= sim.dt;
      stepsThisFrame++;
    }
    if (stepsThisFrame === TUNING.maxStepsPerFrame) accumulator = 0; // drop time rather than spiral
    telemetry = sim.telemetry();
    const airframeHit = sim.airframeTouchingGround();
    flightLog.update(telemetry, dt, airframeHit);
    audio.update(telemetry, sim.craft, sim.failures.length, airframeHit, dt);
    audio.updateThunder(sim.lightning.strikes, sim.time, camera.position);
    callouts.update(telemetry, sim.failures);
    // Structure changed: a part broke off (hide it), or the craft was rebuilt (new view).
    if (sim.version !== viewVersion) {
      if (sim.craft !== craftView.craft) replaceCraftView();
      else craftView.hideParts(sim.craft.detached);
      viewVersion = sim.version;
    }
    debrisView.update(sim.debris);
    townView.update(dt);
    sitesView.update();
    trailView.update(sim.time);
    trafficView.update(sim.time);
    chipsView.update(dt);
    explosionView.update(sim.time, sim.explosions);
    weaponsView.update(sim.time);
    // The hacking beam: from the nose to the locked target while it holds.
    {
      const target = sim.hackBeam.status === 'beam' ? sim.lock.target : null;
      if (target) {
        _beamFrom.set(0, 0, -2).applyQuaternion(renderRot).add(renderPos);
        target.position(_beamTo);
        _beamTo.set(renderPos.x + wrapDelta(renderPos.x, _beamTo.x), _beamTo.y, renderPos.z + wrapDelta(renderPos.z, _beamTo.z));
      }
      hackBeamView.update(target ? _beamFrom : null, target ? _beamTo : null, TEAMS[sim.team].light, sim.hackBeam.progress, sim.time);
    }
    aiTrafficView.update(dt);
    aiTrafficView.simTime = turretsView.simTime = sim.time;
    turretsView.update(dt);
    strategicView.update(sim.time, sim.blasts);
    // A nuke: the boom, a rumble and a white flash that fades (stronger the nearer it is).
    for (const b of sim.blasts) {
      if (b.time <= blastSeen) continue;
      blastSeen = b.time;
      const d = Math.hypot(b.x - sim.position.x, b.y - sim.position.y, b.z - sim.position.z);
      audio.explosion(d * (b.kind === 'nuke' ? 0.15 : 0.6));
      player.rumble(1, b.kind === 'nuke' ? 2000 : 600);
      if (b.kind === 'nuke') {
        const flash = document.getElementById('nuke-flash');
        flash?.animate([{ opacity: Math.max(0.15, 1 - d / 8000) }, { opacity: 0 }], { duration: 2500, easing: 'ease-out' });
      }
    }
    craterView.update(sim.time, sim.craters);
    craterView.updateRoads(sim.roadDamage);
    {
      // Sonic booms: the Mach cone and vapour, ground shock rings, and the double crack when the
      // craft goes supersonic or a boom breaks something.
      const b = craftBounds(sim.craft.def);
      const length = Math.max(b.max.z - b.min.z, b.max.x - b.min.x);
      const vel = new THREE.Vector3(...telemetry.velocity);
      boomView.update(sim.time, renderPos, vel, telemetry.mach, length, sim.booms, (x, z) => terrainHeight(x, z));
      const supersonic = telemetry.mach > 1.02;
      if (supersonic && !wasSupersonic) audio.boom(0.6);
      wasSupersonic = supersonic;
      for (const e of sim.booms) {
        if (e.time <= boomHeardAt) continue;
        boomHeardAt = e.time;
        if (e.blocks > 0) { audio.boom(Math.min(1, e.groundDp / 3000)); player.rumble(0.8, 400); }
      }
    }
    {
      const ammo = sim.weapons.ammo();
      const kinds = Object.keys(ammo) as WeaponKind[];
      document.body.classList.toggle('armed', kinds.length > 0);
      hud.setWeapons(kinds.length ? kinds.map((k) => `${WEAPONS[k].label.slice(0, 3).toUpperCase()} ${ammo[k]}`).join(' ') : null);
    }
    {
      // Hostile aircraft within 6 km: brackets over them, and the HOSTILE row (nearest first).
      const marks: HostileMark[] = [];
      for (const f of sim.airTraffic.hostileFlyers()) {
        const range = f.pos.distanceTo(sim.position);
        if (range < 6000) marks.push({ pos: f.pos, range, attacking: f.combat !== 'patrol', color: f.color });
      }
      for (const t of sim.groundTurrets.live()) {
        if (!hostile(sim.team, t.side)) continue;
        const pos = new THREE.Vector3(t.pos.x, t.pos.y + 3, t.pos.z);
        const range = pos.distanceTo(sim.position);
        if (range < 6000) marks.push({ pos, range, attacking: t.state === 'firing' || t.state === 'charging', color: t.color, tag: t.site.kind === 'rail' ? 'RAIL' : undefined });
      }
      marks.sort((a, b) => a.range - b.range);
      const near = marks[0];
      // Friendly aircraft and mercenaries: a small caret each, after the enemies.
      const friends: HostileMark[] = [];
      for (const f of sim.airTraffic.combatFlyers()) {
        if (f.side === null || hostile(sim.team, f.side)) continue;
        const range = f.pos.distanceTo(sim.position);
        if (range < 4000) friends.push({ pos: f.pos, range, attacking: false, color: f.color, friend: true });
      }
      friends.sort((a, b) => a.range - b.range);
      marks.push(...friends);
      const underFire = sim.time - sim.lastHitAt < 2;
      hud.setHostiles(near ? {
        count: marks.length, range: near.range, kills: sim.airTraffic.kills, underFire,
        bearing: (Math.atan2(near.pos.x - sim.position.x, -(near.pos.z - sim.position.z)) * 180 / Math.PI + 360) % 360,
      } : null);
      if (mode === 'flight') hostileMarkers.update(camera, marks, window.innerWidth, window.innerHeight);
      else hostileMarkers.hide();
    }
    if (mode === 'flight') {
      // Radar and planet map: the simulation's vehicles, and the other players on the Grid.
      const contacts: Contact[] = simContacts(sim);
      const playerAdsb = [];
      for (const p of net.players.values()) {
        if (!p.pose.visible) continue;
        _nose.set(0, 0, -1).applyQuaternion(p.pose.rotation);
        const heading = Math.atan2(_nose.x, -_nose.z);
        contacts.push({ id: `player:${p.id}`, kind: 'player', foe: p.team !== sim.team, x: p.pose.position.x, z: p.pose.position.z, y: p.pose.position.y, heading, color: p.color, name: p.name });
        // Their ADS-B: name as the callsign, velocity from their latest state.
        const v = p.latest?.v ?? [0, 0, 0];
        playerAdsb.push(craftRecord({
          id: `player:${p.id}`, callsign: p.name.toUpperCase().slice(0, 10), type: p.craft.name, self: false, side: p.team, team: sim.team, color: p.color,
          x: p.pose.position.x, y: p.pose.position.y, z: p.pose.position.z, vx: v[0], vy: v[1], vz: v[2], heading,
        }, sim.position));
      }
      sim.extraAdsb = playerAdsb;
      // Carrying a nuke in the air: where it would burst if dropped now.
      let drop: { x: number; z: number; radius: number; armed: boolean } | null = null;
      if (sim.strategic === 'nuke' && !sim.exploded && sim.position.y - terrainHeight(sim.position.x, sim.position.z) > 20) {
        _dropFrom.set(0, -1.6, 0).applyQuaternion(sim.rotation).add(sim.position);
        const v = telemetry.velocity;
        const pr = predictDrop('nuke', _dropFrom, new THREE.Vector3(v[0], v[1], v[2]), (x, z) => (isSea(x) ? 0 : terrainHeight(x, z)));
        drop = { x: pr.point.x, z: pr.point.z, radius: STRATEGIC.nuke.fireball, armed: pr.armed };
        dropMarker.update(camera, { pos: pr.point, range: pr.point.distanceTo(sim.position), name: '', locked: pr.armed, text: pr.armed ? 'DROP' : 'DUD: TOO LOW' }, window.innerWidth, window.innerHeight);
      } else dropMarker.update(camera, null, window.innerWidth, window.innerHeight);
      _nose.set(0, 0, -1).applyQuaternion(sim.rotation);
      // ADS-B: every vehicle's broadcast, for the radar, the tags in the view and the globe.
      const adsb = sim.adsbRecords();
      adsbTags.update(camera, mode === 'flight' && radarMap.adsbOn && !globe.visible ? adsb : null, sim.position, window.innerWidth, window.innerHeight);
      const radarState = { adsb, drop, x: sim.position.x, z: sim.position.z, y: sim.position.y, heading: Math.atan2(_nose.x, -_nose.z), contacts, sites: landingSites(), lockedId: sim.lock.target?.id ?? null, territory: sim.groundTurrets.territory, teamColors: TEAMS.map((t) => t.light) };
      radarMap.update(now / 1000, radarState);
      if (globe.visible) {
        // Designs for the models: the AI aircraft's, other players' (in their side's livery), yours.
        const flyers = new Map(sim.airTraffic.flyers.map((f) => [`air:${f.id}`, f]));
        const liveries = new Map<string, CraftDef>();
        const model = (id: string) => {
          if (id === 'self') {
            _globeEuler.setFromQuaternion(sim.rotation, 'YXZ');
            return { def: sim.craft.def, pitch: _globeEuler.x, bank: -_globeEuler.z };
          }
          const f = flyers.get(id);
          if (f) return { def: f.def, pitch: f.pitch, bank: f.bank };
          if (id.startsWith('player:')) {
            const p = net.players.get(id.slice(7));
            if (!p) return null;
            let def = liveries.get(id);
            if (!def) liveries.set(id, (def = sideLivery(p.craft, p.team)));
            return { def };
          }
          return null;
        };
        globe.render({
          me: { x: sim.position.x, z: sim.position.z, heading: radarState.heading }, adsb, tracks: sim.adsb.tracks,
          turrets: contacts.filter((c) => c.kind === 'turret'), sites: radarState.sites, model,
          strikes: sim.strikes.map((s) => { const at = sim.strikeSystem.position(s); return { kind: s.kind, x: s.x, z: s.z, fromX: s.fromX, fromZ: s.fromZ, at: at ? { x: at.x, z: at.z, y: at.y } : null, eta: s.eta - sim.time }; }),
          orders: sim.airTraffic.orders(), surface: radarMap.baseMap(), wash: radarMap.washMap(radarState), washVersion: sim.groundTurrets.territory.version,
        });
        strikePanel.update(dt);
      }
      // The lock: the marker in the view and the LOCK row; the turret row; incoming missiles.
      const tracked = sim.lock.tracked;
      if (tracked) {
        tracked.position(_lockPos);
        const range = Math.hypot(wrapDelta(sim.position.x, _lockPos.x), _lockPos.y - sim.position.y, wrapDelta(sim.position.z, _lockPos.z));
        _lockPos.set(sim.position.x + wrapDelta(sim.position.x, _lockPos.x), _lockPos.y, sim.position.z + wrapDelta(sim.position.z, _lockPos.z));
        lockMarker.update(camera, { pos: _lockPos, range, name: tracked.name, locked: sim.lock.locked }, window.innerWidth, window.innerHeight);
        // The hacking beam on it: its progress, or why it won't hold.
        const hb = sim.hackBeam;
        const hack = !sim.hackHeld ? null : hb.status === 'beam' ? `HACK ${Math.round(hb.progress * 100)}%` : hb.status === 'idle' ? null : hb.status.toUpperCase();
        hud.setLock({ name: tracked.name, range, locked: sim.lock.locked, hack });
      } else {
        lockMarker.update(camera, null, window.innerWidth, window.innerHeight);
        hud.setLock(null);
      }
      const t = sim.craft.turret;
      hud.setTurret(sim.craft.turretRig ? { yaw: t.yaw * 180 / Math.PI, pitch: t.pitch * 180 / Math.PI, auto: sim.turretAuto } : null);
      hud.setMissileWarning(sim.incomingMissiles(), sim.groundTurrets.charging(sim.selfTarget));
    } else {
      lockMarker.update(camera, null, window.innerWidth, window.innerHeight);
      hud.setMissileWarning(0);
    }
    if (!sim.explosions.length) explosionHeardAt = -Infinity;
    for (const e of sim.explosions) {
      if (e.time <= explosionHeardAt) continue;
      explosionHeardAt = e.time;
      audio.explosion(Math.hypot(e.x - camera.position.x, e.y - camera.position.y, e.z - camera.position.z));
      player.rumble(1, 900);
    }
    // A wreck is replaced by a new plane on the runway after a few seconds (the world stays).
    if (sim.exploded && explodedAt === null) explodedAt = sim.time;
    if (!sim.exploded) explodedAt = null;
    const respawnLeft = explodedAt === null ? 0 : TUNING.respawnDelay - (sim.time - explodedAt);
    const footDown = sim.walker.active && sim.walker.downAt !== null;
    hud.setDestroyed(sim.exploded || footDown, footDown && !sim.exploded ? Math.max(0, TUNING.respawnDelay - (sim.time - sim.walker.downAt!)) : Math.max(0, respawnLeft), sim.derezCause === 'shot');
    if (explodedAt !== null && respawnLeft <= 0) {
      explodedAt = null;
      reset(false);
      const site = sim.effectiveSpawnSite();
      toast(site && site.id !== 'grid' ? `New craft at ${site.name}` : 'New plane on the runway');
    }
    oceanView.update(sim.time, camera);
    lightningView.update(sim.time, sim.lightning.strikes, sim.craft, Math.max(sim.lightning.staticCharge, (sim.atmosphere.settings.storm ?? 0) * 0.5));
    fireView.update(sim.time, sim.fire, sim.craft);

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
    bitsView.update(sim.time, alpha);
    chargesView.update(sim.time, sim.charges);
    // On foot the camera follows the Bit, not the parked vehicle.
    if (sim.walker.active) {
      const w = sim.walker;
      footPos.set(w.prevX + (w.x - w.prevX) * alpha, w.prevY + (w.y - w.prevY) * alpha + BIT.hover, w.prevZ + (w.z - w.prevZ) * alpha);
      footRot.setFromAxisAngle(_up, w.prevYaw + (w.yaw - w.prevYaw) * alpha);
      velocity.set(w.vx, 0, w.vz);
    }
    const viewPos = sim.walker.active ? footPos : renderPos;
    const viewRot = sim.walker.active ? footRot : renderRot;
    // Crossed a wrap edge: the craft jumped one circumference; the camera jumps with it.
    if (sim.wrapCount !== wrapsSeen) {
      wrapsSeen = sim.wrapCount;
      rig.snap();
    }
    rig.update(dt, viewPos, viewRot, velocity);
    // Planet curvature follows the camera; from high up the clip range opens to show the globe.
    curveOrigin.value.copy(camera.position);
    updateSkyPlanet(camera.position.y, PLANET.radius);
    const alt = Math.max(0, camera.position.y);
    // Far plane just past the horizon (the tangent distance), so from orbit the whole visible
    // disc of the planet, out to its limb, is inside the clip range.
    const far = Math.max(20000, Math.min(PLANET.radius * 12, 6000 + Math.sqrt(2 * PLANET.radius * alt + alt * alt) * 1.15));
    const near = Math.min(20, Math.max(0.3, alt / 4000));
    if (Math.abs(camera.far - far) > far * 0.05 || camera.near !== near) {
      camera.far = far;
      camera.near = near;
      camera.updateProjectionMatrix();
    }
    if (++curvatureTick % 60 === 1) applyCurvature(scene);
    worldView.update(camera, renderPos, dt);
    archView.update(camera);
    updateKits();
    terrainView.update(camera);
    if (sim.staticWorld.version !== routesSeen) { routesSeen = sim.staticWorld.version; routeView.setDown(sim.staticWorld.downInfra()); }
    routeView.update(camera.position);
    inspector.update(dt);
    // From orbit the ground draws the sea and the centre's city lights (sub-pixel towers shimmer).
    oceanView.root.visible = !GLOBE_VIEW.on;
    archView.enabled = terrainView.enabled = !GLOBE_VIEW.on || camera.position.y < 30000;
    airportView.update(camera, sim.atmosphere.windAt(_tmpWindPoint.set(renderPos.x, 10, renderPos.z), 0, _wind10));
    disasterView.update(sim.atmosphere.events);
    weatherView.update(dt, camera, velocity, sim.atmosphere, sim.groundWetness, sim.atmosphere.cloudAt(camera.position, 0).inCloud);

    renderOffset.copy(renderPos).sub(sim.position);
    debug.update(sim.debugForces, sim.craft, renderOffset);

    hud.update(telemetry, player.trim, telemetry.controls.brake > 0);
    hud.setAutopilot(autopilot.state.engaged ? autopilot.state : null);
    apPanel.refresh();
    mercPanel.refresh();
    // Notices from the war (credits earned, districts changing hands), and credits kept.
    for (const n of sim.notices) if (n.time > noticeAt) { noticeAt = n.time; toast(n.text); }
    if (sim.credits !== savedCredits) {
      savedCredits = sim.credits;
      const shown = document.getElementById('w-credits-v');
      if (shown) shown.textContent = sim.credits.toLocaleString();
      try {
        localStorage.setItem(CREDIT_STORAGE, String(sim.credits));
      } catch { /* not remembered */ }
    }
    const mercs = sim.airTraffic.mercs();
    {
      const inFlight = sim.weapons.projectiles.find((p) => p.kind === 'nuke' || p.kind === 'emp');
      const set = sim.charges[0];
      hud.setStrategic({ carried: sim.strategic, flight: inFlight ? inFlight.kind : null, emp: Math.max(0, sim.empUntil - sim.time), onFoot: sim.walker.active, set: set ? { kind: set.kind, left: set.setAt + set.fuse - sim.time } : null });
    }
    if (sim.hackCharges !== savedHacks) {
      savedHacks = sim.hackCharges;
      try { localStorage.setItem(HACK_STORAGE, String(sim.hackCharges)); } catch { /* not remembered */ }
    }
    if (sim.strategic !== savedStrategic) {
      savedStrategic = sim.strategic;
      try {
        localStorage.setItem(STRATEGIC_STORAGE, sim.strategic ?? '');
      } catch { /* not remembered */ }
    }
    {
      const t = sim.errands.target();
      const from = sim.walker.active ? sim.walker : sim.position;
      hud.setTask(t ? { kind: t.kind, range: Math.hypot(t.x - from.x, t.z - from.z), bearing: bearingOf(t.x - from.x, t.z - from.z), reward: t.reward } : null);
    }
    hud.setMercs(sim.credits > 0 || mercs.length ? { credits: sim.credits, hired: mercs.length, soonest: Math.min(...mercs.map((f) => f.mercUntil - sim.time)) } : null);
    fpsFrames++;
    fpsTime += dt;
    if (fpsTime > 0.5) {
      fps = fpsFrames / fpsTime;
      fpsFrames = 0;
      fpsTime = 0;
    }
    // `?nopresent` (automated tests): simulate and update everything but skip presenting to the
    // canvas. Headless browsers can't composite a WebGPU canvas; game.capture() still renders.
    if (presentToCanvas && renderThisFrame) renderActive();

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
