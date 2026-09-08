/**
 * Reading a harness's stdout as lines, and starting one.
 *
 * Every driver spawns the same way and for the same reasons. Stdin is closed:
 * a harness that reads standard input waits on it forever when a worker leaves
 * it open, whatever else it was given. Stderr is captured rather than inherited
 * so a harness's diagnostics reach the run's failure record instead of the
 * worker's own log, where nothing would attribute them to a run.
 */
import { spawn } from 'node:child_process';

export interface Started {
  /** Every complete line the harness wrote to stdout, in order. */
  lines: AsyncIterable<string>;
  /** What the harness wrote to stderr, for a failure record. */
  errorText: () => string;
  exit: Promise<number>;
  kill: () => void;
}

export function startHarness(command: string, args: readonly string[], options: { cwd: string; env: Record<string, string>; signal: AbortSignal }): Started {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let errors = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => { errors += chunk; });
  const kill = (): void => { child.kill('SIGTERM'); };
  options.signal.addEventListener('abort', kill, { once: true });

  const exit = new Promise<number>((resolve) => {
    child.once('close', (code) => { options.signal.removeEventListener('abort', kill); resolve(code ?? -1); });
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

  return { lines: lines(), errorText: () => errors, exit, kill };
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
