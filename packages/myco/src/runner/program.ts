/** Executable identity and runnable replacement admission for executor services. */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { programRuns, type ProgramProbe } from '../install/place-binary.js';

const VERSION_PROBE_TIMEOUT_MS = 30_000;

/** The installed program's reported version, or a surfaced launch refusal. */
export function runnerProgramVersion(file: string): string {
  const result = spawnSync(file, ['--version'], { cwd: path.dirname(file), encoding: 'utf8', timeout: VERSION_PROBE_TIMEOUT_MS });
  if (result.status !== 0) throw new Error(`cannot read runner program version: ${result.error?.message ?? result.stderr?.trim() ?? result.signal ?? result.status}`);
  const version = result.stdout.trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) throw new Error('runner program answered an invalid version');
  return version;
}

/** A replacement by rename or copy changes this file identity. */
export function executableIdentity(file: string): string | null {
  try {
    const stat = fs.statSync(file);
    return `${stat.dev}:${stat.ino}:${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

/** An executable replacement ends this process only after the replacement launches. */
export function sameProgram(
  file: string,
  identity = executableIdentity,
  runs: (file: string) => ProgramProbe = programRuns,
  log: (line: string) => void = () => {},
): () => boolean {
  const started = identity(file);
  let judged = started;
  return () => {
    const now = identity(file);
    if (started === null || now === null || now === started || now === judged) return true;
    judged = now;
    const probe = runs(file);
    if (probe.runs) return false;
    log(`the myco program on disk changed, and the new one does not run (${probe.detail}); staying on this one`);
    return true;
  };
}
