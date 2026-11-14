import { Scenario, SCENARIO, type ScenarioSettings } from '../scenario/scenario.ts';
import { ScenarioMap } from '../render/ScenarioMap.ts';
import { ScenarioPanel, type ScenarioHost } from './ScenarioPanel.ts';

/**
 * The Scenario Lab page (scenario.html): the two-crossing district drawn top-down, run live at
 * the speed you pick, with the panel beside it. `?seed=`, `?driver=net`, `?layout=backup`.
 */
const params = new URLSearchParams(location.search);
let scenario = new Scenario({
  seed: Number(params.get('seed') ?? 1) | 0,
  driver: params.get('driver') === 'net' ? 'net' : 'scripted',
  layout: (params.get('layout') as ScenarioSettings['layout']) ?? 'base',
});
const canvas = document.getElementById('sc-map') as HTMLCanvasElement;
const map = new ScenarioMap(canvas);
const host: ScenarioHost = {
  scenario: () => scenario,
  restart: (s) => { scenario = new Scenario(s); },
  speed: 4,
  running: true,
  selected: null,
};
const panel = new ScenarioPanel(host, document.body);
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  host.selected = map.pick(e.clientX - r.left, e.clientY - r.top);
  map.selected = host.selected;
  panel.refresh();
});

let last = performance.now(), acc = 0, shown = 0;
function frame(now: number): void {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  if (host.running && !scenario.finished) {
    acc += dt * host.speed;
    while (acc >= SCENARIO.dt && !scenario.finished) { scenario.step(); acc -= SCENARIO.dt; panel.sample(); }
  }
  map.selected = host.selected;
  map.draw(scenario, scenario.time);
  shown += dt;
  if (shown > 0.4) { shown = 0; panel.refresh(); }
}
requestAnimationFrame(frame);
Object.assign(window, { scenarioLab: { scenario: () => scenario, host, panel, map } });
