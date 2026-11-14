import type { Telemetry } from '../sim/telemetry.ts';
import { TUNING } from '../tuning.ts';
import { PROFILE_UI, type UiProfile } from './profiles.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const MS_TO_KT = 1.943844;

/** Plain-DOM HUD. Only touches the DOM when a displayed value actually changes. */
export class Hud {
  private readonly el = {
    speed: $('h-speed'),
    alt: $('h-alt'),
    vs: $('h-vs'),
    aoa: $('h-aoa'),
    g: $('h-g'),
    hdg: $('h-hdg'),
    thr: $('h-thr'),
    thrBar: $('h-thr-bar'),
    spoolBar: $('h-spool-bar'),
    trim: $('h-trim'),
    flaps: $('h-flaps'),
    flags: $('h-flags'),
    wind: $('h-wind'),
    windArrow: $('h-wind-arrow'),
    fuel: $('h-fuel'),
    orbRow: $('h-orb-row'),
    orb: $('h-orb'),
    orbT: $('h-orb-t'),
    fuelRow: $('h-fuel-row'),
    armRow: $('h-arm-row'),
    arm: $('h-arm'),
    hostileRow: $('h-hostile-row'),
    lockRow: $('h-lock-row'),
    mercRow: $('h-merc-row'),
    stratRow: $('h-strat-row'),
    taskRow: $('h-task-row'),
    task: $('h-task'),
    taskT: $('h-task-t'),
    strat: $('h-strat'),
    stratT: $('h-strat-t'),
    merc: $('h-merc'),
    mercT: $('h-merc-t'),
    lock: $('h-lock'),
    lockRange: $('h-lock-r'),
    turretRow: $('h-turret-row'),
    turret: $('h-turret'),
    turretMode: $('h-turret-m'),
    missile: $('missile-warn'),
    hostile: $('h-hostile'),
    hostileKills: $('h-hostile-k'),
    batt: $('h-batt'),
    battRow: $('h-batt-row'),
    volts: $('h-volts'),
    amps: $('h-amps'),
    busRow: $('h-bus-row'),
    oat: $('h-oat'),
    wx: $('h-wx'),
    stall: $('stall'),
    destroyed: $('destroyed'),
    help: $('help'),
    debug: $('debug'),
    stats: $('d-stats'),
    appr: $('h-appr'),
    apprSite: $('h-appr-site'),
    apprDist: $('h-appr-dist'),
    apprEta: $('h-appr-eta'),
    apprGs: $('h-appr-gs'),
    apprLoc: $('h-appr-loc'),
    apprSpd: $('h-appr-spd'),
    apprUnit: $('h-appr-unit'),
  };
  private readonly cache = new Map<HTMLElement, string>();
  private readonly root = $('hud');
  private readonly nav = $<HTMLButtonElement>('nav-chip');
  private profile: UiProfile | null = null;

  constructor() {
    // Each row is keyed by its value element (h-speed → speed; the bus row by its volts).
    for (const row of this.root.querySelectorAll<HTMLElement>('.row')) {
      const b = row.querySelector<HTMLElement>('b[id^="h-"]');
      if (!b) continue;
      const k = b.id.slice(2);
      row.dataset.k = k === 'volts' ? 'bus' : k;
    }
    // What sits under the HUD (the NAV chip, the radar in portrait) follows its real height.
    if (typeof ResizeObserver !== 'undefined') {
      const place = () => {
        if (this.root.classList.contains('open')) return;
        const r = this.root.getBoundingClientRect();
        if (r.height) document.body.style.setProperty('--hud-bottom', `${Math.round(r.bottom)}px`);
      };
      new ResizeObserver(place).observe(this.root);
      window.addEventListener('resize', place);
    }
    // Touch: the compact strip opens into the full readout (and closes again) with a tap.
    this.root.addEventListener('click', () => {
      if (document.body.classList.contains('touch-ui')) this.root.classList.toggle('open');
    });
  }

  /**
   * Show what matters for this vehicle (or for the Bit on foot): the primary readouts lead, in
   * order, and readouts that mean nothing for it are hidden.
   */
  setProfile(p: UiProfile): void {
    if (p === this.profile) return;
    this.profile = p;
    const ui = PROFILE_UI[p];
    this.root.dataset.profile = p;
    for (const row of this.root.querySelectorAll<HTMLElement>('.row[data-k]')) {
      const k = row.dataset.k!;
      const at = ui.primary.indexOf(k as never);
      row.classList.toggle('primary', at >= 0);
      row.style.order = at >= 0 ? String(at) : '';
      row.classList.toggle('na', ui.hide.includes(k));
    }
    const label = (k: string, text: string) => {
      const span = this.root.querySelector<HTMLElement>(`.row[data-k="${k}"] > span`);
      if (span) span.textContent = text;
    };
    label('speed', ui.speedLabel);
    label('thr', ui.lever ?? 'THR');
    this.root.classList.remove('open');
  }

  /**
   * The Navigator chip: always on screen in flight, so the computer that can take you anywhere
   * is one tap away. `mode` null = off.
   */
  setNav(s: { mode: string | null; detail: string; available: boolean }): void {
    if (!this.nav) return;
    const b = this.nav.querySelector('b') as HTMLElement | null;
    const small = this.nav.querySelector('small') as HTMLElement | null;
    this.nav.classList.toggle('on', s.mode !== null);
    this.nav.classList.toggle('unavailable', !s.available);
    if (b) this.set(b, s.mode ?? (s.available ? 'SET COURSE' : 'N/A'));
    if (small) this.set(small, s.detail);
  }

  private set(el: HTMLElement, text: string): void {
    if (this.cache.get(el) === text) return;
    this.cache.set(el, text);
    el.textContent = text;
  }

  update(t: Telemetry, trim: number, braking: boolean): void {
    const e = t.electrical ?? null;
    // Without power to the flight instruments, they go blank.
    const inst = !e || e.avionics;
    const blank = (s: string) => (inst ? s : '--');
    this.set(this.el.speed, blank((t.airspeed * MS_TO_KT).toFixed(0)));
    this.set(this.el.alt, blank(t.altitude.toFixed(0)));
    this.set(this.el.vs, blank((t.verticalSpeed >= 0 ? '+' : '') + t.verticalSpeed.toFixed(1)));
    this.set(this.el.aoa, blank(t.airspeed > 3 ? t.angleOfAttack.toFixed(1) : '--'));
    this.set(this.el.g, blank(t.gForce.toFixed(1)));
    this.set(this.el.hdg, blank(Math.round(t.heading % 360).toString().padStart(3, '0')));
    this.updateOrbit(t);
    this.el.battRow.style.display = e && e.battery !== null ? '' : 'none';
    this.el.busRow.style.display = e ? '' : 'none';
    if (e) {
      if (e.battery !== null) this.set(this.el.batt, (e.battery * 100).toFixed(0));
      this.set(this.el.volts, e.busVolts.toFixed(1));
      // Battery current: positive = discharging, negative = charging.
      this.set(this.el.amps, `V ${e.batteryAmps.toFixed(0)}A`);
    }
    this.set(this.el.thr, (t.throttle * 100).toFixed(0));
    this.el.thrBar.style.width = `${t.throttle * 100}%`;
    this.el.spoolBar.style.width = `${t.engineSpool * 100}%`;
    this.set(this.el.trim, (trim >= 0 ? '+' : '') + (trim * 100).toFixed(0));
    const flaps = t.controls.flaps ?? 0;
    this.set(this.el.flaps, flaps <= 0 ? 'UP' : `${Math.round(flaps * 30)}°`);
    // Wind: speed, and where it comes from relative to the nose (arrow points where it blows).
    const ws = Math.hypot(t.wind[0], t.wind[2]);
    this.set(this.el.wind, ws < 0.5 ? 'calm' : `${(ws * MS_TO_KT).toFixed(0)} kt`);
    if (ws >= 0.5) {
      const toward = (Math.atan2(t.wind[0], -t.wind[2]) * 180) / Math.PI; // compass dir it blows toward
      const rel = (((toward - t.heading) % 360) + 360) % 360;
      this.el.windArrow.style.display = 'inline-block';
      this.el.windArrow.style.transform = `rotate(${rel}deg)`;
      this.set(this.el.windArrow, '↑');
    } else this.set(this.el.windArrow, '');
    this.el.fuelRow.style.display = t.fuel === null ? 'none' : '';
    if (t.fuel !== null) this.set(this.el.fuel, (t.fuel * 100).toFixed(0));
    this.set(this.el.oat, `${t.oat.toFixed(0)}°C`);
    const w = t.weather;
    const wx = [
      w.precipitationKind !== 'none' ? `${w.precipitationKind === 'snow' ? 'SNOW' : 'RAIN'} ${w.precipitation.toFixed(0)}` : '',
      w.inCloud ? 'IMC' : '',
    ]
      .filter(Boolean)
      .join(' ');
    this.set(this.el.wx, wx || '—');
    const flags = [
      t.onGround ? 'ON GROUND' : '',
      braking ? 'BRAKES' : '',
      (t.controls.reverse ?? 0) > 0.05 ? 'REVERSE' : '',
      t.fuel === 0 ? 'OUT OF FUEL' : '',
      w.iceMm > 0.2 ? `ICE ${w.iceMm.toFixed(1)} mm` : '',
      t.vortexRing > 0.3 ? 'VORTEX RING' : '',
      w.aquaplaning > 0.3 ? 'AQUAPLANING' : '',
      t.brokenParts.length ? `BROKEN: ${t.brokenParts.join(', ')}` : '',
      t.position[1] > TUNING.systemBoundary - TUNING.systemBoundaryWarning
        ? `⚠ SYSTEM BOUNDARY ${Math.max(0, (TUNING.systemBoundary - t.position[1]) / 1000).toFixed(1)} km` : '',
      ...electricalFlags(e),
    ]
      .filter(Boolean)
      .join('  ');
    this.set(this.el.flags, flags);
    this.root.classList.toggle('grounded', t.onGround);
    this.el.stall.classList.toggle('hidden', !(t.stall > 0.35 && !t.onGround && t.airspeed > 5));
  }

  /** ARM row: the weapons loadout and rounds left (hidden when unarmed). */
  setWeapons(text: string | null): void {
    if (!this.el.armRow || !this.el.arm) return;
    this.el.armRow.style.display = text ? '' : 'none';
    if (text) this.set(this.el.arm, text);
  }

  /**
   * HOSTILE row: how many hostile aircraft are about, the nearest one's range and bearing, and
   * the kills so far (hidden when there are none near). It flashes while the craft is under fire.
   */
  setHostiles(s: { count: number; range: number; bearing: number; kills: number; underFire: boolean } | null): void {
    const { hostileRow: row, hostile, hostileKills } = this.el;
    if (!row || !hostile || !hostileKills) return;
    row.style.display = s ? '' : 'none';
    if (!s) return;
    row.classList.toggle('under-fire', s.underFire);
    const range = s.range >= 1000 ? `${(s.range / 1000).toFixed(1)}km` : `${Math.round(s.range / 10) * 10}m`;
    this.set(hostile, `${s.count} · ${range} ${String(Math.round(s.bearing) % 360).padStart(3, '0')}°`);
    this.set(hostileKills, s.underFire ? 'UNDER FIRE' : s.kills ? `${s.kills} down` : '');
  }

  /** STRAT row: the strategic weapon carried, or in flight; and the EMP's hold on the engines. */
  setStrategic(s: { carried: string | null; flight: string | null; emp: number; onFoot?: boolean; set?: { kind: string; left: number } | null }): void {
    const { stratRow: row, strat, stratT } = this.el;
    if (!row || !strat || !stratT) return;
    const show = !!(s.carried || s.flight || s.emp > 0 || s.set);
    row.style.display = show ? '' : 'none';
    document.body.classList.toggle('emp', s.emp > 0);
    row.classList.toggle('under-fire', !!s.set && s.set.left < 10);
    if (!show) return;
    if (s.set && !s.carried && s.emp <= 0) {
      const t = Math.max(0, s.set.left);
      this.set(strat, `${s.set.kind.toUpperCase()} SET`);
      this.set(stratT, `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`);
      return;
    }
    this.set(strat, s.emp > 0 ? 'EMP HIT' : s.carried ? s.carried.toUpperCase() : (s.flight ?? '').toUpperCase());
    this.set(stratT, s.emp > 0 ? `engines out ${s.emp.toFixed(0)} s` : s.carried ? (s.onFoot ? '` sets it down' : '` launches') : 'in flight');
  }

  /** TASK row: the errand under way, how far and which way it goes, and what it pays. */
  setTask(s: { kind: string; range: number; bearing: number; reward: number } | null): void {
    const { taskRow: row, task, taskT } = this.el;
    if (!row || !task || !taskT) return;
    row.style.display = s ? '' : 'none';
    if (!s) return;
    const range = s.range >= 1000 ? `${(s.range / 1000).toFixed(1)}km` : `${Math.round(s.range / 10) * 10}m`;
    this.set(task, `${s.kind.toUpperCase()} · ${range} ${String(Math.round(s.bearing) % 360).padStart(3, '0')}°`);
    this.set(taskT, `${s.reward} cr`);
  }

  /** CREDITS row: credits held, and hired mercenaries with the soonest contract end. */
  setMercs(s: { credits: number; hired: number; soonest: number } | null): void {
    const { mercRow: row, merc, mercT } = this.el;
    if (!row || !merc || !mercT) return;
    row.style.display = s ? '' : 'none';
    if (!s) return;
    this.set(merc, `${s.credits}`);
    const t = Math.max(0, s.soonest);
    this.set(mercT, s.hired ? `MERC ${s.hired} · ${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}` : 'cr');
  }

  /** LOCK row: the vehicle tracked or locked, and its range (hidden with none). */
  setLock(s: { name: string; range: number; locked: boolean; hack?: string | null } | null): void {
    const { lockRow: row, lock, lockRange } = this.el;
    if (!row || !lock || !lockRange) return;
    row.style.display = s ? '' : 'none';
    if (!s) return;
    row.classList.toggle('locked', s.locked);
    this.set(lock, `${s.locked ? '◆' : '◇'} ${s.name}${s.hack ? ` · ${s.hack}` : ''}`);
    row.classList.toggle('hacking', !!s.hack && s.hack.startsWith('HACK'));
    this.set(lockRange, s.range >= 1000 ? `${(s.range / 1000).toFixed(1)} km` : `${Math.round(s.range / 10) * 10} m`);
  }

  /** TURRET row: traverse (° right of the nose) and elevation, and whether it is laying itself on the lock. */
  setTurret(s: { yaw: number; pitch: number; auto: boolean } | null): void {
    const { turretRow: row, turret, turretMode } = this.el;
    if (!row || !turret || !turretMode) return;
    row.style.display = s ? '' : 'none';
    if (!s) return;
    const yaw = Math.round(s.yaw);
    this.set(turret, `${yaw === 0 ? '0' : yaw > 0 ? `R${yaw}` : `L${-yaw}`}° ${s.pitch >= 0 ? '+' : ''}${Math.round(s.pitch)}°`);
    this.set(turretMode, s.auto ? 'AUTO' : '');
  }

  /** The MISSILE warning: hostile missiles homing on the craft; RAIL: a railgun turret charging at it. */
  setMissileWarning(n: number, rail = 0): void {
    this.el.missile?.classList.toggle('hidden', n === 0 && rail === 0);
    if (!this.el.missile) return;
    const parts = [rail ? 'RAIL' : '', n ? (n > 1 ? `MISSILE ×${n}` : 'MISSILE') : ''].filter(Boolean);
    if (parts.length) this.set(this.el.missile, parts.join(' · '));
  }

  /** ORB row: apoapsis / periapsis (km) and period, once high or fast enough to care. */
  private updateOrbit(t: Telemetry): void {
    const { orbRow: row, orb, orbT: per } = this.el;
    if (!row || !orb || !per) return;
    const o = t.orbit;
    const show = !!o && (t.altitude > 2000 || o.speed > 150);
    row.style.display = show ? '' : 'none';
    if (!show || !o) return;
    // Ap/Pe in km (ESC = escape trajectory), then the period.
    this.set(orb, `${o.apoapsis === null ? 'ESC' : km(o.apoapsis)}/${km(o.periapsis)}`);
    this.set(per, o.period === null ? 'km' : `km ${clock(o.period)}`);
  }

  /** The craft blew up: show the banner (and hide the stall warning). */
  setDestroyed(on: boolean, respawnIn = 0, shotDown = false): void {
    this.el.destroyed.classList.toggle('hidden', !on);
    if (!on) return;
    const title = this.el.destroyed.querySelector('b');
    if (title) this.set(title as HTMLElement, shotDown ? 'SHOT DOWN' : 'DESTROYED');
    this.el.stall.classList.add('hidden');
    const small = this.el.destroyed.querySelector('small');
    if (small) this.set(small as HTMLElement, `New plane in ${Math.ceil(respawnIn)}… · Backspace resets the world`);
  }

  toggleHelp(): void {
    this.el.help.classList.toggle('hidden');
  }

  setDebugVisible(v: boolean): void {
    this.el.debug.classList.toggle('hidden', !v);
  }

  /** Autopilot readout: null = off. Shows the mode and phase, plus approach guidance while landing. */
  setAutopilot(s: {
    kind: 'airplane' | 'rotorcraft' | 'ground'; heading: number; altitude: number; commanded: number; speed: number;
    mode?: string; phase?: string; vs?: number | null;
    guidance?: { distance: number; glideslopeDev: number | null; localizerDev: number | null; targetSpeed: number; eta: number; siteName: string } | null;
  } | null): void {
    const ap = document.getElementById('h-ap');
    const tgt = document.getElementById('h-ap-t');
    const row = document.getElementById('h-ap-row');
    if (!ap || !tgt || !row) return;
    row.classList.toggle('ap-on', !!s);
    const g = s?.guidance ?? null;
    const landing = !!s && s.mode === 'land' && !!g;
    this.el.appr.classList.toggle('hidden', !landing);
    if (!s) {
      this.set(ap, 'OFF');
      this.set(tgt, '');
      return;
    }
    if (s.mode && s.mode !== 'hold') {
      this.set(ap, s.mode === 'goto' ? 'GO TO' : s.mode.toUpperCase());
      this.set(tgt, (s.phase ?? '').toUpperCase());
    } else {
      const climb = s.commanded > s.altitude + 1 ? ` ↑${s.commanded.toFixed(0)}` : '';
      const vert = s.vs !== null && s.vs !== undefined ? `${s.vs >= 0 ? '+' : ''}${s.vs.toFixed(1)}m/s` : `${s.altitude.toFixed(0)}m`;
      this.set(ap, `${Math.round(s.heading).toString().padStart(3, '0')}° ${vert}`);
      this.set(tgt, s.kind === 'airplane' ? `${(s.speed * MS_TO_KT).toFixed(0)}kt${climb}` : `${s.speed.toFixed(0)}m/s${climb}`);
    }
    if (!landing || !g) return;
    const e = this.el;
    this.set(e.apprSite, `${g.siteName} · ${(s.phase ?? '').toUpperCase()}`);
    this.set(e.apprDist, g.distance >= 1000 ? `${(g.distance / 1000).toFixed(1)}km` : `${g.distance.toFixed(0)}m`);
    this.set(e.apprEta, g.eta > 0 && g.eta < 36000 ? `${Math.floor(g.eta / 60)}:${Math.round(g.eta % 60).toString().padStart(2, '0')}` : '');
    this.set(e.apprGs, g.glideslopeDev === null ? '--' : `${g.glideslopeDev > 0 ? '▲' : '▼'}${Math.abs(g.glideslopeDev).toFixed(0)}`);
    this.set(e.apprLoc, g.localizerDev === null ? '--' : `${g.localizerDev > 0 ? '▶' : '◀'}${Math.abs(g.localizerDev).toFixed(0)}`);
    const air = s.kind === 'airplane';
    this.set(e.apprSpd, g.targetSpeed > 0 ? (air ? (g.targetSpeed * MS_TO_KT).toFixed(0) : g.targetSpeed.toFixed(0)) : '--');
    this.set(e.apprUnit, air ? 'kt' : 'm/s');
    e.apprGs.classList.toggle('appr-warn', g.glideslopeDev !== null && Math.abs(g.glideslopeDev) > 15);
    e.apprLoc.classList.toggle('appr-warn', g.localizerDev !== null && Math.abs(g.localizerDev) > 30);
  }

  setStats(text: string): void {
    this.set(this.el.stats, text);
  }
}

/** Warnings for the electrical system: dead bus, failed instruments, battery and generator. */
function electricalFlags(e: Telemetry['electrical']): string[] {
  if (!e) return [];
  return [
    !e.powered ? 'ELEC FAIL' : !e.avionics ? 'INSTRUMENTS FAIL' : '',
    e.batteryCutoff === 'overheat' ? 'BATT OVERHEAT' : e.batteryCutoff ? 'BATT CUTOFF' : '',
    !e.batteryCutoff && e.batteryTempC !== null && e.batteryTempC > 55 ? 'BATT HOT' : '',
    e.battery !== null && e.battery < 0.2 && !e.batteryCutoff ? 'LOW BATT' : '',
    e.failed.length ? `AVIONICS FAILED: ${e.failed.join(', ')}` : '',
  ];
}

/** Altitude in km with one decimal (sub-surface periapsis shows negative). */
function km(m: number): string {
  return (m / 1000).toFixed(1);
}

/** Period as m:ss (h:mm:ss past an hour). */
function clock(s: number): string {
  const t = Math.round(s);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const ss = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
