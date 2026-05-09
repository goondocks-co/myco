import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { initTeamSync } from '@myco/daemon/team-sync-init.js';
import { resolveGroveDir } from '@myco/grove/paths.js';

const {
  connectMock,
  enqueueBatchMock,
  listPendingMock,
  markSentMock,
  markSourceRowsSyncedMock,
  pruneOldMock,
  backfillUnsyncedMock,
  discardRowsMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  enqueueBatchMock: vi.fn(),
  listPendingMock: vi.fn(() => []),
  markSentMock: vi.fn(),
  markSourceRowsSyncedMock: vi.fn(),
  pruneOldMock: vi.fn(),
  backfillUnsyncedMock: vi.fn(),
  discardRowsMock: vi.fn(),
}));

mock.module('@myco/db/queries/team-outbox.js', () => ({
  listPending: listPendingMock,
  markSent: markSentMock,
  markSourceRowsSynced: markSourceRowsSyncedMock,
  pruneOld: pruneOldMock,
  backfillUnsynced: backfillUnsyncedMock,
  discardRows: discardRowsMock,
  countPending: vi.fn(() => 0),
}));

mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    connect = connectMock;
    enqueueBatch = enqueueBatchMock;
    getCollectiveStatus = vi.fn();
    getMcpToken = vi.fn(() => null);
    getMcpEndpoint = vi.fn(() => null);
  },
}));

describe('initTeamSync.reconcileClient', () => {
  let tmpDir: string;
  let vaultDir: string;
  let previousMycoHome: string | undefined;

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
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(tmpDir, 'home');
    fs.mkdirSync(vaultDir, { recursive: true });
    connectMock.mockResolvedValue({});
    enqueueBatchMock.mockResolvedValue({ accepted: 0, rejected: [] });
    listPendingMock.mockReturnValue([]);
    backfillUnsyncedMock.mockReturnValue(3);
    writeTeamConfig(true);
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=secret-token\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
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

  it('flushes pending outbox rows after reconciling a configured client', async () => {
    const pending = [
      {
        id: 1,
        table_name: 'sessions',
        row_id: 'session-1',
        operation: 'upsert',
        payload: { id: 'session-1' },
        machine_id: 'machine-1',
        created_at: 100,
        sent_at: null,
      },
    ];
    listPendingMock.mockReturnValueOnce(pending).mockReturnValue([]);
    enqueueBatchMock.mockResolvedValueOnce({ accepted: 1, rejected: [] });
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

    expect(enqueueBatchMock).toHaveBeenCalledWith(pending);
    expect(markSentMock).toHaveBeenCalledWith([1], expect.any(Number));
    expect(markSourceRowsSyncedMock).toHaveBeenCalledWith(pending, expect.any(Number));
    expect(pruneOldMock).toHaveBeenCalled();
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

  it('reconciles a Grove client from config and secrets written outside the daemon', async () => {
    const teamSync = initTeamSync({
      liveConfig: {
        current: {
          team: { enabled: false, worker_url: undefined },
        },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });
    // G3 requires grove_<32hex>; G6 requires registry membership.
    // Register a Grove via createGrove() to satisfy both gates and use
    // its real id in the request context.
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const grove = createGrove('external-team-test');
    const groveContext = requestContext(grove.id, 'proj_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeee2');
    const groveDir = resolveGroveDir(groveContext.groveId);
    fs.mkdirSync(groveDir, { recursive: true });
    fs.writeFileSync(path.join(groveDir, 'grove.yaml'), [
      'team:',
      '  enabled: true',
      '  worker_url: https://external-team.example.workers.dev',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=external-secret\n', 'utf-8');

    expect(teamSync.getTeamClient(groveContext)).toBeNull();

    await teamSync.reconcileClient(groveContext);

    expect(teamSync.getTeamClient(groveContext)).not.toBeNull();
    expect(connectMock).toHaveBeenCalledWith({
      machine_id: 'machine-1',
      version: '1.2.3',
    });
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
