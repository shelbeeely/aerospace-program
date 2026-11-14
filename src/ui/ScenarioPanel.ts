import { LAYOUT_LABEL, LAYOUTS, type Layout } from '../scenario/district.ts';
import { clock } from '../scenario/log.ts';
import { DRIVE_ACTIONS } from '../scenario/policies.ts';
import { KIND, Scenario, summary, type ScenarioSettings } from '../scenario/scenario.ts';
import { squadShape } from '../scenario/escort.ts';
import { DRONE } from '../scenario/drone.ts';
import { CHART, GeneChart } from './EvolutionCharts.ts';

/**
 * The Scenario Lab's panel: run it, set who drives (the scripted driver or the networks) and on
 * which street network, close and reopen the crossings, give the player's orders, read the
 * district's state (deliveries, ambulances, the evacuation, the convoy, the clinic), order the
 * escort squad onto a vehicle and send the supply drone, watch it over time, inspect any
 * vehicle's decisions, and compare drivers and street networks on the same encounter.
 */
export interface ScenarioHost {
  scenario(): Scenario;
  restart(settings: Partial<ScenarioSettings>): void;
  speed: number;
  running: boolean;
  selected: number | null;
}

const SHORT: Record<Layout, string> = { base: 'Two crossings', backup: 'Backup bridge', emergencyLane: 'Emergency lane', depotEast: 'Depot east' };

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

export class ScenarioPanel {
  readonly root: HTMLDivElement;
  private readonly stats: HTMLTableElement;
  private readonly inspect: HTMLDivElement;
  private readonly compare: HTMLDivElement;
  private readonly runBtn: HTMLButtonElement;
  private readonly timeEl: HTMLSpanElement;
  private readonly stockChart = new GeneChart('Clinic stock and vehicles waiting', 130, { yMax: 60, fmt: (v) => v.toFixed(0) });
  private readonly speedBtns = new Map<number, HTMLButtonElement>();
  private readonly closeBtns = new Map<string, HTMLButtonElement>();
  private readonly orders = new Map<string, HTMLInputElement>();
  private readonly escortBtn: HTMLButtonElement;
  private readonly droneBtn: HTMLButtonElement;
  private readonly units: HTMLDivElement;
  /** Samples over time: clinic stock, vehicles standing on the roads, evacuees sheltered. */
  readonly history: Array<{ t: number; stock: number; waiting: number; sheltered: number }> = [];

  constructor(private readonly host: ScenarioHost, parent: HTMLElement) {
    this.root = el('div');
    this.root.id = 'sc-panel';
    const head = el('div', 'sc-head');
    head.append(el('h3', '', 'SCENARIO LAB'));
    this.timeEl = el('span', 'sc-time', '0:00');
    head.append(this.timeEl);
    this.root.append(head);
    this.root.append(el('p', 'sc-hint', 'One district, two crossings over the data channel. The east bank evacuates at 1:00; North Bridge closes at 1:30 and fighting goes on round its east end; the convoy must cross at 2:00. Click a vehicle to see why it did what it did, order the squad to escort it, or send the drone over the channel.'));

    // Run controls.
    const run = el('div', 'sc-row');
    this.runBtn = el('button', '', 'Pause');
    this.runBtn.addEventListener('click', () => { host.running = !host.running; this.refresh(); });
    run.append(this.runBtn);
    for (const sp of [1, 4, 16]) {
      const b = el('button', '', `${sp}×`);
      b.addEventListener('click', () => { host.speed = sp; this.refresh(); });
      this.speedBtns.set(sp, b);
      run.append(b);
    }
    const restart = el('button', '', 'Restart');
    restart.addEventListener('click', () => this.restart());
    run.append(restart);
    this.root.append(run);

    // Settings (applied on restart).
    const set = el('div', 'sc-row');
    const driver = el('select');
    driver.setAttribute('aria-label', 'Who drives');
    for (const [v, t] of [['scripted', 'Scripted driver'], ['net', 'Neural networks']]) { const o = el('option', '', t); o.value = v; driver.append(o); }
    const layout = el('select');
    layout.setAttribute('aria-label', 'Street network');
    for (const l of LAYOUTS) { const o = el('option', '', LAYOUT_LABEL[l]); o.value = l; layout.append(o); }
    const seed = el('input');
    seed.type = 'number';
    seed.value = '1';
    seed.setAttribute('aria-label', 'Seed');
    seed.className = 'sc-seed';
    const wind = el('select');
    wind.setAttribute('aria-label', 'Wind');
    for (const [v, t] of [['0', 'Calm'], ['6', 'Breeze 6 m/s'], ['10', 'Strong 10 m/s']]) { const o = el('option', '', t); o.value = v; wind.append(o); }
    wind.value = '6';
    for (const s of [driver, layout, wind, seed]) s.addEventListener('change', () => this.restart());
    this.settingsEls = { driver, layout, wind, seed };
    set.append(driver, layout, wind, seed);
    this.root.append(set);

    // Incidents and orders (live).
    this.root.append(el('h4', '', 'Incidents'));
    const inc = el('div', 'sc-row');
    for (const name of ['North Bridge', 'South Bridge', 'Backup Bridge']) {
      const b = el('button');
      b.addEventListener('click', () => {
        const sc = host.scenario();
        const pair = sc.district.crossings[name];
        if (!pair) return;
        if (sc.district.edges[pair[0]].closed) sc.reopen(name);
        else sc.close(name);
        this.refresh();
      });
      this.closeBtns.set(name, b);
      inc.append(b);
    }
    this.root.append(inc);
    this.root.append(el('h4', '', 'Orders'));
    for (const [key, label] of [['ambulancesFirst', 'Ambulances first at junctions'], ['contraflow', 'Evacuation contraflow on South Bridge'], ['trucksHold', 'Trucks hold during the evacuation']] as const) {
      const row = el('label', 'sc-check');
      const box = el('input');
      box.type = 'checkbox';
      box.addEventListener('change', () => { host.scenario().setPriority(key, box.checked); });
      this.orders.set(key, box);
      row.append(box, document.createTextNode(` ${label}`));
      this.root.append(row);
    }
    const act = el('div', 'sc-row');
    this.escortBtn = el('button', '', 'Escort selected');
    this.escortBtn.addEventListener('click', () => {
      const sc = host.scenario();
      if (sc.squad.target !== null) sc.escort(null);
      else if (host.selected !== null && sc.vehicles[host.selected].edge >= 0) sc.escort(host.selected);
      this.refresh();
    });
    this.droneBtn = el('button', '', 'Send the drone');
    this.droneBtn.addEventListener('click', () => { host.scenario().sendDrone(); this.refresh(); });
    act.append(this.escortBtn, this.droneBtn);
    this.root.append(act);
    this.units = el('div', 'sc-units');
    this.root.append(this.units);

    this.root.append(el('h4', '', 'The district'));
    this.stats = el('table', 'sc-kv');
    this.root.append(this.stats, this.stockChart.root);

    this.root.append(el('h4', '', 'Selected vehicle'));
    this.inspect = el('div', 'sc-inspect', 'Click a vehicle on the map.');
    this.root.append(this.inspect);

    this.root.append(el('h4', '', 'Compare (the whole 20 minutes, this seed)'));
    const cmp = el('div', 'sc-row');
    const drivers = el('button', '', 'Scripted vs networks');
    drivers.addEventListener('click', () => this.compareRuns('driver'));
    const layouts = el('button', '', 'Street networks');
    layouts.addEventListener('click', () => this.compareRuns('layout'));
    cmp.append(drivers, layouts);
    this.compare = el('div', 'sc-compare');
    this.root.append(cmp, this.compare);
    parent.append(this.root);
    this.refresh();
  }

  private settingsEls!: { driver: HTMLSelectElement; layout: HTMLSelectElement; wind: HTMLSelectElement; seed: HTMLInputElement };

  private settings(): Partial<ScenarioSettings> {
    const s = this.settingsEls;
    const priorities = { ambulancesFirst: !!this.orders.get('ambulancesFirst')?.checked, contraflow: !!this.orders.get('contraflow')?.checked, trucksHold: !!this.orders.get('trucksHold')?.checked };
    return { driver: s.driver.value as ScenarioSettings['driver'], layout: s.layout.value as Layout, wind: Number(s.wind.value), seed: Number(s.seed.value) | 0, priorities };
  }

  private restart(): void {
    this.history.length = 0;
    this.host.restart(this.settings());
    this.host.selected = null;
    this.compare.replaceChildren();
    this.refresh();
  }

  /** Record a sample (every few simulated seconds). */
  sample(): void {
    const sc = this.host.scenario();
    const last = this.history[this.history.length - 1];
    if (last && sc.time - last.t < 5) return;
    let waiting = 0;
    for (const v of sc.vehicles) if (v.edge >= 0 && v.speed < 0.5) waiting++;
    this.history.push({ t: sc.time, stock: Math.max(0, sc.stock.level), waiting, sheltered: sc.shelterUsed });
  }

  refresh(): void {
    const h = this.host, sc = h.scenario();
    this.runBtn.textContent = sc.finished ? 'Done' : h.running ? 'Pause' : 'Run';
    for (const [sp, b] of this.speedBtns) b.classList.toggle('on', sp === h.speed);
    this.timeEl.textContent = `${clock(sc.time)} / ${clock(sc.settings.duration)}`;
    for (const [name, b] of this.closeBtns) {
      const pair = sc.district.crossings[name];
      b.style.display = pair ? '' : 'none';
      if (pair) {
        const closed = sc.district.edges[pair[0]].closed;
        b.textContent = `${closed ? 'Reopen' : 'Close'} ${name}`;
        b.classList.toggle('danger', closed);
      }
    }
    for (const [k, box] of this.orders) box.checked = sc.settings.priorities[k as keyof ScenarioSettings['priorities']];
    // The squad and the drone: their orders, what their policies chose, and how it went.
    const sq = sc.squad, dr = sc.drone, sel = h.selected !== null ? sc.vehicles[h.selected] : null;
    this.escortBtn.textContent = sq.target !== null ? 'Stand the squad down' : 'Escort selected';
    this.escortBtn.disabled = sq.target === null && !(sel && sel.edge >= 0);
    this.droneBtn.disabled = dr.state !== 'idle';
    this.units.replaceChildren();
    const unit = (name: string, now: string, last?: string) => {
      const row = el('div', 'sc-unit');
      row.append(el('b', '', name), document.createTextNode(` ${now}`));
      if (last) row.append(el('span', 'sc-unit-last', ` · ${last}`));
      this.units.append(row);
    };
    const tgt = sq.target !== null ? sc.vehicles[sq.target] : null;
    const lastSq = sq.log[sq.log.length - 1];
    unit('Squad', tgt ? `escorting ${KIND[tgt.kind].label} #${tgt.id}, holding ${sq.slot} · ${squadShape(sq).units} of 4 units` : 'standing by: select a vehicle, then Escort', lastSq ? `${clock(lastSq.t)} ${lastSq.text}` : undefined);
    const lastDr = dr.log[dr.log.length - 1];
    unit('Drone', `${dr.state}${dr.state === 'idle' ? ` at the depot with ${DRONE.payload} units` : ''} · battery ${Math.max(0, (dr.battery / DRONE.battery) * 100).toFixed(0)}%`, lastDr ? `${clock(lastDr.t)} ${lastDr.text}` : undefined);
    // The district now.
    const m = sc.metrics(), s = summary(m);
    this.stats.replaceChildren();
    const kv = (k: string, v: string) => { const tr = this.stats.insertRow(); tr.insertCell().textContent = k; tr.insertCell().textContent = v; };
    const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '-');
    kv('Freight', `${m.deliveries.filter((d) => d.arrived !== null).length} of ${m.deliveries.length} delivered · ${f0(s.delivery)} s late on average`);
    kv('Ambulances', `${m.responses.filter((r) => r.time !== null).length} of ${m.responses.length} calls · ${f0(s.response)} s to the clinic`);
    kv('Evacuation', `${m.evacuation.sheltered} sheltered · ${m.evacuation.unsheltered} without a place${m.evacuation.lastArrival ? ` · last in at ${clock(m.evacuation.lastArrival)}` : ''}`);
    kv('Convoy', m.convoy.arrivedAt !== null ? `through in ${f0(m.convoy.arrivedAt)} s` : m.convoy.trucks ? `${m.convoy.arrived} of ${m.convoy.trucks} through` : 'not yet');
    kv('Clinic', `stock ${Math.max(0, sc.stock.level).toFixed(0)} · short for ${f0(m.shortage)} s${m.untreated ? ` · ${m.untreated} untreated` : ''}${m.recoveredAt ? ` · recovered at ${clock(m.recoveredAt)}` : ''}`);
    kv('Traffic', `longest queue ${m.maxQueue} · mean trip delay ${f0(s.delay)} s · collisions ${m.collisions}`);
    kv('Decisions', DRIVE_ACTIONS.map((a) => `${a} ${m.decisions[a]}`).join(' · '));
    kv('Fighting', `${m.heldUp} held up${sc.zones.some((z) => sc.time < z.until) ? ` · at ${sc.zones.filter((z) => sc.time < z.until).map((z) => z.name).join(', ')}` : ''}`);
    const sd = Object.entries(sq.decisions).filter(([, n]) => n).map(([a, n]) => `${a} ${n}`).join(' · ');
    const fd = Object.entries(dr.decisions).filter(([, n]) => n).map(([a, n]) => `${a} ${n}`).join(' · ');
    if (sd || fd) kv('Squad, drone', [sd && `squad: ${sd}`, fd && `drone: ${fd}`].filter(Boolean).join(' / '));
    const times = this.history.map((x) => x.t);
    this.stockChart.set(times, [
      { label: 'Clinic stock', color: CHART.series[1], values: this.history.map((x) => x.stock) },
      { label: 'Vehicles waiting', color: CHART.series[0], values: this.history.map((x) => x.waiting) },
      { label: 'Sheltered', color: CHART.series[2], values: this.history.map((x) => x.sheltered) },
    ]);
    // The selected vehicle.
    const v = h.selected !== null ? sc.vehicles[h.selected] : null;
    this.inspect.replaceChildren();
    if (!v) { this.inspect.textContent = 'Click a vehicle on the map.'; return; }
    const pol = sc.policyOf(v);
    const title = el('div', 'sc-vtitle', `${KIND[v.kind].label} #${v.id}${sq.target === v.id ? ' (escorted)' : ''} · ${v.job} · ${pol.id} policy (${sc.settings.driver === 'net' && pol.net ? 'network' : 'scripted'})${v.edge >= 0 ? ` · ${(v.speed * 3.6).toFixed(0)} km/h on ${sc.district.edges[v.edge].name}` : ' · parked'}`);
    const why = el('div', 'sc-why', sc.explain(v.id));
    const list = el('ol', 'sc-log');
    for (const e of v.log.slice(-8).reverse()) list.append(el('li', '', `${clock(e.t)} ${e.text}`));
    this.inspect.append(title, why, list);
  }

  /** Run whole scenarios headless and tabulate them. */
  private compareRuns(what: 'driver' | 'layout'): void {
    const base = this.settings();
    const variants: Array<[string, Partial<ScenarioSettings>]> = what === 'driver'
      ? [['Scripted', { ...base, driver: 'scripted' }], ['Networks', { ...base, driver: 'net' }]]
      : LAYOUTS.map((l) => [SHORT[l], { ...base, layout: l }] as [string, Partial<ScenarioSettings>]);
    const table = el('table', 'sc-kv sc-cmp');
    const head = table.insertRow();
    for (const t of ['', 'Freight late', 'Ambulance', 'Delay', 'Evac done', 'Short']) head.insertCell().textContent = t;
    const f0 = (x: number) => (Number.isFinite(x) ? x.toFixed(0) : '-');
    for (const [name, s] of variants) {
      const sc = new Scenario(s);
      sc.run();
      const r = summary(sc.metrics());
      const tr = table.insertRow();
      for (const v of [name, `${f0(r.delivery)} s`, `${f0(r.response)} s`, `${f0(r.delay)} s`, r.evacuated ? clock(r.evacuated) : '-', `${f0(r.shortage)} s`]) tr.insertCell().textContent = v;
    }
    this.compare.replaceChildren(table);
  }
}
