import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { initTeamSync } from '@myco/daemon/team-sync-init.js';

const {
  connectMock,
  backfillUnsyncedMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  backfillUnsyncedMock: vi.fn(),
}));

mock.module('@myco/db/queries/team-outbox.js', () => ({
  listPending: vi.fn(() => []),
  markSent: vi.fn(),
  markSourceRowsSynced: vi.fn(),
  pruneOld: vi.fn(),
  backfillUnsynced: backfillUnsyncedMock,
  discardRows: vi.fn(),
  countPending: vi.fn(() => 0),
}));

mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    connect = connectMock;
    enqueueBatch = vi.fn();
    getCollectiveStatus = vi.fn();
    getMcpToken = vi.fn(() => null);
    getMcpEndpoint = vi.fn(() => null);
  },
}));

describe('initTeamSync.reconcileClient', () => {
  let tmpDir: string;
  let vaultDir: string;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-sync-init-'));
    vaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    connectMock.mockResolvedValue({});
    backfillUnsyncedMock.mockReturnValue(3);
    writeTeamConfig(true);
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=secret-token\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('initializes and registers a client when team sync is enabled', async () => {
    const teamSync = initTeamSync({
      liveConfig: {
        current: {
          team: { enabled: true, worker_url: 'https://team.example.workers.dev' },
        },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });

    await teamSync.reconcileClient();

    expect(connectMock).toHaveBeenCalledWith({
      machine_id: 'machine-1',
      version: '1.2.3',
    });
    expect(backfillUnsyncedMock).toHaveBeenCalledWith('machine-1');
    expect(teamSync.getTeamClient()).not.toBeNull();
  });

  it('does nothing when the same client inputs are reconciled twice', async () => {
    const teamSync = initTeamSync({
      liveConfig: {
        current: {
          team: { enabled: true, worker_url: 'https://team.example.workers.dev' },
        },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });

    await teamSync.reconcileClient();
    await teamSync.reconcileClient();

    expect(connectMock).toHaveBeenCalledTimes(1);
    expect(backfillUnsyncedMock).toHaveBeenCalledTimes(1);
  });

  it('clears the live client when team sync becomes disabled', async () => {
    const liveConfig = {
      current: {
        team: { enabled: true, worker_url: 'https://team.example.workers.dev' },
      },
    };
    const teamSync = initTeamSync({
      liveConfig: liveConfig as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });

    await teamSync.reconcileClient();
    expect(teamSync.getTeamClient()).not.toBeNull();

    writeTeamConfig(false);
    await teamSync.reconcileClient();

    expect(teamSync.getTeamClient()).toBeNull();
  });

  it('keeps live clients separated by Grove context', () => {
    const teamSync = initTeamSync({
      liveConfig: {
        current: {
          team: { enabled: true, worker_url: 'https://team.example.workers.dev' },
        },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });
    const groveOne = requestContext('grove_one', 'proj_one');
    const groveTwo = requestContext('grove_two', 'proj_two');

    const client = { marker: 'one' } as never;
    teamSync.setTeamClient(client, groveOne);

    expect(teamSync.getTeamClient(groveOne)).toBe(client);
    expect(teamSync.getTeamClient(groveTwo)).toBeNull();
  });

  function writeTeamConfig(enabled: boolean): void {
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 9',
      'team:',
      `  enabled: ${enabled ? 'true' : 'false'}`,
      '  worker_url: https://team.example.workers.dev',
    ].join('\n'), 'utf-8');
  }

  function requestContext(groveId: string, projectId: string) {
    return {
      projectRoot: tmpDir,
      projectVaultDir: vaultDir,
      projectId,
      groveId,
      machineId: 'machine-1',
      sessionId: null,
      databasePath: path.join(tmpDir, groveId, 'myco.db'),
      source: 'headers',
    } as const;
  }
});
