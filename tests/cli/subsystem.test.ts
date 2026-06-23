import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { run } from '@myco/cli/subsystem';
import { readClaim, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/grove/subsystem-claim.js';

// `myco subsystem <claim|release|list>` — operator-driven, durable ownership.
// The owner recorded is this daemon's home (MYCO_HOME), an opaque token; the
// claim file lives in that home's claims/ area. Cross-owner contention (one
// daemon defers to another's claim) is exercised at the primitive level in
// tests/daemon/subsystem-claim.test.ts, which can drive two distinct owner
// tokens against one claims dir.

describe('myco subsystem', () => {
  let mycoHome: string;
  let logged: string[];
  let originalLog: typeof console.log;
  let savedHome: string | undefined;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-subsystem-cli-'));
    savedHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    logged = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => { logged.push(args.join(' ')); };
  });

  afterEach(() => {
    console.log = originalLog;
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('claim records the running daemon home as owner', async () => {
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)?.owner).toBe(mycoHome);
    expect(logged.join('\n')).toContain(`Claimed symbiont-config for ${mycoHome}`);
  });

  it('list shows an active claim', async () => {
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    logged = [];
    await run(['list']);
    expect(logged.join('\n')).toContain(`symbiont-config → ${mycoHome}`);
  });

  it('list reports nothing when no claims exist', async () => {
    await run(['list']);
    expect(logged.join('\n')).toContain('No subsystem claims.');
  });

  it('release frees a claim the same home owns', async () => {
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    await run(['release', SYMBIONT_CONFIG_SUBSYSTEM]);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)).toBeNull();
  });

  it('re-claiming the same subsystem from the same home just refreshes the marker', async () => {
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    await run(['claim', SYMBIONT_CONFIG_SUBSYSTEM]);
    expect(readClaim(SYMBIONT_CONFIG_SUBSYSTEM, mycoHome)?.owner).toBe(mycoHome);
  });

  it('an unknown subsystem name is rejected', async () => {
    await expect(run(['claim', 'not-a-subsystem'])).rejects.toThrow(/Unknown subsystem/);
  });
});
