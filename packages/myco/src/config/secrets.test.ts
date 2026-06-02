/**
 * Tests for legacy project-secrets relocation.
 *
 * The provider-secrets dashboard dropped the `project` scope, so a project
 * vault's `secrets.env` is no longer readable/maskable/deletable from the
 * UI. The one-shot, sentinel-gated global-install migration relocates and
 * purges any project `secrets.env` it finds — but ONLY once per project.
 * A project `secrets.env` that appears AFTER that sentinel is set is
 * orphaned: still consumed by `loadLayeredSecrets` at provider init, yet
 * invisible and undeletable in the dashboard.
 *
 * `relocateLegacyProjectSecrets` is the sentinel-independent guard the
 * daemon runs on every boot to close that window.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readSecrets,
  writeSecret,
  relocateLegacyProjectSecrets,
} from './secrets.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmpDirs(): { vaultDir: string; mycoHome: string } {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-vault-'));
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-secrets-home-'));
  cleanups.push(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
  });
  return { vaultDir, mycoHome };
}

describe('relocateLegacyProjectSecrets', () => {
  test('relocates an orphaned project secrets.env that appeared after the migration sentinel', () => {
    const { vaultDir, mycoHome } = tmpDirs();

    // A project secrets.env materializes AFTER the project was already
    // migrated (sentinel set) — e.g. a hand-placed file or resurrected
    // branch. The one-shot migration won't touch it again.
    writeSecret(vaultDir, 'ANTHROPIC_API_KEY', 'proj-anthropic');
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'proj-openai');
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(true);

    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    // Keys land at machine scope (where the dashboard can see + delete them).
    const machine = readSecrets(mycoHome);
    expect(machine.ANTHROPIC_API_KEY).toBe('proj-anthropic');
    expect(machine.OPENAI_API_KEY).toBe('proj-openai');
    expect(propagated.sort()).toEqual(['ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);

    // The project file is purged — it can never be loaded as an orphaned,
    // dashboard-invisible fallback again.
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test('machine value wins on conflict; project file still purged', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    // Newer machine-scope value must not be clobbered by a stale project copy.
    writeSecret(mycoHome, 'ANTHROPIC_API_KEY', 'machine-newer');
    writeSecret(vaultDir, 'ANTHROPIC_API_KEY', 'project-stale');

    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    expect(readSecrets(mycoHome).ANTHROPIC_API_KEY).toBe('machine-newer');
    // Already-present key is not re-propagated; it is dropped on purge.
    expect(propagated).toEqual([]);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test('lifts machine-absent keys while keeping machine-present ones', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    writeSecret(mycoHome, 'ANTHROPIC_API_KEY', 'machine-anthropic');
    writeSecret(vaultDir, 'ANTHROPIC_API_KEY', 'project-anthropic');
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'project-openai');

    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    const machine = readSecrets(mycoHome);
    expect(machine.ANTHROPIC_API_KEY).toBe('machine-anthropic'); // unchanged
    expect(machine.OPENAI_API_KEY).toBe('project-openai'); // lifted
    expect(propagated).toEqual(['OPENAI_API_KEY']);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });

  test('no-op when the project secrets.env is absent', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    const propagated = relocateLegacyProjectSecrets(vaultDir, mycoHome);
    expect(propagated).toEqual([]);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
    expect(readSecrets(mycoHome)).toEqual({});
  });

  test('idempotent — a second call after relocation is a clean no-op', () => {
    const { vaultDir, mycoHome } = tmpDirs();
    writeSecret(vaultDir, 'OPENAI_API_KEY', 'proj-openai');

    relocateLegacyProjectSecrets(vaultDir, mycoHome);
    const second = relocateLegacyProjectSecrets(vaultDir, mycoHome);

    expect(second).toEqual([]);
    expect(readSecrets(mycoHome).OPENAI_API_KEY).toBe('proj-openai');
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });
});
