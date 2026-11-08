import type { Telemetry } from '../sim/telemetry.ts';

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
    fuelRow: $('h-fuel-row'),
    batt: $('h-batt'),
    battRow: $('h-batt-row'),
    volts: $('h-volts'),
    amps: $('h-amps'),
    busRow: $('h-bus-row'),
    oat: $('h-oat'),
    wx: $('h-wx'),
    stall: $('stall'),
    help: $('help'),
    debug: $('debug'),
    stats: $('d-stats'),
  };
  private readonly cache = new Map<HTMLElement, string>();

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
      t.fuel === 0 ? 'OUT OF FUEL' : '',
      w.iceMm > 0.2 ? `ICE ${w.iceMm.toFixed(1)} mm` : '',
      t.vortexRing > 0.3 ? 'VORTEX RING' : '',
      w.aquaplaning > 0.3 ? 'AQUAPLANING' : '',
      t.brokenParts.length ? `BROKEN: ${t.brokenParts.join(', ')}` : '',
      ...electricalFlags(e),
    ]
      .filter(Boolean)
      .join('  ');
    this.set(this.el.flags, flags);
    this.el.stall.classList.toggle('hidden', !(t.stall > 0.35 && !t.onGround && t.airspeed > 5));
  }

  toggleHelp(): void {
    this.el.help.classList.toggle('hidden');
  }

  setDebugVisible(v: boolean): void {
    this.el.debug.classList.toggle('hidden', !v);
  }

  /** Autopilot readout: null = off. */
  setAutopilot(s: { kind: 'airplane' | 'rotorcraft'; heading: number; altitude: number; commanded: number; speed: number } | null): void {
    const ap = document.getElementById('h-ap');
    const tgt = document.getElementById('h-ap-t');
    const row = document.getElementById('h-ap-row');
    if (!ap || !tgt || !row) return;
    row.classList.toggle('ap-on', !!s);
    if (!s) {
      this.set(ap, 'OFF');
      this.set(tgt, '');
      return;
    }
    const climb = s.commanded > s.altitude + 1 ? ` ↑${s.commanded.toFixed(0)}` : '';
    this.set(ap, `${Math.round(s.heading).toString().padStart(3, '0')}° ${s.altitude.toFixed(0)}m`);
    this.set(tgt, s.kind === 'airplane' ? `${(s.speed * MS_TO_KT).toFixed(0)}kt${climb}` : `${s.speed.toFixed(0)}m/s${climb}`);
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
