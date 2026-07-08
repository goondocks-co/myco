import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runHostCommand } from '../../packages/myco-team/src/host/cli.js';

describe('runHostCommand argv handling', () => {
  let tmp: string;
  let prevTeam: string | undefined;
  let prevExit: typeof process.exit;
  let out: string[];
  let err: string[];
  let prevLog: typeof console.log;
  let prevErr: typeof console.error;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-cli-'));
    prevTeam = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = path.join(tmp, 'team');
    prevExit = process.exit;
    process.exit = ((code?: number) => { throw new Error(`exit(${code})`); }) as typeof process.exit;
    out = []; err = [];
    prevLog = console.log; prevErr = console.error;
    console.log = ((...a: unknown[]) => out.push(a.map(String).join(' '))) as typeof console.log;
    console.error = ((...a: unknown[]) => err.push(a.map(String).join(' '))) as typeof console.error;
  });
  afterEach(() => {
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    process.exit = prevExit;
    console.log = prevLog; console.error = prevErr;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('enable without --server-url exits 2 before any orchestration', async () => {
    await expect(runHostCommand(['enable', '--hostname', 'x'])).rejects.toThrow('exit(2)');
    expect(err.join('\n')).toMatch(/requires --server-url/);
  });

  it('status reports not-a-host when no state exists', async () => {
    await runHostCommand(['status']);
    expect(out.join('\n')).toMatch(/not a Team Host/);
  });

  it('an unknown subcommand exits 1 with help', async () => {
    await expect(runHostCommand(['frobnicate'])).rejects.toThrow('exit(1)');
    expect(err.join('\n')).toMatch(/Unknown host command/);
  });

  it('bare host prints help and exits 2', async () => {
    await expect(runHostCommand([])).rejects.toThrow('exit(2)');
    expect(out.join('\n')).toMatch(/Usage: myco-team host/);
  });
});
