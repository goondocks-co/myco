import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  GLOBAL_HOOK_LAUNCHER_FILENAME,
  GLOBAL_MCP_LAUNCHER_FILENAME,
  removeRetiredGlobalLaunchers,
} from '@myco/grove/launcher-cleanup.js';
import { claimSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '@myco/grove/subsystem-claim.js';
import { daemonIdentity } from '@myco/grove/paths.js';

describe('removeRetiredGlobalLaunchers', () => {
  let mycoHome: string;

  beforeEach(() => {
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-launcher-cleanup-'));
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });

  it('deletes both retired launcher files when present', () => {
    const launcherPath = path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME);
    const mcpLauncherPath = path.join(mycoHome, GLOBAL_MCP_LAUNCHER_FILENAME);
    fs.writeFileSync(launcherPath, '// stale launcher\n');
    fs.writeFileSync(mcpLauncherPath, '// stale mcp launcher\n');

    const report = removeRetiredGlobalLaunchers(mycoHome);

    expect(report.removed).toEqual([launcherPath, mcpLauncherPath]);
    expect(fs.existsSync(launcherPath)).toBe(false);
    expect(fs.existsSync(mcpLauncherPath)).toBe(false);
  });

  it('removes only the launcher file that is present, leaving the report accurate', () => {
    const launcherPath = path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME);
    fs.writeFileSync(launcherPath, '// stale launcher\n');

    const report = removeRetiredGlobalLaunchers(mycoHome);

    expect(report.removed).toEqual([launcherPath]);
    expect(fs.existsSync(launcherPath)).toBe(false);
  });

  it('is a no-op when neither launcher file exists', () => {
    const report = removeRetiredGlobalLaunchers(mycoHome);
    expect(report.removed).toEqual([]);
  });

  it('is idempotent — a second cleanup pass removes nothing', () => {
    fs.writeFileSync(path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME), '// stale\n');
    fs.writeFileSync(path.join(mycoHome, GLOBAL_MCP_LAUNCHER_FILENAME), '// stale\n');

    removeRetiredGlobalLaunchers(mycoHome);
    const second = removeRetiredGlobalLaunchers(mycoHome);

    expect(second.removed).toEqual([]);
  });

  it('defers (deletes nothing) when a peer owns the symbiont-config claim', () => {
    const launcherPath = path.join(mycoHome, GLOBAL_HOOK_LAUNCHER_FILENAME);
    fs.writeFileSync(launcherPath, '// stale launcher\n');

    // shouldDeferSubsystem reads the ambient env: self = daemonIdentity(MYCO_HOME),
    // claim from MYCO_CLAIMS_HOME. Point both at sandboxes and let a PEER home own it.
    const claimsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cleanup-claims-'));
    const peer = daemonIdentity(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cleanup-peer-')));
    claimSubsystem(SYMBIONT_CONFIG_SUBSYSTEM, peer, { claimsHome });

    const prevHome = process.env.MYCO_HOME;
    const prevClaims = process.env.MYCO_CLAIMS_HOME;
    process.env.MYCO_HOME = mycoHome;
    process.env.MYCO_CLAIMS_HOME = claimsHome;
    try {
      const report = removeRetiredGlobalLaunchers(mycoHome);
      expect(report.removed).toEqual([]);
      expect(fs.existsSync(launcherPath)).toBe(true); // deferred — file untouched
    } finally {
      if (prevHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevHome;
      if (prevClaims === undefined) delete process.env.MYCO_CLAIMS_HOME; else process.env.MYCO_CLAIMS_HOME = prevClaims;
      fs.rmSync(claimsHome, { recursive: true, force: true });
    }
  });
});
