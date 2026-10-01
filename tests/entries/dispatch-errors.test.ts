/**
 * A compiled binary's dispatcher reports a failure as the CLI does (#1561 PR 1): `myco: <message>` on stderr and exit
 * 1, not a stack. Each case runs the dispatcher in its own process, as a per-target entry runs it.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DISPATCH = path.resolve(import.meta.dir, '..', '..', 'packages', 'myco', 'src', 'entries', 'dispatch.ts');

function runEntry(body: string, argv: string[]): { status: number | null; stderr: string } {
  // Under /tmp: a macOS per-user $TMPDIR can make every process started in it slow to launch.
  const dir = fs.mkdtempSync(path.join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'myco-dispatch-'));
  const entry = path.join(dir, 'entry.ts');
  fs.writeFileSync(entry, `import { dispatch } from ${JSON.stringify(DISPATCH)};\n${body}\n`);
  const home = path.join(dir, 'home');
  fs.mkdirSync(home);
  const run = spawnSync(process.execPath, [entry, ...argv], { cwd: dir, env: { ...process.env, MYCO_HOME: home }, encoding: 'utf-8', timeout: 60_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return { status: run.status, stderr: run.stderr };
}

describe('the compiled dispatcher', () => {
  it('reports a failure before the CLI loads as one line and exits 1', () => {
    const run = runEntry(`await dispatch(async () => { throw new Error('the native artifacts could not be written'); });`, ['status']);
    expect(run).toEqual({ status: 1, stderr: 'myco: the native artifacts could not be written\n' });
  }, 60_000);

  it('reports a thrown value that is not an Error the same way', () => {
    const run = runEntry(`await dispatch(async () => { throw 'no space left'; });`, ['status']);
    expect(run).toEqual({ status: 1, stderr: 'myco: no space left\n' });
  }, 60_000);
});
