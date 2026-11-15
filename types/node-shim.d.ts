/**
 * Minimal Node typings for the scripts and the dev-server plugin, so we don't need
 * @types/node as a dependency. Extend as scripts need more.
 */
declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  execPath: string;
  exit(code?: number): never;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string, options?: { flag?: string }): void;
  export function mkdirSync(path: string, opts?: { recursive?: boolean }): void;
  export function existsSync(path: string): boolean;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): { update(data: string): { digest(encoding: 'hex'): string } };
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function relative(from: string, to: string): string;
  export function resolve(...paths: string[]): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:child_process' {
  export function spawnSync(command: string, args: string[], options?: { cwd?: string; stdio?: 'inherit' | 'pipe' }): { status: number | null };
}
