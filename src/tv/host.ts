import { BUILTINS } from '../craft/builtins.ts';
import { RemoteDevice } from '../input/RemoteDevice.ts';
import { PlayerInput } from '../input/PlayerInput.ts';
import type { Action, InputDevice } from '../input/types.ts';
import { PROFILE_UI, uiProfile } from '../hud/profiles.ts';
import type { ControlSource } from '../sim/controls.ts';
import { FlightAutopilot } from '../sim/flightAutopilot.ts';
import { analyzeDesign } from '../sim/flightTest.ts';
import { wallSegmentsNear } from '../sim/lightWalls.ts';
import type { Simulation } from '../sim/Simulation.ts';
import type { Telemetry } from '../sim/telemetry.ts';
import { vehicleKind } from '../sim/vehicleTests.ts';
import { LOADOUTS } from '../sim/weapons.ts';
import { TUNING } from '../tuning.ts';
import { FrameBuilder, type TvFrame } from './frame.ts';
import { VIEW_ACTIONS, type TvContextMsg } from './protocol.ts';

export interface HostOptions {
  /** Built-in craft id to start in (src/craft/builtins.ts). */
  craft?: string;
  /** Fewer aircraft and no turrets: for a slow receiver. */
  lite?: boolean;
}

/**
 * The game as the TV plays it: one Simulation, the player's controls (the phone's pad through a
 * RemoteDevice, plus any local devices), the Navigator's hold, and the handful of actions a
 * gamepad has. DOM-free, so it runs in a worker on the TV (src/tv/host.worker.ts) or on the
 * phone when the phone runs the game. `frame()` is what the screen draws.
 */
export class TvHost {
  readonly remote: RemoteDevice;
  readonly player: PlayerInput;
  readonly autopilot: FlightAutopilot;
  private readonly frames = new FrameBuilder();
  private telemetry: Telemetry;
  private acc = 0;
  private craftIndex: number;
  private notes: string[] = [];
  private ui: string[] = [];
  private noticeAt = -Infinity;
  private blastSeen = -Infinity;
  private wasExploded = false;
  private failuresSeen = 0;
  private hitsSeen = 0;
  private apPerf = { stallSpeed: 30 };
  private apPerfVersion = -1;
  /** Called with every toast (the TV shows them; the phone can too). */
  onToast: ((text: string) => void) | null = null;

  constructor(readonly sim: Simulation, devices: InputDevice[] = [], opts: HostOptions = {}, clock?: () => number) {
    this.remote = new RemoteDevice(clock);
    this.player = new PlayerInput([this.remote, ...devices]);
    this.autopilot = new FlightAutopilot(this.player);
    this.autopilot.driver.walls = (x, z, r) => wallSegmentsNear(sim, x, z, r);
    this.autopilot.driver.closed = sim.roadDamage.closed;
    this.autopilot.onDisengage = (thr) => { this.player.throttle = thr; };
    this.autopilot.fractured = sim.staticWorld.fractured;
    sim.airTraffic.pool = BUILTINS.map((b) => b.craft);
    sim.airTraffic.count = opts.lite ? 3 : 8;
    sim.airTraffic.friendlies = opts.lite ? 1 : 2;
    sim.airTraffic.enemies = opts.lite ? 1 : 3;
    sim.airTraffic.freelancers = opts.lite ? 0 : 1;
    sim.groundTurrets.density = opts.lite ? 0 : 1;
    const start = BUILTINS.findIndex((b) => b.id === opts.craft);
    this.craftIndex = Math.max(0, start);
    if (start > 0) sim.loadCraft(BUILTINS[start].craft);
    this.player.profile = vehicleKind(sim);
    this.telemetry = sim.telemetry();
  }

  toast(text: string): void {
    this.notes.push(text);
    this.onToast?.(text);
  }

  /** The TV changed (a new receiver joined): resend the craft and chunk list with the next frame. */
  resync(): void {
    this.frames.resync();
  }

  private perf() {
    if (this.apPerfVersion !== this.sim.version) {
      this.apPerf = { stallSpeed: analyzeDesign(this.sim).stallSpeed };
      this.apPerfVersion = this.sim.version;
    }
    return this.apPerf;
  }

  private selectCraft(i: number): void {
    const n = BUILTINS.length;
    this.craftIndex = ((i % n) + n) % n;
    const b = BUILTINS[this.craftIndex];
    this.autopilot.disengage();
    this.sim.loadCraft(b.craft);
    this.player.profile = vehicleKind(this.sim);
    this.player.reset();
    this.toast(b.label);
  }

  private act(a: Action): void {
    const sim = this.sim;
    if (VIEW_ACTIONS.has(a)) { this.ui.push(a); return; }
    switch (a) {
      case 'reset':
        this.autopilot.disengage();
        sim.respawn();
        this.player.reset();
        this.toast('New vehicle: the world stays as it is');
        break;
      case 'resetWorld':
        this.autopilot.disengage();
        sim.resetToRunway();
        this.player.reset();
        this.toast('World reset');
        break;
      case 'nextVehicle': this.selectCraft(this.craftIndex + 1); break;
      case 'prevVehicle': this.selectCraft(this.craftIndex - 1); break;
      case 'trimReset': this.player.trim = 0; break;
      case 'recentre': if (sim.craft.turretRig) { sim.recentreTurret(); this.toast('Turret: back to the nose'); } break;
      case 'trail': {
        const m = sim.trails.cycleMode(sim.craft, sim.isAirplane(), sim.time);
        this.toast(m === 'wall' ? 'Jetwall: solid light' : m === 'ribbon' ? 'Light ribbon: fades behind you' : 'Trail off');
        break;
      }
      case 'loadout': {
        const l = sim.weapons.cycle();
        this.toast(l === 'none' ? 'Weapons: unarmed' : `Weapons: ${LOADOUTS[l].label}`);
        break;
      }
      case 'foot': {
        const why = sim.walker.active ? sim.boardVehicle() : sim.exitVehicle();
        if (why) this.toast(why);
        else if (sim.walker.active) { this.autopilot.disengage(); this.toast('On foot · FIRE says YES, DROP says NO · BOARD gets back in'); }
        else { this.player.reset(); this.toast('Aboard'); }
        break;
      }
      case 'strategic':
        if (sim.walker.active) { const why = sim.placeStrategic(); if (why) this.toast(why); }
        else this.toast(sim.launchStrategic() ?? 'Launched');
        break;
      case 'autopilot': {
        if (sim.walker.active) { this.toast('The Navigator walks you from the full game'); break; }
        if (this.autopilot.state.engaged) { this.autopilot.disengage(); this.toast('Navigator off'); break; }
        const kind = vehicleKind(sim);
        if (kind === 'ground') { this.toast('Navigator: destinations are set in the full game'); break; }
        if (kind === 'lighter-than-air') { this.toast('The Navigator cannot fly blimps yet'); break; }
        this.autopilot.engage(this.telemetry, kind, this.perf());
        const st = this.autopilot.state;
        this.toast(`Navigator: hold · HDG ${Math.round(st.heading).toString().padStart(3, '0')} · ${st.altitude.toFixed(0)} m`);
        break;
      }
      default:
        break;
    }
  }

  /** Advance the game by `dt` real seconds. */
  tick(dt: number): void {
    const sim = this.sim;
    this.player.onFoot = sim.walker.active;
    for (const a of this.player.poll()) this.act(a);
    const trig = this.player.firing();
    const onFoot = sim.walker.active;
    sim.weapons.trigger.primary = trig.primary && !onFoot;
    sim.weapons.trigger.secondary = trig.secondary && !onFoot;
    sim.hackHeld = trig.hack && !onFoot;
    if (onFoot && (trig.primary || trig.secondary)) {
      const word = sim.speak(trig.primary ? 'yes' : 'no');
      if (word) this.toast(word);
    }
    const aim = this.player.aim();
    sim.turretInput.yaw = aim.yaw;
    sim.turretInput.pitch = aim.pitch;
    const pilot: ControlSource = this.autopilot;
    this.acc += Math.min(0.25, Math.max(0, dt));
    let steps = 0;
    while (this.acc >= sim.dt && steps < TUNING.maxStepsPerFrame) {
      const inputs = pilot.sample(sim.dt, this.telemetry);
      if (sim.walker.active) sim.walkInput = this.player.walk();
      sim.step(inputs);
      this.acc -= sim.dt;
      steps++;
    }
    if (steps === TUNING.maxStepsPerFrame) this.acc = 0; // drop time rather than spiral
    this.telemetry = sim.telemetry();
    this.events();
  }

  /** Toasts and rumble from what happened this tick. */
  private events(): void {
    const sim = this.sim;
    for (const n of sim.notices) if (n.time > this.noticeAt) { this.noticeAt = n.time; this.toast(n.text); }
    for (const b of sim.blasts) {
      if (b.time <= this.blastSeen) continue;
      this.blastSeen = b.time;
      this.player.rumble(1, b.kind === 'nuke' ? 2000 : 600);
    }
    if (sim.exploded && !this.wasExploded) this.player.rumble(1, 900);
    this.wasExploded = sim.exploded;
    if (sim.failures.length > this.failuresSeen) this.player.rumble(1, 400);
    this.failuresSeen = sim.failures.length;
    if (sim.hitsTaken > this.hitsSeen) this.player.rumble(0.6, 150);
    this.hitsSeen = sim.hitsTaken;
  }

  /** How far between the last two physics steps the present moment is (0..1). */
  get alpha(): number {
    return this.acc / this.sim.dt;
  }

  private navLine(): string | null {
    const st = this.autopilot.state;
    return st.engaged ? `NAV · ${st.status}` : null;
  }

  frame(bitLight = '#3d7cff'): TvFrame {
    const f = this.frames.build(this.sim, this.telemetry, { alpha: this.alpha, nav: this.navLine(), notes: this.notes, ui: this.ui, bitLight });
    f.hud.profile = uiProfile(this.player.profile, this.sim.walker.active);
    if (f.hud.profile === 'ground' || f.hud.profile === 'foot') f.hud.spdLabel = 'SPEED';
    else if (f.hud.profile !== 'airplane') f.hud.spdLabel = PROFILE_UI[f.hud.profile].speedLabel;
    this.notes = [];
    this.ui = [];
    return f;
  }

  /** What the phone's pad should show now. */
  context(): TvContextMsg {
    const t = this.telemetry;
    const profile = uiProfile(this.player.profile, this.sim.walker.active);
    const ui = PROFILE_UI[profile];
    const lines: string[] = [];
    if (profile !== 'foot') {
      lines.push(`${ui.speedLabel} ${Math.round((t.onGround ? t.groundSpeed : t.airspeed) * 1.944)} kt`);
      if (profile !== 'ground') lines.push(`ALT ${Math.round(t.altitude)} m`);
      lines.push(`HDG ${Math.round(t.heading).toString().padStart(3, '0')}`);
    }
    if (this.autopilot.state.engaged) lines.push(`NAV ${this.autopilot.state.status}`.slice(0, 40));
    return {
      t: 'ctx',
      profile: this.player.profile,
      foot: this.sim.walker.active,
      thr: Math.round(this.player.throttle * 100) / 100,
      armed: Object.keys(this.sim.weapons.ammo()).length > 0,
      craft: this.sim.craft.def.name,
      nav: this.navLine(),
      lines,
    };
  }
}
