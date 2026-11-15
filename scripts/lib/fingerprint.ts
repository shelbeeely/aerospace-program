/**
 * What a network was trained on: a fingerprint of the code its trainer runs.
 *
 * Start at a trainer script, follow its relative imports transitively, and hash each source as
 * TypeScript sees it with the comments and formatting printed away, so editing a comment or
 * re-wrapping a line never makes weights stale, while any change to what the code does does.
 * The weights files themselves are left out (they are the trainers' outputs; `scenario.ts`
 * imports `escort.ts`, which imports `squad.json`, and so on).
 *
 * Node-only (scripts and CI); the game never loads this.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WEIGHTS = resolve(ROOT, 'src/brain/weights');
/** The stamping tools themselves never change what a trainer learns. */
const TOOLS = resolve(ROOT, 'scripts/lib');
/** `from '…'`, `import '…'` and `import('…')`. */
const IMPORTS = /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(?\s*['"]([^'"]+)['"]/g;
const printer = ts.createPrinter({ removeComments: true });

/** Every source a script depends on (itself included), as paths relative to the repository. */
export function sourcesOf(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file) || file.startsWith(WEIGHTS) || file.startsWith(TOOLS)) return;
    seen.add(file);
    if (!/\.[cm]?[jt]s$/.test(file)) return;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(IMPORTS)) {
      const spec = m[1] ?? m[2];
      if (spec?.startsWith('.')) visit(resolve(dirname(file), spec));
    }
  };
  visit(resolve(ROOT, entry));
  return [...seen].map((f) => relative(ROOT, f)).sort();
}

/** A source as it behaves: TypeScript printed back without comments or the author's layout. */
export function behaviourOf(path: string): string {
  const text = readFileSync(resolve(ROOT, path), 'utf8');
  if (!/\.[cm]?[jt]s$/.test(path)) return text;
  const sf = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, ts.ScriptKind.TS);
  return printer.printFile(sf);
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export interface Stamp {
  /** One hash over every source below. */
  fingerprint: string;
  /** Each source's own hash (12 hex digits), so a stale report can say what changed. */
  sources: Record<string, string>;
}

/** The stamp a trainer writes into its weights. */
export function stampOf(entry: string): Stamp {
  const sources: Record<string, string> = {};
  for (const p of sourcesOf(entry)) sources[p] = sha(behaviourOf(p)).slice(0, 12);
  const fingerprint = sha(Object.entries(sources).map(([p, h]) => `${p} ${h}`).join('\n')).slice(0, 16);
  return { fingerprint, sources };
}

/** What changed between a stored stamp and now: sources added, removed or edited. */
export function changes(stored: Partial<Stamp> | undefined, now: Stamp): string[] {
  if (!stored?.sources) return ['no stamp (trained before stamps existed)'];
  const out: string[] = [];
  for (const [p, h] of Object.entries(now.sources)) {
    if (!(p in stored.sources)) out.push(`${p} (new)`);
    else if (stored.sources[p] !== h) out.push(p);
  }
  for (const p of Object.keys(stored.sources)) if (!(p in now.sources)) out.push(`${p} (gone)`);
  return out;
}
