/**
 * Generate a craft from a description, flight-test it, iterate, and save it.
 *
 *   npm run design -- "a stubby twin-boom cargo plane" [--designer id] [--engineer id] [--rounds 4] [--drafts 2] [--base crafts/x.json] [--agent] [--no-detail]
 *
 * --agent: the designer runs the whole pipeline with tools (submit, check, analyze, patch,
 * flight test, add detail, finish); models without tool calling fall back to the fixed rounds.
 *
 * Needs OPENROUTER_API_KEY in the environment (or a proxy that injects it).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { JOBS } from '../src/gen/catalog.ts';
import { designCraft } from '../src/gen/craftDesigner.ts';
import { designWithAgent } from '../src/gen/agent.ts';
import { OpenRouter } from '../src/gen/openrouter.ts';
import { flightTest, formatReport } from '../src/sim/flightTest.ts';
import { initPhysics } from '../src/sim/Simulation.ts';

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
// Free crew by default; any OpenRouter model id works.
const model = opt('designer') ?? opt('model') ?? JOBS.designer.free[0];
const engineer = opt('engineer') ?? JOBS.engineer.free[0];
const backups = (list: string[], primary: string) => list.filter((m) => m !== primary).slice(0, 2);
const rounds = Number(opt('rounds') ?? 4);
const drafts = Number(opt('drafts') ?? 2);
const basePath = opt('base');
const flag = (name: string) => { const i = args.indexOf(`--${name}`); if (i >= 0) args.splice(i, 1); return i >= 0; };
const agent = flag('agent');
const detail = !flag('no-detail');
const prompt = args.join(' ').trim();
if (!prompt) {
  console.error('usage: npm run design -- "description" [--designer id] [--engineer id] [--rounds n] [--drafts n] [--base file.json]');
  process.exit(1);
}

await initPhysics();
const client = new OpenRouter({
  baseUrl: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY ?? 'injected-by-proxy',
});
const base = basePath ? JSON.parse(readFileSync(basePath, 'utf8')).craft ?? undefined : undefined;

const t0 = Date.now();
const models = agent ? await client.models().catch(() => []) : [];
const design = agent
  ? (r: Parameters<typeof designCraft>[1]) => designWithAgent(client, { ...r, modelInfo: models.find((m) => m.id === model) }, (e) => console.log(`  agent ${e.turn} · ${e.name}: ${e.summary}`))
  : (r: Parameters<typeof designCraft>[1]) => designCraft(client, r);
const result = await design({
  model,
  designerFallbacks: backups(JOBS.designer.free, model),
  engineerModel: engineer,
  engineerFallbacks: backups(JOBS.engineer.free, engineer),
  prompt,
  base,
  maxIterations: rounds,
  drafts,
  detail,
  // Also fly each attempt in a gusty crosswind; advisory only (the calm score decides pass/fail).
  tester: (craft) => flightTest(craft, { gusty: true }),
  onEvent: (e) => {
    if (e.type === 'status') console.log(`… ${e.message}`);
    else {
      const a = e.attempt;
      if (a.error) console.log(`  round ${a.iteration} ${a.role}${a.model ? ` (${a.model})` : ""}: ${a.error}`);
      else if (a.validationErrors) console.log(`  round ${a.iteration} ${a.role}${a.model ? ` (${a.model})` : ""}: ${a.validationErrors.length} validation errors, e.g. ${a.validationErrors[0]}`);
      else if (a.report) console.log(`  round ${a.iteration} ${a.role}${a.model ? ` (${a.model})` : ""}: "${a.craft?.name}" scored ${a.report.score}/100${a.report.gusty ? ` (gusty ${a.report.gusty.score}, advisory)` : ''}`);
    }
  },
});

console.log(`\n${result.name}: ${result.notes}\n`);
console.log(formatReport(result.report));
const slug = result.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'craft';
mkdirSync('crafts', { recursive: true });
const file = `crafts/${slug}.json`;
writeFileSync(
  file,
  JSON.stringify(
    {
      craft: result.craft,
      provenance: {
        model: result.model,
        prompt: result.prompt,
        notes: result.notes,
        score: result.report.score,
        rounds: result.attempts.length,
        costUsd: result.cost,
        createdAt: new Date().toISOString(),
      },
    },
    null,
    2,
  ),
);
console.log(`\nSaved ${file}  (${((Date.now() - t0) / 1000).toFixed(0)} s, $${result.cost.toFixed(4)})`);
