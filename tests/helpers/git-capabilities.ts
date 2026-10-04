import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

type GitProbe = (args: string[]) => { status: number | null; error?: Error };

export function supportsGitReftable(run: GitProbe = (args) => spawnSync('git', args, { stdio: 'ignore' })): boolean {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reftable-probe-'));
  try {
    const result = run(['init', '-q', '--ref-format=reftable', dir]);
    if (result.error) throw result.error;
    return result.status === 0;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
