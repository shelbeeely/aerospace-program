/**
 * The trainers, what they write, and whether what they wrote is stale.
 *
 * A weights file is fresh when the stamp it carries (`trained.fingerprint`, written by its
 * trainer) matches a fingerprint of the trainer's code now (scripts/lib/fingerprint.ts).
 * `npm run train` runs the stale trainers; `npm run scenario` (and CI) refuse stale weights.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { changes, ROOT, stampOf, type Stamp } from './fingerprint.ts';

export interface Trainer {
  /** The npm script that runs it. */
  name: string;
  script: string;
  /** The weights files it writes. */
  outputs: string[];
}

export const TRAINERS: readonly Trainer[] = [
  { name: 'train-drive', script: 'scripts/trainDrive.ts', outputs: ['src/brain/weights/drive.json'] },
  { name: 'train-squad', script: 'scripts/trainSquad.ts', outputs: ['src/brain/weights/squad.json', 'src/brain/weights/drone.json'] },
  { name: 'train-civil', script: 'scripts/trainCivil.ts', outputs: ['src/brain/weights/civil.json'] },
];

export interface Freshness {
  trainer: Trainer;
  stale: boolean;
  /** Why it is stale: the outputs missing or what changed in the code. */
  reasons: string[];
  stamp: Stamp;
}

function storedStamp(path: string): Partial<Stamp> | undefined {
  const full = resolve(ROOT, path);
  if (!existsSync(full)) return undefined;
  try {
    const t = JSON.parse(readFileSync(full, 'utf8'))?.trained;
    return t && typeof t === 'object' ? { fingerprint: t.fingerprint, sources: t.sources } : undefined;
  } catch {
    return undefined;
  }
}

/** Every trainer's freshness (each output must carry the trainer's current fingerprint). */
export function freshness(): Freshness[] {
  return TRAINERS.map((trainer) => {
    const stamp = stampOf(trainer.script);
    const reasons = new Set<string>();
    for (const out of trainer.outputs) {
      if (!existsSync(resolve(ROOT, out))) { reasons.add(`${out} is missing`); continue; }
      const stored = storedStamp(out);
      if (stored?.fingerprint === stamp.fingerprint) continue;
      for (const c of changes(stored, stamp)) reasons.add(c);
      if (!reasons.size) reasons.add(`${out} carries another fingerprint`);
    }
    return { trainer, stale: reasons.size > 0, reasons: [...reasons], stamp };
  });
}
