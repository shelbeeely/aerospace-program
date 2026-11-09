/**
 * Offline tests for the craft-design pipeline (no network): a scripted fake model client
 * stands in for OpenRouter. Run with `npm run design-pipeline`.
 *
 * 1. autoFix leaves every built-in alone and repairs flipped control gains and silly springs.
 * 2. Parallel drafts: the best draft is kept, and a draft with flipped control signs is
 *    auto-fixed and still passes its flight test.
 * 3. An engineer round gets the flight report plus the list of automatic corrections.
 */
import { BLIMP, BUILTINS, HELICOPTER } from '../src/craft/builtins.ts';
import { TEST_PLANE } from '../src/craft/testPlane.ts';
import type { CraftDef } from '../src/craft/types.ts';
import { autoFix } from '../src/gen/autofix.ts';
import { designCraft } from '../src/gen/craftDesigner.ts';
import type { ChatMessage, OpenRouter } from '../src/gen/openrouter.ts';
import { initPhysics } from '../src/sim/Simulation.ts';

await initPhysics();
let failed = 0;
const check = (ok: boolean, label: string, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail ? ` - ${detail}` : ''}`);
  if (!ok) failed++;
};

const flipped = (c: CraftDef): CraftDef => {
  const d = structuredClone(c);
  for (const p of d.parts) for (const m of p.modules ?? []) if (m.type === 'aero' && m.control && m.control.channel !== 'flaps') m.control.gain *= -1;
  return d;
};

// ---------------------------------------------------------------- 1. autoFix
console.log('--- autoFix');
for (const c of [...BUILTINS.map((b) => b.craft), HELICOPTER, BLIMP]) check(autoFix(c).fixes.length === 0, `${c.name}: no changes`, autoFix(c).fixes.join('; '));
{
  const { craft, fixes } = autoFix(flipped(TEST_PLANE));
  check(fixes.length === 4 && JSON.stringify(craft) === JSON.stringify(TEST_PLANE), 'flipped elevator, ailerons and rudder are put back', fixes.join('; '));
  const soft = structuredClone(TEST_PLANE);
  for (const p of soft.parts) for (const m of p.modules ?? []) if (m.type === 'wheel') m.stiffness = 50;
  const sf = autoFix(soft);
  check(sf.fixes.filter((f) => f.includes('stiffness')).length >= 3, 'mushy wheel springs are resized', sf.fixes.join('; '));
}

// ---------------------------------------------------------------- fake client
type Script = (messages: ChatMessage[], temperature: number) => string;
const fakeClient = (script: Script) => {
  const log: ChatMessage[][] = [];
  const client = {
    async chat(req: { messages: ChatMessage[]; temperature?: number; model: string }) {
      log.push(req.messages.map((m) => ({ ...m })));
      return { model: req.model, content: script(req.messages, req.temperature ?? 0), images: [], audio: [], reasoning: '', usage: { promptTokens: 0, completionTokens: 0, cost: 0.001 } };
    },
  } as unknown as OpenRouter;
  return { client, log };
};
const reply = (c: CraftDef) => JSON.stringify({ name: c.name, notes: 'test', craft: c });

// ---------------------------------------------------------------- 2. parallel drafts
console.log('\n--- parallel drafts');
{
  // Draft 1 (low temperature): broken JSON. Draft 2: the trainer with every control sign flipped.
  const { client, log } = fakeClient((_m, t) => (t < 0.5 ? '{"name": "oops", "craft": {' : reply(flipped(TEST_PLANE))));
  const r = await designCraft(client, { model: 'fake/designer', prompt: 'a trainer', drafts: 2, maxIterations: 3 });
  check(log.length === 2, 'two drafts, no repair round needed', `${log.length} model calls`);
  check(r.report.passed, 'the auto-fixed draft passes its flight test', `score ${r.report.score}`);
  check(r.attempts.some((a) => (a.fixes?.length ?? 0) === 4), 'the attempt records the four sign fixes');
  check(autoFix(r.craft).fixes.length === 0, 'the saved craft is the corrected one');
}

// ---------------------------------------------------------------- 3. repair round sees fixes
console.log('\n--- engineer round');
{
  // A flipped, grossly underpowered trainer fails; the engineer then sends the real one.
  const weak = flipped(TEST_PLANE);
  for (const p of weak.parts) for (const m of p.modules ?? []) if (m.type === 'engine') m.maxThrust *= 0.15;
  const { client, log } = fakeClient((m) => (m.length <= 2 ? reply(weak) : reply(TEST_PLANE)));
  const r = await designCraft(client, { model: 'fake/designer', engineerModel: 'fake/engineer', prompt: 'a trainer', drafts: 1, maxIterations: 3 });
  const last = log[1]?.at(-1)?.content;
  const second = typeof last === 'string' ? last : JSON.stringify(last ?? '');
  check(log.length === 2 && r.report.passed, 'the engineer round fixes it', `${log.length} calls, score ${r.report.score}`);
  check(second.includes('Automated flight test results') && second.includes('automatic corrections'), 'the engineer sees the report and the auto-fixes');
}

if (failed) {
  console.error(`\n${failed} design-pipeline check(s) failed`);
  process.exit(1);
}
console.log('\nall design-pipeline checks passed');
