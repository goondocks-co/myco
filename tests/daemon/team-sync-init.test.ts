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
  backfillAllMock,
  backfillAllForRebuildMock,
  discardRowsMock,
  enqueueOutboxMock,
  upsertSelfMemberMock,
  setTeamSyncEnabledMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  enqueueBatchMock: vi.fn(),
  listPendingMock: vi.fn(() => []),
  markSentMock: vi.fn(),
  markSourceRowsSyncedMock: vi.fn(),
  pruneOldMock: vi.fn(),
  backfillUnsyncedMock: vi.fn(),
  backfillAllMock: vi.fn(),
  backfillAllForRebuildMock: vi.fn(),
  discardRowsMock: vi.fn(),
  enqueueOutboxMock: vi.fn(),
  upsertSelfMemberMock: vi.fn(),
  setTeamSyncEnabledMock: vi.fn(),
}));

mock.module('@myco/db/queries/team-outbox.js', () => ({
  listPending: listPendingMock,
  markSent: markSentMock,
  markSourceRowsSynced: markSourceRowsSyncedMock,
  pruneOld: pruneOldMock,
  backfillUnsynced: backfillUnsyncedMock,
  backfillAll: backfillAllMock,
  backfillAllForRebuild: backfillAllForRebuildMock,
  discardRows: discardRowsMock,
  countPending: vi.fn(() => 0),
  enqueueOutbox: enqueueOutboxMock,
}));

mock.module('@myco/db/queries/team-members.js', () => ({
  upsertSelfMember: upsertSelfMemberMock,
}));

// reconcileClient + flushPending write this Grove's team_sync_state via the
// real query layer; here getDatabase() is a transaction-only stub with no
// .prepare, so stub the flag write (these tests assert client reconciliation,
// not the per-Grove flag — that is covered by team-sync-state.test.ts).
mock.module('@myco/db/queries/team-sync-state.js', () => ({
  setTeamSyncEnabled: setTeamSyncEnabledMock,
}));

// reconcileSelfMember wraps upsertSelfMember + enqueueOutbox in a
// db.transaction(fn)() call so a crash between the two leaves no
// orphaned team_members row. The stub here mirrors better-sqlite3's
// transaction signature (returns a callable) without involving an
// actual database connection.
mock.module('@myco/db/client.js', () => ({
  getDatabase: () => ({
    transaction: (fn: () => void) => () => fn(),
  }),
  withDatabase: <T>(_db: unknown, fn: () => T) => fn(),
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
    backfillAllMock.mockReturnValue(2);
    upsertSelfMemberMock.mockReturnValue({
      inserted: true,
      row: {
        id: 'machine-1',
        user: 'machine-1',
        role: null,
        joined: '2026-05-17T12:00:00.000Z',
        tags: null,
        machine_id: 'machine-1',
        synced_at: null,
      },
    });
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
    expect(upsertSelfMemberMock).toHaveBeenCalledWith('machine-1', expect.any(String));
    expect(enqueueOutboxMock).toHaveBeenCalledWith(expect.objectContaining({
      table_name: 'team_members',
      row_id: 'machine-1',
      machine_id: 'machine-1',
    }));
    // The write-path gate is now registry-participation-driven, decoupled from
    // the grove-config flag that builds the read/rebuild client. This legacy
    // non-Grove setup has no team-registry membership, so the gate is false
    // even though the read client builds (connect/getTeamClient above).
    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(false);
    expect(teamSync.getTeamClient()).not.toBeNull();
  });

  it('skips outbox enqueue when self member row already exists', async () => {
    upsertSelfMemberMock.mockReturnValueOnce({
      inserted: false,
      row: {
        id: 'machine-1',
        user: 'Alice',
        role: 'owner',
        joined: '2026-05-17T12:00:00.000Z',
        tags: null,
        machine_id: 'machine-1',
        synced_at: 1779000000,
      },
    });
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

    expect(upsertSelfMemberMock).toHaveBeenCalledWith('machine-1', expect.any(String));
    expect(enqueueOutboxMock).not.toHaveBeenCalled();
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

  it('routes pending outbox rows to the owning team after reconcile', async () => {
    // Flush routing is now registry-driven: reconcileClient's auto-flush
    // routes each pending row to the worker of the team that owns its
    // project. Register a team for this Grove's project, tag the pending row
    // with that project_id, and assert it reached the team's client.
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const { createTeamId, createProjectId } = await import('../../packages/myco/src/grove/ids.js');
    const { teamRegistry } = await import('../../packages/myco/src/team/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove('flush-route-test', mycoHome);
    const projectId = createProjectId();
    const teamId = createTeamId();
    teamRegistry.save(
      {
        team_id: teamId,
        name: 'Routing Team',
        worker_url: 'https://team.example.workers.dev',
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: grove.id, project_id: projectId }],
      },
      mycoHome,
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret', mycoHome);

    const groveDir = resolveGroveDir(grove.id);
    fs.mkdirSync(groveDir, { recursive: true });
    fs.writeFileSync(path.join(groveDir, 'grove.yaml'), [
      'team:',
      '  enabled: true',
      '  worker_url: https://team.example.workers.dev',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(groveDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=routing-secret\n', 'utf-8');

    const pending = [
      {
        id: 1,
        table_name: 'sessions',
        row_id: 'session-1',
        operation: 'upsert',
        payload: { id: 'session-1' },
        machine_id: 'machine-1',
        project_id: projectId,
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

    const groveContext = requestContext(grove.id, projectId);
    await teamSync.reconcileClient(groveContext);

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
    // The gate follows config down too — disabled config => flag set false.
    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(false);
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

describe('initTeamSync.rebuildFromLocal', () => {
  let tmpDir: string;
  let vaultDir: string;
  let previousMycoHome: string | undefined;

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };

  function writeTeamConfig(enabled: boolean): void {
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 9',
      'team:',
      `  enabled: ${enabled ? 'true' : 'false'}`,
      '  worker_url: https://team.example.workers.dev',
    ].join('\n'), 'utf-8');
  }

  function makeTeamSync() {
    return initTeamSync({
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
  }

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rebuild-from-local-'));
    vaultDir = path.join(tmpDir, '.myco');
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = path.join(tmpDir, 'home');
    fs.mkdirSync(vaultDir, { recursive: true });
    listPendingMock.mockReturnValue([]);
    backfillAllForRebuildMock.mockReturnValue(2);
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=secret-token\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
  });

  it('happy path: truncates cloud, backfills, and flushes — returns a clean TeamFlushResult', async () => {
    writeTeamConfig(true);
    const teamSync = makeTeamSync();
    const rebuildSpy = vi.fn().mockResolvedValue(undefined);
    teamSync.setTeamClient({ rebuild: rebuildSpy, enqueueBatch: enqueueBatchMock } as never);

    const result = await teamSync.rebuildFromLocal();

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    expect(backfillAllForRebuildMock).toHaveBeenCalledWith('machine-1');
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ handedOff: expect.any(Number), rejected: expect.any(Number), batches: expect.any(Number) });
  });

  it('rebuild throws: aborts before backfill/flush and returns an error result', async () => {
    writeTeamConfig(true);
    const teamSync = makeTeamSync();
    const rebuildSpy = vi.fn().mockRejectedValue(new Error('worker truncate failed'));
    teamSync.setTeamClient({ rebuild: rebuildSpy, enqueueBatch: enqueueBatchMock } as never);

    const result = await teamSync.rebuildFromLocal();

    expect(rebuildSpy).toHaveBeenCalledTimes(1);
    // The load-bearing invariant: a failed truncate must NOT proceed to
    // re-enqueue the Grove. Without the abort, backfillAllForRebuild would run
    // and push rows against a half-truncated cloud mirror.
    expect(backfillAllForRebuildMock).not.toHaveBeenCalled();
    expect(result.error).toBe('worker truncate failed');
  });

  it('disabled config: early-returns the empty result without touching the client', async () => {
    writeTeamConfig(false);
    const teamSync = makeTeamSync();
    const rebuildSpy = vi.fn().mockResolvedValue(undefined);
    teamSync.setTeamClient({ rebuild: rebuildSpy, enqueueBatch: enqueueBatchMock } as never);

    const result = await teamSync.rebuildFromLocal();

    expect(rebuildSpy).not.toHaveBeenCalled();
    expect(backfillAllForRebuildMock).not.toHaveBeenCalled();
    expect(result).toEqual({ handedOff: 0, rejected: 0, batches: 0 });
  });
});
