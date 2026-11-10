/**
 * Minimal Node typings for the scripts and the dev-server plugin, so we don't need
 * @types/node as a dependency. Extend as scripts need more.
 */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exit(code?: number): never;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
}
