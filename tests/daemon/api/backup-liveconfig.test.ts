import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBackupHandlers, resolveBackupDir } from '@myco/daemon/api/backup';
import type { MycoConfig } from '@myco/config/schema';
import type { RouteRequest } from '@myco/daemon/router';

function makeConfig(overrides: Partial<MycoConfig['backup']> = {}): MycoConfig {
  return { backup: { ...overrides } } as MycoConfig;
}

function makeRequest(body: unknown = {}): RouteRequest {
  return { params: {}, query: {}, body } as RouteRequest;
}

describe('resolveBackupDir', () => {
  it('falls back to <vault>/backups when no dir is configured', () => {
    const vault = '/tmp/vault';
    const dir = resolveBackupDir(makeConfig({}), vault);
    expect(dir).toBe(path.resolve(vault, 'backups'));
  });

  it('expands ~/ to the home directory', () => {
    const dir = resolveBackupDir(makeConfig({ dir: '~/custom-backups' }), '/tmp/vault');
    expect(dir).toBe(path.resolve(path.join(os.homedir(), 'custom-backups')));
  });

  it('resolves absolute paths directly', () => {
    const dir = resolveBackupDir(makeConfig({ dir: '/var/mybackups' }), '/tmp/vault');
    expect(dir).toBe('/var/mybackups');
  });
});

describe('createBackupHandlers — liveConfig hot-reload', () => {
  let vaultDir: string;
  let firstDir: string;
  let secondDir: string;

  beforeEach(() => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-backup-lc-'));
    firstDir = path.join(vaultDir, 'first');
    secondDir = path.join(vaultDir, 'second');
    fs.mkdirSync(firstDir, { recursive: true });
    fs.mkdirSync(secondDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  it('re-resolves the backup dir from liveConfig on every listBackups call', async () => {
    // Drop two distinct backup files, one in each directory, so we can
    // verify the handler is reading from the current dir and not the
    // startup-captured value.
    fs.writeFileSync(path.join(firstDir, 'machineA.sql'), '-- first');
    fs.writeFileSync(path.join(secondDir, 'machineB.sql'), '-- second');

    const liveConfig = { current: makeConfig({ dir: firstDir }) };
    const handlers = createBackupHandlers({
      db: { close: vi.fn() } as never,
      machineId: 'machineA',
      vaultDir,
      liveConfig,
    });

    const firstRes = await handlers.handleListBackups(makeRequest());
    expect((firstRes.body as { backups: Array<{ machine_id: string }> }).backups
      .some((b) => b.machine_id === 'machineA')).toBe(true);

    // Flip the setting — simulates a user saving a new backup.dir in Settings.
    liveConfig.current = makeConfig({ dir: secondDir });

    const secondRes = await handlers.handleListBackups(makeRequest());
    const secondList = (secondRes.body as { backups: Array<{ machine_id: string }> }).backups;
    expect(secondList.some((b) => b.machine_id === 'machineB')).toBe(true);
    expect(secondList.some((b) => b.machine_id === 'machineA')).toBe(false);
  });
});
