import {
  AIRPLANE_MODES,
  MODE_LABELS,
  ROTORCRAFT_MODES,
  type AutopilotKind,
  type AutopilotMode,
  type AutopilotOptions,
  type AutopilotState,
  type FlightAutopilot,
} from '../sim/flightAutopilot.ts';
import { destinations, type Destination } from '../sim/nav.ts';
import type { Telemetry } from '../sim/telemetry.ts';

const MS_TO_KT = 1.943844;

export interface AutopilotPanelHooks {
  autopilot: FlightAutopilot;
  /** The current craft's autopilot kind, or null if it has none (blimp, ground vehicle). */
  kind(): AutopilotKind | null;
  telemetry(): Telemetry;
  /** Engage (or switch) with these options. */
  engage(opts: AutopilotOptions): void;
  disengage(): void;
}

type Field = 'heading' | 'altitude' | 'speed' | 'vs' | 'destination' | 'orbit';
const FIELDS: Record<AutopilotMode, Field[]> = {
  hold: ['heading', 'altitude', 'speed', 'vs'],
  takeoff: ['heading', 'altitude', 'speed'],
  land: ['destination'],
  goto: ['destination', 'altitude', 'speed', 'orbit'],
  orbit: ['destination', 'orbit', 'altitude', 'speed'],
  level: [],
};
const HINTS: Record<AutopilotMode, string> = {
  hold: 'Holds heading, altitude (or a vertical speed) and speed; takes off from a runway. Stick and throttle turn the knobs.',
  takeoff: 'Take-off roll and climb to the selected altitude, then Hold.',
  land: 'Airplanes: join, 3° glideslope, flare, brakes to a stop on a runway long enough. Rotorcraft: any helipad, rooftops too.',
  goto: 'Direct to a destination, climbing over buildings and terrain; airplanes then orbit it.',
  orbit: 'Right-hand circle around the destination (or starting from here).',
  level: 'Wings level, vertical speed 0. You keep the throttle.',
};

const fmtTime = (s: number) => (Number.isFinite(s) && s < 36000 ? `${Math.floor(s / 60)}:${Math.round(s % 60).toString().padStart(2, '0')}` : '--');
const fmtDist = (m: number) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

/**
 * The flight computer panel (J, or touch More → "Flight computer"): pick a mode, set its
 * fields, engage. Live status and approach guidance refresh at about 5 Hz.
 */
export class AutopilotPanel {
  readonly root: HTMLElement;
  private mode: AutopilotMode = 'hold';
  private kind: AutopilotKind = 'airplane';
  private readonly modeBar: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly inputs: Record<Field, HTMLInputElement | HTMLSelectElement>;
  private readonly rows: Record<Field, HTMLElement>;
  private readonly speedUnit: HTMLElement;
  private readonly engageBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly guidance: HTMLElement;
  private lastRefresh = 0;
  private destKey = '';

  constructor(private readonly hooks: AutopilotPanelHooks) {
    const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    this.root = el('div', 'panel hidden');
    this.root.id = 'ap-panel';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-label', 'Flight computer');
    const close = el('button', 'panel-close', 'Close ✕');
    close.type = 'button';
    close.addEventListener('click', () => this.hide());
    this.modeBar = el('div', 'ap-modes');
    this.hint = el('p', 'muted small');
    const num = (min: number, max: number, step: number) => {
      const i = el('input');
      i.type = 'number';
      i.min = String(min);
      i.max = String(max);
      i.step = String(step);
      i.inputMode = 'decimal';
      return i;
    };
    const dest = el('select');
    const vs = num(-30, 30, 0.5);
    vs.placeholder = 'off';
    this.inputs = { heading: num(0, 359, 1), altitude: num(5, 6000, 10), speed: num(0, 500, 1), vs, destination: dest, orbit: num(150, 5000, 50) };
    this.speedUnit = el('small', '', 'kt');
    const row = (label: string, f: Field, unit: string | HTMLElement = '') => {
      const l = el('label', 'ap-field');
      l.append(el('span', '', label), this.inputs[f]);
      if (unit) l.append(typeof unit === 'string' ? el('small', '', unit) : unit);
      return l;
    };
    this.rows = {
      heading: row('Heading', 'heading', '°'),
      altitude: row('Altitude', 'altitude', 'm'),
      speed: row('Speed', 'speed', this.speedUnit),
      vs: row('V/S hold', 'vs', 'm/s'),
      destination: row('Destination', 'destination'),
      orbit: row('Orbit radius', 'orbit', 'm'),
    };
    const fields = el('div', 'ap-fields');
    fields.append(...Object.values(this.rows));
    this.engageBtn = el('button', 'ap-engage', 'Engage');
    this.engageBtn.type = 'button';
    this.engageBtn.addEventListener('click', () => this.engage());
    const off = el('button', '', 'Disengage');
    off.type = 'button';
    off.addEventListener('click', () => {
      hooks.disengage();
      this.refresh(true);
    });
    const buttons = el('div', 'ap-buttons');
    buttons.append(this.engageBtn, off);
    this.status = el('div', 'ap-status');
    this.status.setAttribute('aria-live', 'polite');
    this.guidance = el('div', 'ap-guidance');
    this.root.append(close, el('h3', '', 'Flight computer'), this.modeBar, this.hint, fields, buttons, this.status, this.guidance);
    // Enter in a field engages.
    this.root.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.engage();
      if (e.key === 'Escape') this.hide();
    });
    document.body.append(this.root);
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  toggle(): void {
    if (this.visible) this.hide();
    else this.show();
  }

  show(): void {
    const kind = this.hooks.kind();
    this.kind = kind ?? 'airplane';
    const st = this.hooks.autopilot.state;
    const modes = this.kind === 'airplane' ? AIRPLANE_MODES : ROTORCRAFT_MODES;
    this.mode = st.engaged && modes.includes(st.mode) ? st.mode : this.mode;
    if (!modes.includes(this.mode)) this.mode = 'hold';
    this.prefill(st);
    this.root.classList.remove('hidden');
    this.renderModes();
    this.refresh(true);
  }

  hide(): void {
    this.root.classList.add('hidden');
    (document.activeElement as HTMLElement | null)?.blur?.();
  }

  /** Fill the fields from the engaged computer, else from the current flight state. */
  private prefill(st: AutopilotState): void {
    const t = this.hooks.telemetry();
    const air = this.kind === 'airplane';
    const grounded = t.onGround || t.altitude < 5;
    const hdg = st.engaged ? st.heading : t.heading;
    const alt = st.engaged ? st.altitude : grounded ? (air ? 300 : 30) : Math.max(air ? 60 : 10, Math.round(t.altitude / 10) * 10);
    const spd = st.engaged ? st.speed : air ? Math.max(40, t.airspeed) : 15;
    this.inputs.heading.value = String(Math.round(hdg) % 360);
    this.inputs.altitude.value = String(Math.round(alt));
    this.inputs.speed.value = String(Math.round(air ? spd * MS_TO_KT : spd));
    this.inputs.vs.value = st.engaged && st.vs !== null ? String(st.vs) : '';
    this.inputs.orbit.value = String(st.orbitRadius);
    this.speedUnit.textContent = air ? 'kt' : 'm/s';
    this.fillDestinations(st.destination);
  }

  private fillDestinations(selected: string | null): void {
    const sel = this.inputs.destination as HTMLSelectElement;
    const key = `${this.kind}:${this.mode}`;
    const prev = selected ?? sel.value;
    if (key !== this.destKey) {
      this.destKey = key;
      const all = destinations();
      const groups: Array<[string, Destination[]]> = [];
      const land = this.mode === 'land';
      const runways = all.filter((d) => d.kind === 'runway');
      const pads = all.filter((d) => d.kind === 'helipad');
      const other = all.filter((d) => d.kind === 'hub' || d.kind === 'landmark');
      if (land) groups.push(this.kind === 'airplane' ? ['Runways', runways] : ['Helipads', pads]);
      else groups.push(['Landmarks & hubs', other], ['Runways', runways], ['Helipads', pads]);
      const first = document.createElement('option');
      first.value = '';
      first.textContent = land ? (this.kind === 'airplane' ? 'Nearest suitable runway' : 'Nearest helipad') : this.mode === 'orbit' ? 'Here (circle from current position)' : 'Choose…';
      sel.replaceChildren(first);
      for (const [label, list] of groups) {
        const g = document.createElement('optgroup');
        g.label = label;
        for (const d of list) {
          const o = document.createElement('option');
          o.value = d.id;
          o.textContent = d.y > 0 ? `${d.name} (roof ${Math.round(d.y)} m)` : d.kind === 'runway' && d.site ? `${d.name} (${d.site.length} m)` : d.name;
          g.append(o);
        }
        sel.append(g);
      }
    }
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : '';
  }

  private renderModes(): void {
    const modes = this.kind === 'airplane' ? AIRPLANE_MODES : ROTORCRAFT_MODES;
    this.modeBar.replaceChildren(
      ...modes.map((m) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = MODE_LABELS[m];
        b.className = m === this.mode ? 'active' : '';
        b.setAttribute('aria-pressed', String(m === this.mode));
        b.addEventListener('click', () => {
          this.mode = m;
          this.renderModes();
        });
        return b;
      }),
    );
    const show = new Set(FIELDS[this.mode].filter((f) => this.kind === 'airplane' || (f !== 'vs' && f !== 'orbit')));
    for (const f of Object.keys(this.rows) as Field[]) this.rows[f].classList.toggle('hidden', !show.has(f));
    this.hint.textContent = HINTS[this.mode];
    this.fillDestinations(null);
  }

  private engage(): void {
    if (!this.hooks.kind()) return;
    const air = this.kind === 'airplane';
    const n = (f: Field) => {
      const v = this.inputs[f].value.trim();
      const x = Number(v);
      return v === '' || !Number.isFinite(x) ? undefined : x;
    };
    const show = FIELDS[this.mode];
    const opts: AutopilotOptions = { mode: this.mode };
    if (show.includes('heading')) opts.heading = n('heading');
    if (show.includes('altitude')) opts.altitude = n('altitude');
    if (show.includes('speed')) {
      const s = n('speed');
      if (s !== undefined) opts.speed = air ? s / MS_TO_KT : s;
    }
    if (show.includes('vs') && air) opts.vs = n('vs') ?? null;
    if (show.includes('orbit') && air) opts.orbitRadius = n('orbit');
    if (show.includes('destination')) opts.destination = this.inputs.destination.value || null;
    if (this.mode === 'goto' && !opts.destination) {
      this.status.textContent = 'Choose a destination first.';
      return;
    }
    this.hooks.engage(opts);
    this.refresh(true);
  }

  /** Live status: call every frame; it redraws about 5 times a second. */
  refresh(force = false): void {
    if (!this.visible) return;
    const now = performance.now();
    if (!force && now - this.lastRefresh < 200) return;
    this.lastRefresh = now;
    const st = this.hooks.autopilot.state;
    if (!this.hooks.kind()) {
      this.status.textContent = 'This craft has no autopilot.';
      this.guidance.replaceChildren();
      this.engageBtn.disabled = true;
      return;
    }
    this.engageBtn.disabled = false;
    this.engageBtn.textContent = st.engaged ? `Switch to ${MODE_LABELS[this.mode]}` : 'Engage';
    this.status.textContent = st.engaged ? `${MODE_LABELS[st.mode]} · ${st.phase.toUpperCase()} — ${st.status}` : st.status && st.status !== 'Off' ? `Off — ${st.status}` : 'Off';
    this.status.classList.toggle('on', st.engaged);
    const g = st.engaged ? st.guidance : null;
    if (!g) {
      this.guidance.replaceChildren();
      return;
    }
    const cells: Array<[string, string]> = [['Site', g.siteName], ['Distance', fmtDist(g.distance)], ['ETA', fmtTime(g.eta)]];
    if (g.glideslopeDev !== null) cells.push(['Glideslope', `${g.glideslopeDev > 0 ? '▲' : '▼'} ${Math.abs(g.glideslopeDev).toFixed(0)} m ${g.glideslopeDev > 0 ? 'high' : 'low'}`]);
    if (g.localizerDev !== null) cells.push(['Localizer', `${g.localizerDev > 0 ? '▶' : '◀'} ${Math.abs(g.localizerDev).toFixed(0)} m ${g.localizerDev > 0 ? 'right' : 'left'}`]);
    if (g.targetSpeed > 0) cells.push(['Target speed', st.kind === 'airplane' ? `${(g.targetSpeed * MS_TO_KT).toFixed(0)} kt` : `${g.targetSpeed.toFixed(0)} m/s`]);
    const table = document.createElement('table');
    for (const [k, v] of cells) {
      const tr = table.insertRow();
      tr.insertCell().textContent = k;
      tr.insertCell().textContent = v;
    }
    this.guidance.replaceChildren(table);
  }
}
