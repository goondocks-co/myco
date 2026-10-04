import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type GitProbe = (args: string[]) => { status: number | null; stderr?: string; signal?: string | null; error?: Error };
const GIT_USAGE_EXIT = 129;
const GIT_FATAL_EXIT = 128;

export function supportsGitReftable(run: GitProbe = (args) => spawnSync('git', args, {
  encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, stdio: ['ignore', 'ignore', 'pipe'],
})): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reftable-probe-'));
  try {
    const result = run(['init', '-q', '--ref-format=reftable', dir]);
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    const stderr = result.stderr ?? '';
    const unsupportedOption = result.status === GIT_USAGE_EXIT
      && /^error: unknown option ['`"]ref-format(?:=reftable)?['"]\r?$/m.test(stderr);
    const unsupportedFormat = result.status === GIT_FATAL_EXIT
      && /^fatal: unknown ref storage format 'reftable'\r?$/m.test(stderr);
    if (unsupportedOption || unsupportedFormat) return false;
    throw new Error(`Git reftable probe failed (exit ${result.status}, signal ${result.signal ?? 'none'}): ${stderr.trim()}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
