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
  const res = await designCraft(stub, { model: 'stub/model', prompt: 'a light car', maxIterations: 2 });
  check(res.attempts[0].validationErrors?.some((e) => /drone\.pod.*floating/.test(e)) ?? false, 'a floating part is rejected', res.attempts[0].validationErrors?.[0] ?? 'not rejected');
  check(/floating/.test(seen[1] ?? ''), 'the model is told which part floats');
  check(res.report.vehicle === 'ground' && res.attempts.length === 2, 'the corrected ground vehicle is accepted and tested', `${res.report.vehicle} ${res.report.score}/100`);
}

// ---------------------------------------------------------------- 4. prompt and ground card
console.log('\n--- prompt');
for (const [k, re] of [['ground vehicles', /Ground vehicles:/], ['skid steering', /"skid"/], ['stabilizer', /"type":"stabilizer"/], ['visual language', /1982 TRON/], ['connectivity', /ONE connected piece/], ['light cycle reference', /Light cycle \(two wheels/], ['inventiveness', /Be inventive/]] as const) {
  check(re.test(DESIGNER_SYSTEM_PROMPT), `the designer prompt covers ${k}`);
}
{
  const r = await flightTest(LIGHT_CAR);
  check(r.vehicle === 'ground' && r.passed, 'a ground vehicle passes the design pipeline\'s test card', `${r.vehicle} ${r.score}/100`);
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
