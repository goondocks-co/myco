import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { initTeamSync } from '@myco/daemon/team-sync-init.js';

const {
  connectMock,
  backfillUnsyncedMock,
  readSecretsMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  backfillUnsyncedMock: vi.fn(),
  readSecretsMock: vi.fn(),
}));

mock.module('@myco/config/secrets.js', () => ({
  readSecrets: readSecretsMock,
}));

mock.module('@myco/db/queries/team-outbox.js', () => ({
  listPending: vi.fn(() => []),
  markSent: vi.fn(),
  markSourceRowsSynced: vi.fn(),
  pruneOld: vi.fn(),
  backfillUnsynced: backfillUnsyncedMock,
  incrementRetryCount: vi.fn(() => []),
  countPending: vi.fn(() => 0),
}));

mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    connect = connectMock;
    pushBatch = vi.fn();
    getCollectiveStatus = vi.fn();
    getMcpToken = vi.fn(() => null);
    getMcpEndpoint = vi.fn(() => null);
  },
}));

describe('initTeamSync.reconcileClient', () => {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    connectMock.mockResolvedValue({});
    backfillUnsyncedMock.mockReturnValue(3);
    readSecretsMock.mockReturnValue({ MYCO_TEAM_API_KEY: 'secret-token' });
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
      vaultDir: '/tmp/vault',
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
      vaultDir: '/tmp/vault',
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
      vaultDir: '/tmp/vault',
      serverVersion: '1.2.3',
    });

    await teamSync.reconcileClient();
    expect(teamSync.getTeamClient()).not.toBeNull();

    liveConfig.current = {
      team: { enabled: false, worker_url: 'https://team.example.workers.dev' },
    };
    await teamSync.reconcileClient();

    expect(teamSync.getTeamClient()).toBeNull();
  });
});
