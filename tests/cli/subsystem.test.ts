import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/subsystem';
import { readClaim, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/daemon/subsystem-claim.js';

// `myco subsystem <claim|release|list>` — operator-driven, durable ownership.
// The owner recorded is this build's daemon variant (MYCO_SERVICE_VARIANT), so
// the test drives it via env to stand in for the dogfood vs production build.

describe('myco subsystem', () => {
  let mycoHome: string;
  let logged: string[];
  let originalLog: typeof console.log;
  const envKeys = ['MYCO_HOME', 'MYCO_SERVICE_VARIANT'] as const;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-subsystem-cli-'));
    savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
    process.env.MYCO_HOME = mycoHome;
    logged = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = originalLog;
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k];
    }
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('claim under the dev build records service-dev ownership', async () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)?.owner).toBe('service-dev');
    expect(logged.join('\n')).toContain('Claimed symbiont-config for service-dev');
  });

  it('list shows an active claim', async () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    logged = [];
    await run(['list']);
    expect(logged.join('\n')).toContain('symbiont-config → service-dev');
  });

  it('list reports nothing when no claims exist', async () => {
    await run(['list']);
    expect(logged.join('\n')).toContain('No subsystem claims.');
  });

  it('release frees a claim the same variant owns', async () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    await run(['release', SYMBIONT_CONFIG_SUBSYSTEM]);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)).toBeNull();
  });

  it('release from a different variant is refused (claim stands)', async () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    await expect(run(['release', SYMBIONT_CONFIG_SUBSYSTEM])).rejects.toThrow(/claimed by service-dev/);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)?.owner).toBe('service-dev');
  });

  it('claiming a subsystem a peer already owns is refused without --force', async () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    process.env.MYCO_SERVICE_VARIANT = 'prod';
    await expect(run(['claim', SYMBIONT_CONFIG_SUBSYSTEM])).rejects.toThrow(/already claimed by service-dev/);
    // --force takes it over.
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM, '--force']);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)?.owner).toBe('service');
  });

  it('an unknown subsystem name is rejected', async () => {
    process.env.MYCO_SERVICE_VARIANT = 'dev';
    await expect(run(['claim', 'not-a-subsystem'])).rejects.toThrow(/Unknown subsystem/);
  });
});
