/**
 * Craft rules, offline (no API calls). Run with `npm run craft`.
 *
 * 1. Every built-in and reference design is one connected piece (no floating parts).
 * 2. The 1982 palette: every styled colour is a body or light colour, lit parts stay under a
 *    quarter of the surface, styling is idempotent, and off-palette designs are restyled.
 * 3. The AI design loop rejects a craft with a floating part, tells the model which part, and
 *    accepts the corrected one (stub model).
 * 4. The designer prompt covers ground vehicles, the visual language and connectivity, and a
 *    ground vehicle passes the design pipeline's test card.
 */
import { BLIMP, BUILTINS, HELICOPTER } from '../src/craft/builtins.ts';
import { connectivityErrors } from '../src/craft/connectivity.ts';
import { BODY_COOL, BODY_WARM, LIGHTS, isBodyColor, style1982 } from '../src/craft/style1982.ts';
import type { CraftDef } from '../src/craft/types.ts';
import { LIGHT_CAR } from '../src/craft/lightCar.ts';
import { designCraft, DESIGNER_SYSTEM_PROMPT } from '../src/gen/craftDesigner.ts';
import { mergeDetail } from '../src/gen/detailer.ts';
import { designWithAgent, partialParts, type AgentTrace } from '../src/gen/agent.ts';
import { toJsonl } from '../src/gen/traces.ts';
import { OpenRouter as Client } from '../src/gen/openrouter.ts';
import { defaultModel, fallbacksFor, modelsForJob } from '../src/gen/catalog.ts';
import { detailCraft } from '../src/gen/detailer.ts';
import type { ModelInfo } from '../src/gen/openrouter.ts';
import type { OpenRouter } from '../src/gen/openrouter.ts';
import { flightTest } from '../src/sim/flightTest.ts';
import { initPhysics } from '../src/sim/Simulation.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};

// ---------------------------------------------------------------- 1. connectivity
console.log('--- connectivity');
const all: Array<[string, CraftDef]> = [...BUILTINS.map((b) => [b.id, b.craft] as [string, CraftDef]), ['helicopter', HELICOPTER], ['blimp', BLIMP]];
for (const [id, c] of all) {
  const e = connectivityErrors(style1982(c));
  check(e.length === 0, `${id} is one connected piece`, e[0] ?? '');
}

// ---------------------------------------------------------------- 2. palette
console.log('\n--- 1982 palette');
const palette = new Set([...BODY_COOL, ...BODY_WARM, ...LIGHTS].map((c) => c.toLowerCase()));
const area = (c: CraftDef['parts'][number]) => {
  const s = c.shape;
  const d = s.type === 'box' ? s.size : s.type === 'sphere' ? [2 * s.radius, 2 * s.radius, 2 * s.radius] : [2 * s.radius, 2 * s.radius, s.length];
  return 2 * (d[0] * d[1] + d[1] * d[2] + d[0] * d[2]);
};
for (const [id, c] of all) {
  const s = style1982(c);
  const off = s.parts.filter((p) => !palette.has(p.color.toLowerCase()));
  const total = s.parts.reduce((a, p) => a + area(p), 0);
  const lit = s.parts.filter((p) => !isBodyColor(p.color)).reduce((a, p) => a + area(p), 0);
  const stable = JSON.stringify(style1982(s)) === JSON.stringify(s);
  check(!off.length && lit / total <= 0.26 && lit > 0 && stable, `${id}: palette, ${(100 * lit / total).toFixed(0)}% lit, idempotent`, off.map((p) => `${p.id}=${p.color}`).join(' '));
}
{
  // A model that paints everything hot pink and lime gets dark bodies and one circuit light.
  const loud: CraftDef = { ...LIGHT_CAR, parts: LIGHT_CAR.parts.map((p, i) => ({ ...p, color: i % 2 ? '#ff00cc' : '#99ff00' })) };
  const s = style1982(loud);
  const lights = new Set(s.parts.filter((p) => !isBodyColor(p.color)).map((p) => p.color));
  check(s.parts.every((p) => palette.has(p.color.toLowerCase())) && lights.size <= 2, 'an off-palette design is restyled', `lights ${[...lights].join(', ')}`);
}

// ---------------------------------------------------------------- 3. design loop rejects floating parts
console.log('\n--- design loop');
{
  const floating: CraftDef = structuredClone(LIGHT_CAR);
  floating.parts.push({ id: 'drone.pod', kind: 'pod', mass: 5, position: [0, 6, 0], shape: { type: 'box', size: [0.5, 0.5, 0.5] }, color: '#00d4ff' });
  const replies = [floating, LIGHT_CAR].map((c) => JSON.stringify({ name: c.name, notes: 'stub', craft: c }));
  const seen: string[] = [];
  const stub = {
    async chat(req: { messages: Array<{ role: string; content: string }> }) {
      seen.push(req.messages[req.messages.length - 1].content);
      return { model: 'stub/model', content: replies.shift() ?? replies[0], images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0 } };
    },
  } as unknown as OpenRouter;
  const res = await designCraft(stub, { model: 'stub/model', prompt: 'a light car', maxIterations: 2, detail: false });
  check(res.attempts[0].validationErrors?.some((e) => /drone\.pod.*floating/.test(e)) ?? false, 'a floating part is rejected', res.attempts[0].validationErrors?.[0] ?? 'not rejected');
  check(/floating/.test(seen[1] ?? ''), 'the model is told which part floats');
  check(res.report.vehicle === 'ground' && res.attempts.length === 2, 'the corrected ground vehicle is accepted and tested', `${res.report.vehicle} ${res.report.score}/100`);
}

// ---------------------------------------------------------------- 4. prompt and ground card
console.log('\n--- prompt');
for (const [k, re] of [['ground vehicles', /Ground vehicles:/], ['skid steering', /"skid"/], ['stabilizer', /"type":"stabilizer"/], ['visual language', /1982 TRON/], ['connectivity', /ONE connected piece/], ['light cycle reference', /Light cycle \(two wheels/], ['inventiveness', /Be inventive/], ['fast engines', /"kind":"ramjet"[\s\S]*"kind":"scramjet"[\s\S]*"kind":"solid"/], ['thrust vectoring', /gimbalDeg/], ['cone and capsule parts', /"type":"cone"[\s\S]*"type":"capsule"/], ['airbrakes and chutes', /"type":"airbrake"[\s\S]*"type":"chute"/], ['weight floors', /must cover what it carries/], ['going fast', /## Going fast/]] as const) {
  check(re.test(DESIGNER_SYSTEM_PROMPT), `the designer prompt covers ${k}`);
}
{
  const r = await flightTest(LIGHT_CAR);
  check(r.vehicle === 'ground' && r.passed, 'a ground vehicle passes the design pipeline\'s test card', `${r.vehicle} ${r.score}/100`);
}

// ---------------------------------------------------------------- 5. detail round
console.log('\n--- detail');
const chassis = LIGHT_CAR.parts.find((p) => p.id === 'chassis')!;
const side = chassis.position[0] + (chassis.shape.type === 'box' ? chassis.shape.size[0] / 2 : 0.9); // chassis right face
const detailed = (base: CraftDef): CraftDef => ({
  ...base,
  parts: [
    // A tested part "edited" (heavier) and another one left out: both must come back as they were.
    ...base.parts.slice(1).map((p) => (p.id === 'chassis' ? { ...p, mass: p.mass * 3 } : p)),
    // A plate on the chassis, sent with a collider, a module and a big mass: made visual and light.
    { id: 'plate.top', kind: 'armour plate', mass: 500, position: [side + 0.03, chassis.position[1], chassis.position[2]], shape: { type: 'box', size: [0.06, 0.3, 1.6] }, color: '#10284f', collider: true, modules: [{ type: 'drag', cdA: 5 }] },
    // A seam that only touches the plate, not the chassis (connected through the plate).
    { id: 'seam.top', kind: 'accent light', mass: 0.05, position: [side + 0.085, chassis.position[1], chassis.position[2]], shape: { type: 'box', size: [0.03, 0.03, 1.5] }, color: '#00d4ff', collider: false },
    // Wholly inside the chassis: invisible, dropped.
    { id: 'buried', kind: 'plate', mass: 0.5, position: [...chassis.position], shape: { type: 'box', size: [0.3, 0.1, 0.3] }, color: '#10284f', collider: false },
    // Floating, and malformed: dropped.
    { id: 'halo', kind: 'ring', mass: 0.5, position: [0, 9, 0], shape: { type: 'box', size: [1, 0.05, 1] }, color: '#ffb000', collider: false },
    { id: 'bad', kind: 'x', mass: 0.5, position: [0, 1, 0], shape: { type: 'cone', radius: 1 }, color: '#ffb000' } as unknown as CraftDef['parts'][number],
  ],
});
{
  const base = style1982(LIGHT_CAR);
  const m = mergeDetail(base, detailed(base));
  const same = base.parts.every((b) => JSON.stringify(m.craft.parts.find((p) => p.id === b.id)) === JSON.stringify(b));
  const extra = m.craft.parts.filter((p) => !base.parts.some((b) => b.id === p.id));
  const baseMass = base.parts.reduce((a, p) => a + p.mass, 0);
  const addedMass = extra.reduce((a, p) => a + p.mass, 0);
  check(same, 'every tested part is kept exactly as tested (edits ignored, removals restored)', m.notes.join('; '));
  check(extra.map((p) => p.id).sort().join(',') === 'plate.top,seam.top', 'connected, visible detail is kept; floating, buried and malformed parts are dropped', extra.map((p) => p.id).join(','));
  check(extra.every((p) => p.collider === false && !p.modules), 'detail parts are visual only (no collider, no modules)');
  check(addedMass <= baseMass * 0.02 + 0.02, 'detail mass stays under 2% of the craft', `${addedMass.toFixed(1)} kg of ${baseMass.toFixed(0)} kg`);
  check(connectivityErrors(m.craft).length === 0, 'the detailed craft is one connected piece');
}
{
  // The design loop: a passing draft, then the detail round (stub model).
  const replies = [LIGHT_CAR, detailed(style1982(LIGHT_CAR))].map((c) => JSON.stringify({ name: 'Detail Car', notes: 'stub', craft: c }));
  const stub = {
    async chat() {
      return { model: 'stub/model', content: replies.shift() ?? '', images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0 } };
    },
  } as unknown as OpenRouter;
  const res = await designCraft(stub, { model: 'stub/model', prompt: 'a light car', maxIterations: 2 });
  const d = res.attempts.find((a) => a.role === 'detailer');
  check(!!d && res.craft.parts.length === style1982(LIGHT_CAR).parts.length + 2, 'a passing design gets a detail round, re-tested and kept', d?.fixes?.[0] ?? 'no detail round');
  check(res.report.passed, 'the detailed design still passes its test card', `${res.report.score}/100`);
}
check(/Detail \(three tiers/.test(DESIGNER_SYSTEM_PROMPT), 'the designer prompt teaches the three detail tiers');

// ---------------------------------------------------------------- 6. agent harness
console.log('\n--- agent harness');
{
  const floating: CraftDef = structuredClone(LIGHT_CAR);
  floating.parts.push({ id: 'drone.pod', kind: 'pod', mass: 5, position: [0, 6, 0], shape: { type: 'box', size: [0.5, 0.5, 0.5] }, color: '#00d4ff' });
  const extra = detailed(style1982(LIGHT_CAR)).parts.filter((p) => !LIGHT_CAR.parts.some((b) => b.id === p.id));
  let n = 0;
  const call = (name: string, args: unknown = {}) => ({ id: `c${++n}`, type: 'function', function: { name, arguments: JSON.stringify(args) } });
  // A scripted agent: draft (with a floating part), check, patch it out, analyze, test, detail
  // (including an attempt to triple the chassis mass), re-test, finish.
  const script = [
    [call('submit_craft', { craft: floating })],
    [call('patch', { ops: [{ op: 'remove', id: 'drone.pod' }] }), call('check')],
    [call('analyze'), call('flight_test')],
    [call('add_detail', { parts: [...extra, { ...LIGHT_CAR.parts.find((p) => p.id === 'chassis')!, mass: 9999 }] }), call('check')],
    [call('flight_test')],
    [call('finish', { name: 'Agent Car', notes: 'stub agent' })],
  ];
  const results: string[] = [];
  const stub = {
    async chat(req: { messages: Array<{ role: string; content: string }> }) {
      for (const m of req.messages.slice(-4)) if (m.role === 'tool') results.push(m.content);
      return { model: 'stub/agent', content: '', images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0 }, toolCalls: script.shift() ?? [call('finish', { name: 'x' })] };
    },
  } as unknown as OpenRouter;
  const tools: string[] = [];
  let trace: AgentTrace | null = null;
  const res = await designWithAgent(stub, { model: 'stub/agent', prompt: 'a light car', onTrace: (t) => (trace = t) }, (e) => { if (e.type === 'tool') tools.push(`${e.name}: ${e.summary}`); });
  {
    const line = trace ? JSON.parse(toJsonl([trace]).trim()) : null;
    const roles = line?.messages.map((m: { role: string }) => m.role[0]).join('') ?? '';
    check(!!line && line.metadata.passed && line.tools.length === 8 && /^su(at+)+/.test(roles) && line.messages.filter((m: { role: string }) => m.role === 'tool').length === 9,
      'the run is kept as a JSONL training trace (messages, tool calls and results, tools, outcome)', `${roles.length} messages, passed ${line?.metadata.passed}, ${line?.metadata.turns} turns`);
  }
  console.log('  ' + tools.join('\n  '));
  check(tools.some((t) => /^submit_craft:.*OK/.test(t)) && results.some((r) => /floating/.test(r)), 'the agent sees the floating part it submitted');
  check(res.report.passed && res.name === 'Agent Car', 'the agent runs check, analyze, test and detail, and finishes with a passing craft', `${res.report.vehicle} ${res.report.score}/100`);
  check(res.craft.parts.some((p) => p.id === 'plate.top') && !res.craft.parts.some((p) => p.id === 'drone.pod'), 'its detail is in and the floating part is out');
  const chassisMass = res.craft.parts.find((p) => p.id === 'chassis')!.mass;
  check(chassisMass === style1982(LIGHT_CAR).parts.find((p) => p.id === 'chassis')!.mass, 'add_detail cannot change the tested physics', `chassis ${chassisMass} kg`);
  check(res.attempts.length === 2, 'two harness-run flight tests', `${res.attempts.length}`);
}
{
  // A model without tool support runs the fixed pipeline.
  const replies = [JSON.stringify({ name: 'Plain', notes: '', craft: LIGHT_CAR })];
  let usedTools = false;
  const stub = {
    async chat(req: { tools?: unknown[] }) {
      if (req.tools) usedTools = true;
      return { model: 'stub/plain', content: replies.shift() ?? '', images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0 }, toolCalls: [] };
    },
  } as unknown as OpenRouter;
  const info = { id: 'stub/plain', supportedParameters: ['temperature'] } as unknown as ModelInfo;
  const res = await designWithAgent(stub, { model: 'stub/plain', prompt: 'a light car', modelInfo: info, detail: false });
  check(!usedTools && res.report.passed, 'a model without tool support gets the fixed pipeline', `${res.report.score}/100`);
}
{
  // A model that ignores the tools (answers JSON) also falls back.
  let calls = 0;
  const stub = {
    async chat(req: { tools?: unknown[] }) {
      calls++;
      const content = req.tools ? 'I will design it.' : JSON.stringify({ name: 'Plain', notes: '', craft: LIGHT_CAR });
      return { model: 'stub/plain', content, images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0 }, toolCalls: [] };
    },
  } as unknown as OpenRouter;
  const res = await designWithAgent(stub, { model: 'stub/plain', prompt: 'a light car', detail: false });
  check(res.report.passed && calls >= 4, 'a model that won\'t call tools falls back to the fixed pipeline', `${calls} calls`);
}

// ---------------------------------------------------------------- 7. agentic-only endpoints
console.log('\n--- agentic-only endpoints (Inkling 2 Small free)');
{
  const INK = 'thinkingmachines/inkling-2-small:free';
  let called = 0;
  const silent = {
    async chat() {
      called++;
      return { model: INK, content: 'I will just describe it.', images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0 }, toolCalls: [] };
    },
  } as unknown as OpenRouter;
  const refuses = async (f: () => Promise<unknown>) => { try { await f(); return false; } catch (e) { return /agent harness/.test(String(e)); } };
  check(await refuses(() => designCraft(silent, { model: INK, prompt: 'x' })), 'the fixed rounds refuse it');
  check(await refuses(() => detailCraft(silent, { model: INK, craft: LIGHT_CAR, concept: 'x' })), 'the one-shot detail call refuses it');
  const before = called;
  check(await refuses(() => designWithAgent(silent, { model: INK, prompt: 'x' })), 'if it won\'t use tools, the harness stops instead of falling back to the fixed rounds');
  check(called - before === 3, 'and it only ever saw agent turns', `${called - before} agent turns`);
  const info = (id: string, tools = true) => ({ id, name: id, description: '', contextLength: 0, maxCompletionTokens: 0, inputModalities: ['text'], outputModalities: ['text'], pricing: { prompt: 0, completion: 0 }, supportedParameters: tools ? ['tools'] : [], created: 1 }) as ModelInfo;
  const catalog = [info(INK), info('nvidia/nemotron-3-ultra-550b-a55b:free'), info('google/gemma-4-31b-it:free')];
  check(!fallbacksFor(catalog, 'designer', 'nvidia/nemotron-3-ultra-550b-a55b:free').includes(INK), 'it is never a fallback');
  check(defaultModel(catalog, 'designer') !== INK, 'it is never picked by default (opt in after reading its terms)');
  check(!modelsForJob(catalog, 'engineer').some((m) => m.id === INK) && modelsForJob(catalog, 'designer').some((m) => m.id === INK), 'it is offered for the Designer only');
}

// ---------------------------------------------------------------- 8. streaming
console.log('\n--- streaming');
{
  // A streamed reply: reasoning, text, and a submit_craft call whose arguments arrive in pieces.
  const args = JSON.stringify({ craft: { name: 'S', formatVersion: 1, parts: LIGHT_CAR.parts.slice(0, 3) } });
  const cut = [0, 40, 130, 260, args.length];
  const events = [
    { choices: [{ delta: { reasoning: 'Thinking about ' } }] },
    { choices: [{ delta: { reasoning: 'a car.' } }] },
    { choices: [{ delta: { content: 'Drafting.' } }] },
    ...cut.slice(1).map((end, i) => ({ choices: [{ delta: { tool_calls: [{ index: 0, ...(i === 0 ? { id: 'call_1', function: { name: 'submit_craft', arguments: args.slice(cut[i], end) } } : { function: { arguments: args.slice(cut[i], end) } }) }] } }] })),
    { choices: [{ delta: {} }], usage: { prompt_tokens: 10, completion_tokens: 20, cost: 0.0001 } },
  ];
  const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('') + ': OPENROUTER PROCESSING\n\ndata: [DONE]\n\n';
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new ReadableStream({
    start(c) { const b = new TextEncoder().encode(sse); for (let i = 0; i < b.length; i += 97) c.enqueue(b.slice(i, i + 97)); c.close(); },
  }), { status: 200 })) as typeof fetch;
  const deltas: string[] = [];
  const res = await new Client({ baseUrl: 'http://stub' }).chat({ model: 'm', messages: [], tools: [], onDelta: (d) => deltas.push(d.kind === 'tool' ? `tool:${d.name}:${d.args.length}` : `${d.kind}:${d.text}`) });
  globalThis.fetch = realFetch;
  check(res.reasoning === 'Thinking about a car.' && deltas[0] === 'reasoning:Thinking about ', 'reasoning streams in as it arrives', res.reasoning);
  check(deltas.includes('content:Drafting.'), 'visible text streams too');
  check(res.toolCalls.length === 1 && res.toolCalls[0].function.name === 'submit_craft' && res.toolCalls[0].function.arguments === args, 'a tool call assembled from pieces', `${deltas.filter((d) => d.startsWith('tool')).length} tool deltas`);
  check(Math.abs(res.usage.cost - 0.0001) < 1e-9, 'usage from the last chunk');
  // Parts appear one by one while the arguments are still incomplete.
  // Cut just before and just after the end of each part's JSON.
  const ends = LIGHT_CAR.parts.slice(0, 3).map((p) => args.indexOf(JSON.stringify(p)) + JSON.stringify(p).length);
  const counts = [ends[0] - 1, ends[0], ends[1] - 1, ends[1], ends[2]].map((n) => partialParts(args.slice(0, n)).length);
  check(counts.join(',') === '0,1,1,2,3', 'the turntable gets each part as soon as it is complete', counts.join(','));
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
