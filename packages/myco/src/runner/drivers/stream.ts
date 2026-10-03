/**
 * Reading a harness's stdout as lines, and starting one.
 *
 * Every driver spawns the same way and for the same reasons. Stdin is closed:
 * a harness that reads standard input waits on it forever when a worker leaves
 * it open, whatever else it was given. Stderr is captured rather than inherited,
 * up to `MAX_STDERR_CHARS`, so a harness's diagnostics are read for the run's
 * coded reason and kept in the worker's local diagnostics log under the run they
 * belong to; they never reach the Deployment. The harness
 * leads a process group of its own (`process-group.ts`): stopping it, and its
 * exit, end every helper it started.
 */
import { spawnGroup, stopGroup } from '../process-group.js';

export interface Started {
  /** Every complete line the harness wrote to stdout, in order. */
  lines: AsyncIterable<string>;
  /** The first `MAX_STDERR_CHARS` the harness wrote to stderr, read for a coded reason and kept only on this machine. */
  errorText: () => string;
  exit: Promise<number>;
  /** The signal that ended the harness, once it has exited on one; null otherwise. */
  signal: () => string | null;
  kill: () => void;
}

/** How much of what a harness writes to stderr a worker holds. */
export const MAX_STDERR_CHARS = 64 * 1024;

/** Stderr written so far with this chunk added, held to `MAX_STDERR_CHARS`. */
export const heldStderr = (held: string, chunk: string): string => (held.length >= MAX_STDERR_CHARS ? held : (held + chunk).slice(0, MAX_STDERR_CHARS));

/** The environment a harness process gets: the worker's own without `omitInherited`, with `env` over it. */
export function launchEnvironment(env: Record<string, string>, omitInherited: readonly string[] = []): NodeJS.ProcessEnv {
  const inherited = { ...process.env };
  for (const key of omitInherited) delete inherited[key];
  return { ...inherited, ...env };
}

export function startHarness(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; signal: AbortSignal; omitInherited?: readonly string[] }): Started {
  const child = spawnGroup(command, args, {
    cwd: options.cwd,
    env: launchEnvironment(options.env, options.omitInherited),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  let ended: string | null = null;
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { errors = heldStderr(errors, chunk); });
  const kill = (): void => { void stopGroup(child); };
  options.signal.addEventListener('abort', kill, { once: true });

  const exit = new Promise<number>((resolve) => {
    child.once('close', (code, signal) => { ended = signal; options.signal.removeEventListener('abort', kill); void stopGroup(child); resolve(code ?? -1); });
    child.once('error', () => { options.signal.removeEventListener('abort', kill); resolve(-1); });
  });

  async function* lines(): AsyncIterable<string> {
    let held = '';
    child.stdout?.setEncoding('utf8');
    for await (const chunk of child.stdout ?? []) {
      held += chunk as string;
      let at = held.indexOf('\n');
      while (at >= 0) {
        const line = held.slice(0, at).trim();
        held = held.slice(at + 1);
        if (line.length > 0) yield line;
        at = held.indexOf('\n');
      }
    }
    if (held.trim().length > 0) yield held.trim();
  }

  return { lines: lines(), errorText: () => errors, exit, signal: () => ended, kill };
}

/** One JSON value per line, skipping anything a harness writes that is not one. */
export async function* jsonLines(lines: AsyncIterable<string>): AsyncIterable<Record<string, unknown>> {
  for await (const line of lines) {
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) yield parsed as Record<string, unknown>;
    } catch { /* a harness writes prose to stdout beside its stream; the stream is what is read */ }
  }
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);
export const stringOf = text;
export const recordOf = (value: unknown): Record<string, unknown> | null =>
  (value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null);
export const numberOf = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
