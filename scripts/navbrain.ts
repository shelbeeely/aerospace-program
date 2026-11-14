/**
 * The Navigator's outside brain (src/sim/navBrain.ts, src/sim/navDecisions.ts, src/gen/navBrain.ts):
 * an OpenRouter model chooses among options the Navigator has checked and never steers.
 * - With no brain the Navigator is exactly the built-in computer.
 * - A brain's route and pace are driven (and the car still arrives); its cruise height and
 *   speed are flown; its runway or helipad is landed on.
 * - Wrong, failed, slow and stale answers leave the built-in plan in force; a refused key stops
 *   asking; touching a knob hands it back to the player.
 * - Alternative routes keep off closed roads and really differ.
 * - The prompt carries every option and the player's words; replies are read leniently.
 * Run with `npm run navbrain` (offline: scripted brains). `npm run navbrain -- --live [model]`
 * also sends one real ground decision to OpenRouter (needs OPENROUTER_API_KEY or an injecting proxy).
 */
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { QUADCOPTER } from '../src/craft/builtins.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { ControlInputs, ControlSource } from '../src/sim/controls.ts';
import { FlightAutopilot } from '../src/sim/flightAutopilot.ts';
import { destinations, distance, landingDistanceNeeded } from '../src/sim/nav.ts';
import type { BrainAnswer, BrainDecision, NavBrain } from '../src/sim/navBrain.ts';
import { alternativeRoutes, findRoute, roadOpen, routeOverlap, routeSegments } from '../src/sim/roads.ts';
import { initPhysics, Simulation } from '../src/sim/Simulation.ts';
import type { Telemetry } from '../src/sim/telemetry.ts';
import { landingSites } from '../src/world/landingSites.ts';
import { navPrompt, OpenRouterBrain, parseNavReply, type ChatClient } from '../src/gen/navBrain.ts';
import { DIRECT_BASE_URL, OpenRouter, OpenRouterError, type ChatRequest, type ChatResult } from '../src/gen/openrouter.ts';
import { JOBS } from '../src/gen/catalog.ts';

await initPhysics();
let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? `: ${detail}` : ''}`);
  if (!ok) failures++;
};
const yieldNow = () => new Promise<void>((r) => setTimeout(r, 0));

class Hands implements ControlSource {
  throttle = 0;
  pitch = 0;
  sample(): ControlInputs { return { pitch: this.pitch, roll: 0, yaw: 0, throttle: this.throttle, brake: 0 }; }
}

/** A brain that answers from a script (immediately, or when released). */
class Scripted implements NavBrain {
  name = 'scripted';
  readonly calls: BrainDecision[] = [];
  readonly signals: AbortSignal[] = [];
  constructor(public answer: (d: BrainDecision) => BrainAnswer | Promise<BrainAnswer>) {}
  decide(d: BrainDecision, signal: AbortSignal): Promise<BrainAnswer> {
    this.calls.push(d);
    this.signals.push(signal);
    return Promise.resolve().then(() => this.answer(d));
  }
}

function groundSim(): { sim: Simulation; hands: Hands; ap: FlightAutopilot } {
  const sim = new Simulation(LIGHT_CAR);
  sim.traffic.enabled = false;
  for (let i = 0; i < 120; i++) sim.step({ pitch: 0, roll: 0, yaw: 0, throttle: 0, brake: 1 });
  const hands = new Hands();
  return { sim, hands, ap: new FlightAutopilot(hands) };
}

/** Step the real simulation, yielding now and then so the brain's promises can settle. */
async function run(sim: Simulation, ap: FlightAutopilot, seconds: number, until?: (t: Telemetry) => boolean, each?: (t: Telemetry) => void): Promise<Telemetry> {
  let t = sim.telemetry();
  for (let i = 0; i < seconds * 120; i++) {
    sim.step(ap.sample(sim.dt, t));
    t = sim.telemetry();
    each?.(t);
    if (i % 12 === 0) await yieldNow();
    if (until?.(t)) break;
  }
  return t;
}

const spire = destinations().find((d) => d.id === 'spire')!;

// --- No brain: the built-in computer alone, nothing asked.
{
  const { sim, ap } = groundSim();
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 10);
  const st = ap.advisor.status;
  check(st.state === 'off' && st.decisions === 0 && st.brain === null, 'with no brain the Navigator asks nothing', `${st.state}, ${st.decisions} decisions`);
}

// --- A brain's route and pace are driven, and the car arrives.
{
  const { sim, ap } = groundSim();
  const brain = new Scripted((d) => ({ choices: { route: d.trigger === 'engage' ? 'R2' : 'R1', pace: 'p16' }, reason: 'scripted' }));
  ap.advisor.brain = brain;
  ap.advisor.instructions = 'prefer quiet streets';
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 30 });
  const before = ap.driver.length;
  const seq0 = ap.driver.planSeq;
  await run(sim, ap, 2);
  const first = brain.calls[0];
  const route = first?.questions.find((q) => q.id === 'route');
  const pace = first?.questions.find((q) => q.id === 'pace');
  check(!!first && first.trigger === 'engage' && !!route && !!pace, 'engaging asks for a route and a pace', first ? `${first.trigger}: ${first.questions.map((q) => `${q.id}(${q.options.map((o) => o.id).join(',')})`).join(' ')}` : 'no call');
  check(!!route && route.options.length >= 2 && route.current === 'R1', 'the route question offers the current route and alternatives', route ? route.options.map((o) => `${o.id} ${o.facts.length_m} m`).join(', ') : '');
  check(!!pace && pace.options.every((o) => Number(o.facts.speed_ms) <= 30) && pace.options.some((o) => o.label.includes('your limit')), 'paces stay at or under the player\'s own speed', pace ? pace.options.map((o) => o.id).join(',') : '');
  check(first?.instructions === 'prefer quiet streets', 'the player\'s words go with the decision');
  const r2 = route?.options.find((o) => o.id === 'R2');
  const adopted = ap.driver.route?.length ?? 0;
  check(ap.driver.planSeq > seq0 && !!r2 && Math.abs(adopted - Number(r2.facts.length_m)) < 2, 'the chosen alternative becomes the route driven', `${(before / 1000).toFixed(2)} km → ${(ap.driver.length / 1000).toFixed(2)} km (R2 ${r2?.facts.length_m} m) · ${ap.advisor.status.lastPick}`);
  let top = 0;
  const t = await run(sim, ap, 900, () => ap.state.phase === 'arrived' || !ap.state.engaged, (t) => { top = Math.max(top, t.groundSpeed); });
  check(top < 16 + 2, 'it keeps to the chosen pace', `top ${top.toFixed(1)} m/s for a 16 m/s pace (limit 30)`);
  check(ap.state.phase === 'arrived' && distance(t.position[0], t.position[2], spire.x, spire.z) < 450 && !sim.exploded, 'and arrives, intact', `${ap.state.phase} in ${t.time.toFixed(0)} s, ${distance(t.position[0], t.position[2], spire.x, spire.z).toFixed(0)} m from the spire`);
  const periodic = brain.calls.filter((c) => c.trigger === 'periodic');
  check(periodic.length >= 3 && periodic.every((c) => c.questions.map((q) => q.id).join() === 'pace'), 'it is asked the pace again as the drive goes on, the route only when something happens', `${brain.calls.length} decisions: ${[...new Set(brain.calls.map((c) => `${c.trigger}(${c.questions.map((q) => q.id).join('+')})`))].join(', ')}`);
}

// --- Answers that name nothing on offer change nothing.
{
  const { sim, ap } = groundSim();
  const brain = new Scripted(() => ({ choices: { route: 'R9', pace: 'flat out' }, reason: 'nonsense' }));
  ap.advisor.brain = brain;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  const seq0 = ap.driver.planSeq;
  let top = 0;
  await run(sim, ap, 20, undefined, (t) => { top = Math.max(top, t.groundSpeed); });
  const st = ap.advisor.status;
  check(ap.driver.planSeq === seq0 && st.discarded >= 1 && /not offered/.test(st.message), 'an answer naming nothing on offer is ignored', `${st.discarded} ignored · ${st.message}`);
  check(top > 16, 'and the built-in pace stands', `top ${top.toFixed(1)} m/s (limit 22)`);
}

// --- Failures: back off and retry; a refused key stops asking; a silent brain times out.
{
  const { sim, ap } = groundSim();
  const brain = new Scripted(() => { throw new Error('upstream hiccup'); });
  ap.advisor.brain = brain;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  const t = await run(sim, ap, 30);
  const st = ap.advisor.status;
  check(st.state === 'error' && /upstream hiccup/.test(st.message) && brain.calls.length >= 2 && brain.calls.length <= 4, 'a failing brain is retried with a back-off', `${brain.calls.length} tries in 30 s · ${st.message}`);
  check(ap.state.engaged && t.groundSpeed > 5, 'the vehicle drives on meanwhile', `${t.groundSpeed.toFixed(1)} m/s`);
}
{
  const { sim, ap } = groundSim();
  const brain = new Scripted(() => { throw new OpenRouterError('Missing Authentication header', 401, false); });
  ap.advisor.brain = brain;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 30);
  check(ap.advisor.status.state === 'stopped' && brain.calls.length === 1, 'a refused key stops the asking', `${brain.calls.length} call, ${ap.advisor.status.state}`);
  brain.answer = (d) => ({ choices: { pace: d.questions.find((q) => q.id === 'pace')!.options[0].id }, reason: 'key fixed' });
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 2);
  check(brain.calls.length === 2 && ap.advisor.status.state === 'idle' && ap.advisor.status.decisions === 1, 'until the next engagement, which asks again', `${brain.calls.length} calls, ${ap.advisor.status.state}`);
}

// --- New words from the player bring a fresh decision, routes included.
{
  const { sim, ap } = groundSim();
  const brain = new Scripted(() => ({ choices: {}, reason: 'keep' }));
  ap.advisor.brain = brain;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 3);
  ap.advisor.instructions = 'avoid Red territory';
  ap.advisor.notify('instructions');
  await run(sim, ap, 1);
  const last = brain.calls.at(-1)!;
  check(last.trigger === 'instructions' && last.instructions === 'avoid Red territory' && last.questions.some((q) => q.id === 'route'), 'new instructions are acted on at once, routes and all', `${brain.calls.length} calls, last: ${last.trigger}(${last.questions.map((q) => q.id).join('+')})`);
}
{
  const { sim, ap } = groundSim();
  const brain = new Scripted(() => new Promise<BrainAnswer>(() => {}));
  ap.advisor.brain = brain;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 25);
  check(brain.signals[0]?.aborted === true && /No answer/.test(ap.advisor.status.message), 'a brain that never answers is cut off after 20 s', ap.advisor.status.message);
}

// --- Stale: an answer to an earlier engagement is never applied.
{
  const { sim, ap } = groundSim();
  let release: (a: BrainAnswer) => void = () => {};
  const brain = new Scripted(() => new Promise<BrainAnswer>((r) => { release = r; }));
  ap.advisor.brain = brain;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 1);
  const other = destinations().find((d) => d.id === 'pad-apron')!;
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: other.id, speed: 22 });
  const seq = ap.driver.planSeq;
  release({ choices: { route: 'R2', pace: 'p8' }, reason: 'too late' });
  let top = 0;
  await run(sim, ap, 15, undefined, (t) => { top = Math.max(top, t.groundSpeed); });
  check(brain.signals[0].aborted && ap.driver.planSeq === seq && top > 9, 'an answer to an earlier engagement is dropped', `first request aborted ${brain.signals[0].aborted}, route unchanged ${ap.driver.planSeq === seq}, top ${top.toFixed(1)} m/s`);
}

// --- The throttle hands the pace back to the player.
{
  const { sim, hands, ap } = groundSim();
  ap.advisor.brain = new Scripted(() => ({ choices: { pace: 'p8' }, reason: 'slow' }));
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 22 });
  await run(sim, ap, 15);
  const slow = sim.telemetry().groundSpeed;
  ap.advisor.brain = new Scripted(() => new Promise<BrainAnswer>(() => {})); // the next pick never comes
  hands.throttle = 0.1;
  await run(sim, ap, 12);
  const fast = sim.telemetry().groundSpeed;
  check(slow < 10 && fast > 14, 'touching the throttle takes the pace back from the brain', `${slow.toFixed(1)} → ${fast.toFixed(1)} m/s (cruise ${ap.state.speed.toFixed(0)} m/s)`);
}

// --- Air: cruise height and speed on a Go to, the runway or helipad on a landing.
function airborne(def: typeof TEST_PLANE, alt: number, speed: number): { sim: Simulation; hands: Hands; ap: FlightAutopilot; t: Telemetry } {
  const sim = new Simulation(def);
  const t0 = sim.telemetry();
  const x = spire.x + 6000, z = spire.z + 3000;
  const t: Telemetry = { ...t0, onGround: false, altitude: alt, position: [x, alt, z], airspeed: speed, groundSpeed: speed, velocity: [0, 0, -speed], heading: 0 };
  const hands = new Hands();
  return { sim, hands, ap: new FlightAutopilot(hands), t };
}
async function settle(ap: FlightAutopilot, t: Telemetry, frames = 6): Promise<void> {
  for (let i = 0; i < frames; i++) {
    ap.sample(1 / 120, { ...t, time: t.time + i / 120 });
    await yieldNow();
  }
}
{
  const { ap, hands, t } = airborne(TEST_PLANE, 400, 70);
  const brain = new Scripted((d) => ({ choices: { altitude: 'a1200', speed: d.questions[1].options.at(-1)!.id }, reason: 'high and fast' }));
  ap.advisor.brain = brain;
  ap.engage(t, 'airplane', { stallSpeed: 30 }, { mode: 'goto', destination: 'spire', altitude: 300, speed: 60 });
  await settle(ap, t);
  const d = brain.calls[0];
  const spd = d?.questions.find((q) => q.id === 'speed');
  check(!!d && d.questions.map((q) => q.id).join() === 'altitude,speed', 'an airplane Go to asks for cruise height and speed', d ? d.questions.map((q) => `${q.id}(${q.options.map((o) => o.id).join(',')})`).join(' ') : 'no call');
  check(!!spd && spd.options.every((o) => Number(o.facts.x_stall) >= 1.39), 'every speed offered is well clear of the stall', spd?.options.map((o) => `${o.facts.speed_kt} kt ×${o.facts.x_stall}`).join(', '));
  check(ap.state.commanded >= 1200 && ap.state.altitude === 300, 'the chosen height is flown, the player\'s setting kept', `commanded ${ap.state.commanded.toFixed(0)} m, setting ${ap.state.altitude} m`);
  check((ap.state.guidance?.targetSpeed ?? 0) > 60, 'the chosen speed is flown', `${ap.state.guidance?.targetSpeed.toFixed(0)} m/s`);
  ap.advisor.brain = new Scripted(() => new Promise<BrainAnswer>(() => {}));
  hands.pitch = 0.5;
  await settle(ap, { ...t, time: t.time + 1 }, 2);
  hands.pitch = 0;
  await settle(ap, { ...t, time: t.time + 2 }, 2);
  check(ap.state.commanded < 1200, 'the stick takes the height back', `commanded ${ap.state.commanded.toFixed(0)} m`);
}
{
  const { ap, t } = airborne(TEST_PLANE, 400, 70);
  let offered: string[] = [];
  const brain = new Scripted((d) => {
    const q = d.questions[0];
    offered = q.options.map((o) => o.id);
    return { choices: { site: q.options.find((o) => o.id !== q.current)!.id }, reason: 'into the wind' };
  });
  ap.advisor.brain = brain;
  ap.engage(t, 'airplane', { stallSpeed: 30 }, { mode: 'land' });
  const builtIn = ap.state.guidance?.siteName ?? ap.landingApproach?.site.id;
  await settle(ap, t);
  const q = brain.calls[0]?.questions[0];
  const need = landingDistanceNeeded(ap.approachSpeed);
  const sites = landingSites();
  check(!!q && q.id === 'site' && q.options.length >= 2 && offered.every((id) => (sites.find((s) => s.id === id)?.length ?? 0) >= need), 'landing offers only runways long enough', q ? q.options.map((o) => `${o.label} ${o.facts.length_m} m`).join(', ') : 'no call');
  const chosen = q?.options.find((o) => o.id !== q.current)?.id;
  check(!!chosen && ap.landingApproach?.site.id === chosen && ap.state.phase === 'join', 'the chosen runway is the one flown to', `${builtIn} → ${ap.landingApproach?.site.name}`);
}
{
  const { ap, t } = airborne(QUADCOPTER, 60, 10);
  const brain = new Scripted((d) => ({ choices: { site: d.questions[0].options[1].id }, reason: 'roof' }));
  ap.advisor.brain = brain;
  ap.engage(t, 'rotorcraft', undefined, { mode: 'land' });
  await settle(ap, t);
  const q = brain.calls[0]?.questions[0];
  check(!!q && ap.state.destination === q.options[1].id && ap.state.phase === 'transit', 'a rotorcraft lands on the helipad chosen', q ? `${q.options.map((o) => o.label).join(', ')} → ${ap.state.destination}` : 'no call');
}

// --- Alternative routes: off closed roads, and genuinely different.
{
  const from = { x: 253, z: 206 };
  const fastest = findRoute(from.x, from.z, spire.x, spire.z)!;
  const segs = routeSegments(fastest.points);
  const closedKey = segs[Math.floor(segs.length / 2)];
  const closed = (ax: boolean, i: number, j: number) => `${ax ? 1 : 0},${i},${j}` === closedKey;
  const t0 = performance.now();
  const alts = alternativeRoutes(from.x, from.z, spire.x, spire.z, 3, closed);
  const ms = performance.now() - t0;
  const all = alts.map((r) => routeSegments(r.points));
  const open = all.every((s) => s.every((k) => { const [a, i, j] = k.split(',').map(Number); return roadOpen(a === 1, i, j); }));
  check(alts.length >= 2 && open && all.every((s) => !s.includes(closedKey)), 'alternative routes are all open and keep off a closed road', `${alts.length} routes: ${alts.map((r) => `${(r.length / 1000).toFixed(1)} km`).join(', ')} in ${ms.toFixed(0)} ms`);
  check(all.every((s, a) => all.every((u, b) => a === b || routeOverlap(s, u) <= 0.7)), 'and no two share more than 70 % of their roads');
}

// --- The prompt and the reply.
{
  const d: BrainDecision = {
    seq: 1, vehicle: 'ground vehicle', trigger: 'engage', context: 'c', every: 8, instructions: 'avoid Red territory',
    situation: { destination: 'Grid Spire' },
    questions: [
      { id: 'route', ask: 'Which route', current: 'R1', options: [{ id: 'R1', label: 'the route being driven', facts: { length_m: 7000 } }, { id: 'R2', label: 'alternative B', facts: { length_m: 6200 } }] },
      { id: 'pace', ask: 'Pace', current: 'p22', options: [{ id: 'p16', label: '16 m/s', facts: { speed_ms: 16 } }, { id: 'p22', label: '22 m/s', facts: { speed_ms: 22 } }] },
    ],
  };
  const p = navPrompt(d);
  check(['R1', 'R2', 'p16', 'p22', 'avoid Red territory', '"route":"<R1|R2>"'].every((s) => p.includes(s)), 'the prompt carries every option, the player\'s words and the answer shape', `${p.length} chars`);
  const a = parseNavReply('Sure!\n```json\n{"answers":{"route":"R2","pace":{"id":"p16"}},"reason":"Shorter, and out of Red territory."}\n```', d);
  const b = parseNavReply('{"route":"R1","pace":"p22"}', d);
  check(a.choices.route === 'R2' && a.choices.pace === 'p16' && a.reason.startsWith('Shorter') && b.choices.route === 'R1' && b.choices.pace === 'p22', 'replies are read leniently (fences, "answers", objects, top-level ids)');
  const reply = (content: string, reasoning = ''): ChatResult => ({ model: 'm/x', content, images: [], audio: [], reasoning, usage: { promptTokens: 1, completionTokens: 1, cost: 0.00002 }, toolCalls: [] });
  let sent: ChatRequest | null = null;
  const fake = (r: () => ChatResult | Promise<ChatResult>): ChatClient => ({ chat: async (req) => { sent = req; return r(); } });
  const ob = new OpenRouterBrain(fake(() => reply('', 'thinking... {"choices":{"route":"R2","pace":"p16"},"reason":"ok"}')), () => ({ model: 'inclusionai/ling-3.2-flash:free', fallbacks: ['google/gemma-4-26b-a4b-it:free'] }));
  const ans = await ob.decide(d, new AbortController().signal);
  const req = sent as ChatRequest | null;
  check(ans.choices.route === 'R2' && ans.costUsd === 0.00002 && ans.model === 'm/x' && req?.format === 'json' && req.fallbacks?.length === 1 && ob.name === 'OpenRouter · ling-3.2-flash', 'the OpenRouter brain asks for JSON with backups, and reads an answer left in the reasoning', `${ob.name}, ${JSON.stringify(ans.choices)}`);
  const nohost = new OpenRouterBrain(fake(() => { throw new OpenRouterError('HTTP 404: <html>Not found</html>', 404, false); }), () => ({ model: 'x/y', fallbacks: [] }));
  const e = await nohost.decide(d, new AbortController().signal).then(() => null, (e: unknown) => e as OpenRouterError);
  check(!!e && e.status === 401 && /Key & spend/.test(e.message), 'no OpenRouter behind the page (static hosting) says to add a key', e?.message);
  const badKey = new OpenRouterBrain(fake(() => { throw new OpenRouterError('API key expired.', 401, false); }), () => ({ model: 'x/y', fallbacks: [] }));
  const k = await badKey.decide(d, new AbortController().signal).then(() => null, (e: unknown) => e as OpenRouterError);
  check(!!k && k.status === 401 && /expired/.test(k.message) && /Key & spend/.test(k.message), 'a refused key says what OpenRouter said and where the key lives', k?.message);
  check(JOBS.navigator.free.length >= 2 && JOBS.navigator.free.every((id) => id.endsWith(':free')), 'the Navigator has free default models', JOBS.navigator.free.join(', '));
}

// --- Live (opt-in): one real ground decision to OpenRouter.
const liveAt = process.argv.indexOf('--live');
if (liveAt >= 0) {
  const model = process.argv[liveAt + 1] && !process.argv[liveAt + 1].startsWith('--') ? process.argv[liveAt + 1] : JOBS.navigator.free[0];
  const { sim, ap } = groundSim();
  const client = new OpenRouter({ baseUrl: DIRECT_BASE_URL, apiKey: process.env.OPENROUTER_API_KEY ?? 'injected-by-proxy', maxRetries: 1 });
  const real = new OpenRouterBrain(client, () => ({ model, fallbacks: [] }), 30000);
  ap.advisor.brain = real;
  ap.advisor.instructions = 'keep out of hostile territory if it costs under a minute';
  ap.world = { hostileAt: (x) => (Math.floor(Math.abs(x) / 900) % 3 === 0 ? 'Red' : null), extras: () => ({ player_side: 'Cyan', hostile_sides: ['Red'] }) };
  ap.engage(sim.telemetry(), 'ground', undefined, { mode: 'goto', destination: 'spire', speed: 30 });
  const t0 = Date.now();
  await run(sim, ap, 40, () => ap.advisor.status.decisions > 0 || ap.advisor.status.state === 'stopped' || ap.advisor.status.state === 'error');
  const st = ap.advisor.status;
  check(st.decisions > 0 && !!st.lastPick && st.discarded === 0, `live: ${model} answers a ground decision with options on offer`, `${st.lastPick || st.message} · "${st.message}" · ${(st.latencyMs / 1000).toFixed(1)} s (wall ${((Date.now() - t0) / 1000).toFixed(1)} s) · $${st.spentUsd.toFixed(6)}`);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll Navigator brain checks passed');
process.exit(failures ? 1 : 0);
