/**
 * `myco-team host ...` is retired (decision-48174c9f): host operator
 * orchestration moved into the main `myco` binary. This surface must now be
 * a pure pointer — no orchestration, no side effects, regardless of the
 * subcommand given — that tells the operator where the real command lives.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runHostCommand } from '../../packages/myco-team/src/host/cli.js';
import { readHostState } from '@myco/team-host/state.js';

describe('myco-team host — deprecation pointer', () => {
  let tmp: string;
  let prevTeam: string | undefined;
  let prevExit: typeof process.exit;
  let err: string[];
  let prevErr: typeof console.error;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-host-pointer-'));
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team');
    prevExit = process.exit;
    process.exit = ((code?: number) => { throw new Error(`exit(${code})`); }) as typeof process.exit;
    err = [];
    prevErr = console.error;
    console.error = ((...a: unknown[]) => err.push(a.map(String).join(' '))) as typeof console.error;
  });
  afterEach(() => {
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    process.exit = prevExit;
    console.error = prevErr;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('enable prints the pointer to `myco host` and exits nonzero — no host state written', async () => {
    await expect(runHostCommand(['enable', '--server-url', 'https://host.example:8080'])).rejects.toThrow(/exit\([1-9]\d*\)/);
    expect(err.join('\n')).toMatch(/moved to `myco host/);
    expect(readHostState()).toBeNull();
  });

  it('a bare invocation also prints the pointer and exits nonzero', async () => {
    await expect(runHostCommand([])).rejects.toThrow(/exit\([1-9]\d*\)/);
    expect(err.join('\n')).toMatch(/moved to `myco host/);
  });

  it('every subcommand shape (status/disable/key/devices/bearer) hits the same pointer, never orchestrates', async () => {
    for (const args of [['status'], ['disable'], ['key', 'mint'], ['devices', 'list'], ['bearer', 'rotate'], ['--help']]) {
      err = [];
      await expect(runHostCommand(args)).rejects.toThrow(/exit\([1-9]\d*\)/);
      expect(err.join('\n')).toMatch(/moved to `myco host/);
    }
    expect(readHostState()).toBeNull();
  });
});
