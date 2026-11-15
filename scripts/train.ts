/**
 * Retrain the NPC networks whose weights are stale. Run with `npm run train`.
 *
 * Each trainer stamps its weights with a fingerprint of the code it ran (scripts/lib/
 * fingerprint.ts). Here every trainer's code is fingerprinted again; where that no longer
 * matches what its weights carry, the trainer runs. Training is deterministic, so retraining
 * code that behaves the same writes the same weights.
 *
 *   npm run train              retrain what is stale
 *   npm run train -- --check   list what is stale and exit 1 if anything is (CI, checks)
 *   npm run train -- --all     retrain everything
 */
import { spawnSync } from 'node:child_process';
import { freshness } from './lib/trainers.ts';
import { ROOT } from './lib/fingerprint.ts';

const check = process.argv.includes('--check');
const all = process.argv.includes('--all');

const list = freshness();
for (const f of list) {
  if (!f.stale) { console.log(`${f.trainer.name}: fresh (${f.stamp.fingerprint})`); continue; }
  const why = f.reasons.length > 6 ? [...f.reasons.slice(0, 6), `and ${f.reasons.length - 6} more`] : f.reasons;
  console.log(`${f.trainer.name}: STALE (${f.trainer.outputs.join(', ')}): ${why.join('; ')}`);
}
const todo = list.filter((f) => all || f.stale);
if (check) process.exit(todo.length && !all ? 1 : 0);
if (!todo.length) { console.log('Every network is fresh; nothing to retrain.'); process.exit(0); }

for (const f of todo) {
  console.log(`\n--- npm run ${f.trainer.name}`);
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--experimental-transform-types', '--no-warnings', f.trainer.script], { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) { console.error(`${f.trainer.name} failed (exit ${r.status})`); process.exit(1); }
  console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
}
const after = freshness().filter((f) => f.stale);
if (after.length) {
  console.error(`Still stale after training: ${after.map((f) => f.trainer.name).join(', ')}`);
  process.exit(1);
}
console.log(`\nRetrained ${todo.map((f) => f.trainer.name).join(', ')}; every network is fresh.`);
