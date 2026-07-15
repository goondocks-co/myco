import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runHostCommand } from '@myco/cli/host.js';
import { resolveTeamKeyProviderFlag } from '@myco/team-host/compose.js';
import { readHostState } from '@myco/team-host/state.js';

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
    expect(out.join('\n')).toMatch(/Usage: myco host/);
  });

  // ---------------------------------------------------------------------
  // --team-key-provider validation (Task 8 fix round 1): an unrecognized
  // value must fail loudly BEFORE any enable/mint/store side effect, never
  // silently fall through to the anthropic default.
  // ---------------------------------------------------------------------

  it('enable --emit-join with an unrecognized --team-key-provider exits 2 before any orchestration, no key stored, no enable side effects', async () => {
    await expect(runHostCommand([
      'enable', '--server-url', 'https://host.example:8080', '--emit-join',
      '--team-key', 'sk-should-never-be-stored', '--team-key-provider', 'openrouttr',
    ])).rejects.toThrow('exit(2)');

    expect(err.join('\n')).toMatch(/Unrecognized --team-key-provider "openrouttr"/);
    expect(err.join('\n')).toMatch(/anthropic, openai, openrouter/);
    // Never reached hostEnable — no host state was ever written.
    expect(readHostState()).toBeNull();
    // Never printed a success line for the (never-run) enable.
    expect(out.join('\n')).not.toMatch(/Team Host enabled/);
  });

  it('enable --emit-join with --team-key-provider toString (an inherited Object.prototype key) is rejected, not silently accepted via bare `in`', async () => {
    await expect(runHostCommand([
      'enable', '--server-url', 'https://host.example:8080', '--emit-join',
      '--team-key', 'sk-should-never-be-stored', '--team-key-provider', 'toString',
    ])).rejects.toThrow('exit(2)');

    expect(err.join('\n')).toMatch(/Unrecognized --team-key-provider "toString"/);
    expect(readHostState()).toBeNull();
  });

  it('resolveTeamKeyProviderFlag: absent flag keeps the anthropic default (returns undefined)', () => {
    expect(resolveTeamKeyProviderFlag(undefined)).toBeUndefined();
  });

  it('resolveTeamKeyProviderFlag: a valid non-default provider (openai) passes through unchanged', () => {
    // Storage under the provider-standard env name is covered end-to-end by
    // tests/host/serve-install-flow.test.ts's "(d) --team-key-provider
    // selects a different provider-standard storage name" — this pins the
    // CLI-layer validation step that feeds it.
    expect(resolveTeamKeyProviderFlag('openai')).toBe('openai');
  });

  it('resolveTeamKeyProviderFlag: unrecognized values throw listing all valid providers', () => {
    expect(() => resolveTeamKeyProviderFlag('openrouttr')).toThrow(/Unrecognized --team-key-provider "openrouttr".*anthropic, openai, openrouter/s);
  });

  it('resolveTeamKeyProviderFlag: inherited Object.prototype keys are rejected (own-property check, not bare `in`)', () => {
    expect(() => resolveTeamKeyProviderFlag('toString')).toThrow(/Unrecognized --team-key-provider "toString"/);
    expect(() => resolveTeamKeyProviderFlag('hasOwnProperty')).toThrow(/Unrecognized --team-key-provider "hasOwnProperty"/);
  });
});
