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
    flags: $('h-flags'),
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
    this.set(this.el.speed, (t.airspeed * MS_TO_KT).toFixed(0));
    this.set(this.el.alt, t.altitude.toFixed(0));
    this.set(this.el.vs, (t.verticalSpeed >= 0 ? '+' : '') + t.verticalSpeed.toFixed(1));
    this.set(this.el.aoa, t.airspeed > 3 ? t.angleOfAttack.toFixed(1) : '--');
    this.set(this.el.g, t.gForce.toFixed(1));
    this.set(this.el.hdg, Math.round(t.heading % 360).toString().padStart(3, '0'));
    this.set(this.el.thr, (t.throttle * 100).toFixed(0));
    this.el.thrBar.style.width = `${t.throttle * 100}%`;
    this.el.spoolBar.style.width = `${t.engineSpool * 100}%`;
    this.set(this.el.trim, (trim >= 0 ? '+' : '') + (trim * 100).toFixed(0));
    const flags = [t.onGround ? 'ON GROUND' : '', braking ? 'BRAKES' : ''].filter(Boolean).join('  ');
    this.set(this.el.flags, flags);
    this.el.stall.classList.toggle('hidden', !(t.stall > 0.35 && !t.onGround && t.airspeed > 5));
  }

  toggleHelp(): void {
    this.el.help.classList.toggle('hidden');
  }

  setDebugVisible(v: boolean): void {
    this.el.debug.classList.toggle('hidden', !v);
  }

  setStats(text: string): void {
    this.set(this.el.stats, text);
  }
}
