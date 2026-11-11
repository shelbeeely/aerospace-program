import { turretSites } from '../sim/groundTurrets.ts';
import type { Simulation } from '../sim/Simulation.ts';
import { STRIKES, type StrikeKind } from '../sim/strikes.ts';
import { hostile, TEAMS } from '../sim/teams.ts';
import { wrapDelta } from '../sim/contacts.ts';
import { chunkAt } from '../world/planetCity.ts';
import type { GlobeView } from '../render/GlobeView.ts';
import { knots } from '../sim/adsb.ts';

/**
 * The strike panel beside the strike globe: for the spot picked on the globe, the district, who
 * holds it, the enemy turrets standing there, how far it is and how long each strike would take,
 * with buttons to send the team's aircraft (or recall them) and to call in a strike for credits.
 * Below, the strikes in flight.
 */
export class StrikePanel {
  private readonly credits: HTMLElement;
  private readonly target: HTMLElement;
  private readonly buttons: HTMLElement;
  private readonly live: HTMLElement;
  private readonly status: HTMLElement;
  private readonly card: HTMLElement;
  private readonly modeBtn: HTMLButtonElement;
  private shown = '';
  private timer = 0;

  constructor(
    private readonly sim: Simulation,
    private readonly globe: GlobeView,
    private readonly toast: (text: string) => void,
  ) {
    const el = (tag: string, cls = '', text = '') => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text) e.textContent = text;
      return e;
    };
    const head = el('div', 'globe-head');
    const title = el('b', '', 'STRIKE GLOBE');
    const close = el('button', 'panel-close', 'Close ✕');
    close.addEventListener('click', () => globe.toggle(false));
    // Basic (markers) or detailed (real models, full buildings up close); remembered.
    this.modeBtn = el('button', 'globe-mode') as HTMLButtonElement;
    this.modeBtn.type = 'button';
    this.modeBtn.title = 'Basic: markers and plain buildings (light on the GPU). Detailed: the real aircraft models and full architecture up close.';
    this.modeBtn.addEventListener('click', () => globe.setMode(globe.mode === 'detailed' ? 'basic' : 'detailed'));
    globe.onMode = () => this.label();
    head.append(title, this.modeBtn, close);
    this.credits = el('div', 'merc-credits');
    // The selected vehicle's ADS-B card.
    this.card = el('div', 'globe-card hidden');
    this.target = el('div', 'globe-target');
    this.buttons = el('div', 'globe-buttons');
    const liveTitle = el('h3', '', 'IN FLIGHT');
    this.live = el('div', 'globe-live small');
    this.status = el('p', 'merc-status small');
    const note = el('p', 'muted small', 'Strikes set out from the nearest district your team holds. Turrets on the way and at the target can shoot them down; kills and captures pay you.');
    globe.side.append(head, this.card, this.credits, this.target, this.buttons, this.status, liveTitle, this.live, note);
    globe.onPick = () => { this.shown = ''; this.status.textContent = ''; this.refresh(); };
    globe.onSelect = () => this.refresh();
    this.label();
  }

  /** Refresh about four times a second while the globe is open. */
  update(dt: number): void {
    if (!this.globe.visible) return;
    this.timer -= dt;
    if (this.timer > 0) return;
    this.timer = 0.25;
    this.refresh();
  }

  private act(f: () => string | null): void {
    const why = f();
    this.status.textContent = why ?? '';
    if (why) this.toast(why);
    this.shown = '';
    this.refresh();
  }

  private label(): void {
    this.modeBtn.textContent = this.globe.mode === 'detailed' ? 'Detailed' : 'Basic';
    this.modeBtn.classList.toggle('on', this.globe.mode === 'detailed');
  }

  /** The selected vehicle's ADS-B card (live). */
  private drawCard(): void {
    const id = this.globe.selected;
    const r = id ? this.sim.adsbRecords().find((x) => x.id === id) : undefined;
    this.card.classList.toggle('hidden', !r);
    if (!r) { this.card.replaceChildren(); return; }
    const row = (k: string, v: string, cls = '') => {
      const d = document.createElement('div');
      d.className = `card-row ${cls}`;
      const a = document.createElement('span'); a.textContent = k;
      const b = document.createElement('b'); b.textContent = v;
      d.append(a, b);
      return d;
    };
    const head = document.createElement('div');
    head.className = 'card-head';
    head.style.color = r.color;
    head.textContent = `${r.callsign}`;
    const sub = document.createElement('div');
    sub.className = 'muted small';
    sub.textContent = `${r.type} · ${r.sideName}${r.foe ? ' · hostile' : ''}`;
    const deg = Math.round(((r.track * 180) / Math.PI + 360) % 360).toString().padStart(3, '0');
    const emergency = r.squawk === '7700' || r.squawk === '7600';
    const btns = document.createElement('div');
    btns.className = 'card-buttons';
    const btn = (label: string, f: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.addEventListener('click', f);
      btns.append(b);
    };
    btn('Target here', () => { this.globe.picked = { x: r.x, z: r.z }; this.globe.onPick?.(r.x, r.z); });
    btn(this.globe.follow ? 'Stop following' : 'Follow', () => { this.globe.follow = !this.globe.follow; this.drawCard(); });
    btn('✕', () => this.globe.select(null));
    this.card.replaceChildren(head, sub,
      row('Altitude', `${Math.round(r.alt).toLocaleString()} m (${Math.round(r.agl).toLocaleString()} AGL)`),
      row('Ground speed', `${knots(r.gs)} kt · ${Math.round(r.gs)} m/s`),
      row('Vertical rate', `${r.vs >= 0 ? '+' : ''}${Math.round(r.vs * 60).toLocaleString()} m/min`),
      row('Track', `${deg}°`),
      row('Squawk', r.squawk + (r.squawk === '7700' ? ' EMERGENCY' : r.squawk === '7600' ? ' NO RADIO' : ''), emergency ? 'alert' : ''),
      row('Range', `${(r.range / 1000).toFixed(1)} km`),
      row('Status', r.status),
      btns);
  }

  private refresh(): void {
    const sim = this.sim;
    this.drawCard();
    this.credits.textContent = `Credits: ${sim.credits}`;
    const p = this.globe.picked;
    const mercs = sim.airTraffic.flyers.filter((f) => f.role === 'merc' && f.derezAt === null && !f.leaving).length;
    const friends = sim.airTraffic.flyers.filter((f) => f.role === 'friend' && f.derezAt === null && !f.leaving).length;
    const ordered = sim.airTraffic.flyers.filter((f) => f.order && f.derezAt === null).length;
    // What the target block shows (rebuilt only when it changes).
    let key = `${sim.credits}|${friends}|${mercs}|${ordered}|${sim.groundTurrets.territory.version}|${sim.groundTurrets.destroyed.size}`;
    if (p) key += `|${p.x.toFixed(0)},${p.z.toFixed(0)}`;
    if (key !== this.shown) {
      this.shown = key;
      this.target.replaceChildren();
      this.buttons.replaceChildren();
      const btn = (label: string, title: string, enabled: boolean, f: () => void) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = label;
        b.title = title;
        b.disabled = !enabled;
        b.addEventListener('click', f);
        this.buttons.append(b);
      };
      if (!p) {
        this.target.textContent = 'Click a spot on the globe to target it.';
      } else {
        const [ci, cj] = chunkAt(p.x, p.z);
        const owner = sim.groundTurrets.territory.ownerOf(ci, cj);
        const enemy = owner !== null && hostile(sim.team, owner);
        const standing = owner === null ? 0 : turretSites(ci, cj, sim.groundTurrets.density).filter((s) => !sim.groundTurrets.destroyed.has(s.id)).length;
        const dist = Math.hypot(wrapDelta(sim.position.x, p.x), wrapDelta(sim.position.z, p.z));
        const who = owner === null ? 'open sea' : `${TEAMS[owner].name}${owner === sim.team ? ' (yours)' : ''}`;
        const chip = document.createElement('i');
        chip.className = 'team-chip';
        if (owner !== null) chip.style.background = TEAMS[owner].light;
        const line1 = document.createElement('div');
        line1.append(chip, `District ${ci}·${cj}: ${who}`);
        const line2 = document.createElement('div');
        line2.className = 'muted small';
        line2.textContent = `${(dist / 1000).toFixed(1)} km away · ${standing} ${enemy ? 'enemy ' : ''}turret${standing === 1 ? '' : 's'} standing`;
        this.target.append(line1, line2);
        const send = friends + mercs;
        btn(`Send aircraft (${friends} + ${mercs} merc)`, 'Your team\'s aircraft and mercenaries fly there and fight within 3 km of it for 3 minutes', send > 0, () =>
          this.act(() => (sim.orderAircraft(p.x, p.z) ? null : 'No aircraft to send')));
        btn(`Recall (${ordered})`, 'Call the ordered aircraft back to escort you', ordered > 0, () => this.act(() => (sim.recallAircraft() ? null : 'Nothing to recall')));
        for (const kind of ['barrage', 'emp', 'bomber'] as StrikeKind[]) {
          const S = STRIKES[kind];
          const eta = sim.strikeSystem.etaTo(kind, p.x, p.z);
          btn(`${S.label} · ${S.price} cr · ${Math.round(eta)} s`, kind === 'barrage' ? 'Six cruise missiles, each on a different enemy turret within 1.5 km' : kind === 'emp' ? 'One cruise missile that bursts an EMP over the enemy turrets there' : 'A bomber of your team drops a nuke on it and turns for home', sim.credits >= S.price, () =>
            this.act(() => sim.callStrike(kind, p.x, p.z)));
        }
      }
    }
    // Strikes in flight (refreshed each time: ETAs count down).
    const live = sim.strikes;
    this.live.replaceChildren(...(live.length ? live.map((s) => {
      const d = document.createElement('div');
      d.textContent = `${STRIKES[s.kind].label}: ${Math.max(0, Math.round(s.eta - sim.time))} s to target`;
      return d;
    }) : [Object.assign(document.createElement('div'), { className: 'muted', textContent: 'None' })]));
  }
}
