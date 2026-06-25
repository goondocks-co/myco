import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { initTeamSync } from '@myco/daemon/team-sync-init.js';
import { resolveGroveDir } from '@myco/grove/paths.js';

const {
  connectMock,
  rebuildMock,
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
  setProjectSyncMembershipMock,
  purgeNonMemberOutboxMock,
  purgePendingOutboxMock,
} = vi.hoisted(() => ({
  connectMock: vi.fn(),
  rebuildMock: vi.fn(),
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
  setProjectSyncMembershipMock: vi.fn(),
  purgeNonMemberOutboxMock: vi.fn(() => 0),
  purgePendingOutboxMock: vi.fn(() => 0),
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
  countPendingByTable: vi.fn(() => ({})),
  purgePendingOutbox: purgePendingOutboxMock,
  purgeNonMemberOutbox: purgeNonMemberOutboxMock,
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
  setProjectSyncMembership: setProjectSyncMembershipMock,
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
    rebuild = rebuildMock;
    enqueueBatch = enqueueBatchMock;
    health = vi.fn();
    getVersionCompat = vi.fn(() => 'unknown');
    getCollectiveStatus = vi.fn();
    getMcpToken = vi.fn(() => null);
    getMcpEndpoint = vi.fn(() => null);
  },
}));

describe('initTeamSync.reconcileClient', () => {
  let tmpDir: string;
  let vaultDir: string;
  let previousMycoHome: string | undefined;
  let prevLegacyHomes: string | undefined;

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
    prevLegacyHomes = process.env.MYCO_TEAM_LEGACY_HOMES;
    process.env.MYCO_HOME = path.join(tmpDir, 'home');
    process.env.MYCO_TEAM_HOME = path.join(tmpDir, 'team-home');
    process.env.MYCO_TEAM_LEGACY_HOMES = '';
    fs.mkdirSync(vaultDir, { recursive: true });
    connectMock.mockResolvedValue({});
    rebuildMock.mockResolvedValue(undefined);
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
    delete process.env.MYCO_TEAM_HOME;
    if (prevLegacyHomes === undefined) delete process.env.MYCO_TEAM_LEGACY_HOMES;
    else process.env.MYCO_TEAM_LEGACY_HOMES = prevLegacyHomes;
  });

  async function registerRegistryTeam(name = 'Registry Team') {
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const { createTeamId, createProjectId } = await import('../../packages/myco/src/grove/ids.js');
    const { teamRegistry } = await import('../../packages/myco/src/team/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove(name, mycoHome);
    const projectId = createProjectId();
    const teamId = createTeamId();
    teamRegistry.save(
      {
        team_id: teamId,
        name,
        worker_url: 'https://team.example.workers.dev',
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: grove.id, project_id: projectId }],
      },
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret');
    return { grove, projectId, teamId };
  }

  it('ignores legacy team config when the Grove has no registry membership', async () => {
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

    expect(connectMock).not.toHaveBeenCalled();
    expect(backfillUnsyncedMock).not.toHaveBeenCalled();
    expect(upsertSelfMemberMock).not.toHaveBeenCalled();
    expect(enqueueOutboxMock).not.toHaveBeenCalled();
    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(false);
    expect(teamSync.getTeamClient()).toBeNull();
  });

  it('reconciles the self member locally without enqueueing legacy team_members rows', async () => {
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
    const { grove, projectId } = await registerRegistryTeam();
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

    await teamSync.reconcileClient(requestContext(grove.id, projectId));

    expect(upsertSelfMemberMock).toHaveBeenCalledWith('machine-1', expect.any(String));
    expect(enqueueOutboxMock).not.toHaveBeenCalled();
  });

  it('registry membership, not legacy config signatures, drives repeated reconciliation', async () => {
    const { grove, projectId } = await registerRegistryTeam();
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

    await teamSync.reconcileClient(requestContext(grove.id, projectId));
    await teamSync.reconcileClient(requestContext(grove.id, projectId));

    expect(connectMock).not.toHaveBeenCalled();
    expect(backfillUnsyncedMock).toHaveBeenCalledTimes(2);
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
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret');

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

  it('matches worker rejections by table and row id', async () => {
    const { grove, projectId } = await registerRegistryTeam();
    const pending = [
      {
        id: 1,
        table_name: 'spores',
        row_id: 'shared-row-id',
        operation: 'upsert',
        payload: { id: 'shared-row-id', content: 'bad spore' },
        machine_id: 'machine-1',
        project_id: projectId,
        created_at: 100,
        sent_at: null,
      },
      {
        id: 2,
        table_name: 'sessions',
        row_id: 'shared-row-id',
        operation: 'upsert',
        payload: { id: 'shared-row-id', title: 'accepted session' },
        machine_id: 'machine-1',
        project_id: projectId,
        created_at: 101,
        sent_at: null,
      },
    ];
    listPendingMock.mockReturnValueOnce(pending).mockReturnValue([]);
    enqueueBatchMock.mockResolvedValueOnce({
      accepted: 1,
      rejected: [{ id: 'shared-row-id', table: 'spores', error: 'invalid spore' }],
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

    await teamSync.flushPending(requestContext(grove.id, projectId));

    expect(discardRowsMock).toHaveBeenCalledWith([1]);
    expect(markSentMock).toHaveBeenCalledWith([2], expect.any(Number));
    expect(markSourceRowsSyncedMock).toHaveBeenCalledWith([pending[1]], expect.any(Number));
    // The rejected row's SOURCE is stamped too — a rejection is the
    // worker's permanent verdict, and an unstamped source row would be
    // re-enqueued by backfillUnsynced on every reconcile, repeating the
    // reject/discard cycle forever.
    expect(markSourceRowsSyncedMock).toHaveBeenCalledWith([pending[0]], expect.any(Number));
  });

  it('registry membership exposes a read client even when legacy config is disabled', async () => {
    const { grove, projectId } = await registerRegistryTeam();
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

    await teamSync.reconcileClient(requestContext(grove.id, projectId));

    expect(teamSync.getTeamClient(requestContext(grove.id, projectId))).not.toBeNull();
    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(true);
  });

  it('keeps registry clients separated by project context', async () => {
    const first = await registerRegistryTeam('One');
    const second = await registerRegistryTeam('Two');
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

    const clientOne = teamSync.getTeamClient(requestContext(first.grove.id, first.projectId));
    const clientTwo = teamSync.getTeamClient(requestContext(second.grove.id, second.projectId));

    expect(clientOne).not.toBeNull();
    expect(clientTwo).not.toBeNull();
    expect(clientOne).not.toBe(clientTwo);
  });

  it('does not reconcile a client from legacy Grove config without registry membership', async () => {
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

    expect(teamSync.getTeamClient(groveContext)).toBeNull();
    expect(connectMock).not.toHaveBeenCalled();
  });

  it('a grove with no member projects does NOT project-backfill, but purges and still pushes the self-row', async () => {
    // The machine joined a team via ANOTHER grove, so it has joined a team but
    // THIS grove owns no member project.
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const { createTeamId, createProjectId } = await import('../../packages/myco/src/grove/ids.js');
    const { teamRegistry } = await import('../../packages/myco/src/team/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    const otherGrove = createGrove('elsewhere', mycoHome);
    const hereGrove = createGrove('here', mycoHome);
    const teamId = createTeamId();
    teamRegistry.save(
      {
        team_id: teamId,
        name: 'Elsewhere Team',
        worker_url: 'https://team.example.workers.dev',
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: otherGrove.id, project_id: createProjectId() }],
      },
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret');

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

    await teamSync.reconcileClient(requestContext(hereGrove.id, 'proj-here'));

    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(false);
    expect(setProjectSyncMembershipMock).toHaveBeenCalledWith([]);
    expect(purgeNonMemberOutboxMock).toHaveBeenCalledWith([]);
    // Roster self-row is still published, and backfill still runs (it carries
    // the machine-scoped self-row; backfillRows filters project rows internally).
    expect(upsertSelfMemberMock).toHaveBeenCalled();
    expect(backfillUnsyncedMock).toHaveBeenCalled();
    // The no-team early-return self-row sweep must NOT fire — the machine HAS
    // joined a team, so leftover self-rows are wanted, not purged.
    expect(purgePendingOutboxMock).not.toHaveBeenCalled();
  });

  it('a grove that owns a member project reconciles that project and backfills', async () => {
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const { createTeamId } = await import('../../packages/myco/src/grove/ids.js');
    const { teamRegistry } = await import('../../packages/myco/src/team/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove('owns', mycoHome);
    const teamId = createTeamId();
    teamRegistry.save(
      {
        team_id: teamId,
        name: 'Owns Team',
        worker_url: 'https://team.example.workers.dev',
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: grove.id, project_id: 'p-mine' }],
      },
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret');

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

    await teamSync.reconcileClient(requestContext(grove.id, 'p-mine'));

    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(true);
    expect(setProjectSyncMembershipMock).toHaveBeenCalledWith(['p-mine']);
    expect(purgeNonMemberOutboxMock).toHaveBeenCalledWith(['p-mine']);
    expect(backfillUnsyncedMock).toHaveBeenCalled();
  });

  it('does not set enabled=false when the team registry dir is unreadable (readdirSync throws)', async () => {
    // Plant a regular file at the teams/ path so readdirSync throws ENOTDIR.
    // This simulates a transient/mid-migration state where the directory
    // cannot be read — the result is indeterminate, not confirmed-empty.
    const teamsDir = path.join(process.env.MYCO_TEAM_HOME!, 'teams');
    fs.mkdirSync(path.dirname(teamsDir), { recursive: true });
    fs.writeFileSync(teamsDir, 'not-a-dir');

    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const grove = createGrove('resilience-unreadable', process.env.MYCO_HOME!);
    const teamSync = initTeamSync({
      liveConfig: { current: { team: { enabled: false, worker_url: undefined } } } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });

    await teamSync.reconcileClient(requestContext(grove.id, 'proj-unreadable'));

    // Registry read failed — enabled must be left unchanged (NOT set to false).
    expect(setTeamSyncEnabledMock).not.toHaveBeenCalledWith(false);
    expect(setTeamSyncEnabledMock).not.toHaveBeenCalledWith(true);
    // Pending self-rows (machine-scoped outbox entries) must NOT be purged —
    // the machine may belong to a team that we couldn't observe.
    expect(purgePendingOutboxMock).not.toHaveBeenCalled();
  });

  it('sets enabled=false when the registry is readable but has no members for this grove (confirmed empty)', async () => {
    // Empty teams/ dir — successfully read but genuinely no members.
    const teamsDir = path.join(process.env.MYCO_TEAM_HOME!, 'teams');
    fs.mkdirSync(teamsDir, { recursive: true });

    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const grove = createGrove('confirmed-empty', process.env.MYCO_HOME!);
    const teamSync = initTeamSync({
      liveConfig: { current: { team: { enabled: false, worker_url: undefined } } } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
    });

    await teamSync.reconcileClient(requestContext(grove.id, 'proj-no-team'));

    // Registry readable + genuinely empty → confirmed non-member → disabled.
    expect(setTeamSyncEnabledMock).toHaveBeenCalledWith(false);
    // Confirmed-empty read IS a valid reason to purge pending self-rows.
    expect(purgePendingOutboxMock).toHaveBeenCalled();
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
  let prevLegacyHomes: string | undefined;

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

  beforeEach(() => {
    vi.clearAllMocks();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-rebuild-from-local-'));
    vaultDir = path.join(tmpDir, '.myco');
    previousMycoHome = process.env.MYCO_HOME;
    prevLegacyHomes = process.env.MYCO_TEAM_LEGACY_HOMES;
    process.env.MYCO_HOME = path.join(tmpDir, 'home');
    process.env.MYCO_TEAM_HOME = path.join(tmpDir, 'team-home');
    process.env.MYCO_TEAM_LEGACY_HOMES = '';
    fs.mkdirSync(vaultDir, { recursive: true });
    rebuildMock.mockResolvedValue(undefined);
    listPendingMock.mockReturnValue([]);
    backfillAllForRebuildMock.mockReturnValue(2);
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), 'MYCO_TEAM_API_KEY=secret-token\n', 'utf-8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    delete process.env.MYCO_TEAM_HOME;
    if (prevLegacyHomes === undefined) delete process.env.MYCO_TEAM_LEGACY_HOMES;
    else process.env.MYCO_TEAM_LEGACY_HOMES = prevLegacyHomes;
  });

  async function registerRegistryTeam() {
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const { createTeamId, createProjectId } = await import('../../packages/myco/src/grove/ids.js');
    const { teamRegistry } = await import('../../packages/myco/src/team/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove('rebuild-test', mycoHome);
    const projectId = createProjectId();
    const teamId = createTeamId();
    teamRegistry.save(
      {
        team_id: teamId,
        name: 'Rebuild Team',
        worker_url: 'https://team.example.workers.dev',
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: grove.id, project_id: projectId }],
      },
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret');
    return requestContext(grove.id, projectId);
  }

  it('happy path: truncates the registry Team, backfills, and flushes', async () => {
    writeTeamConfig(true);
    const ctx = await registerRegistryTeam();
    const teamSync = makeTeamSync();

    const result = await teamSync.rebuildFromLocal(ctx);

    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(backfillAllForRebuildMock).toHaveBeenCalledWith('machine-1');
    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ handedOff: expect.any(Number), rejected: expect.any(Number), batches: expect.any(Number) });
  });

  it('rebuild throws: still backfills so any partial truncate is restored and reports the error', async () => {
    writeTeamConfig(true);
    const ctx = await registerRegistryTeam();
    const teamSync = makeTeamSync();
    rebuildMock.mockRejectedValueOnce(new Error('worker truncate failed'));

    const result = await teamSync.rebuildFromLocal(ctx);

    expect(rebuildMock).toHaveBeenCalledTimes(1);
    expect(backfillAllForRebuildMock).toHaveBeenCalledWith('machine-1');
    expect(result.error).toContain('worker truncate failed');
  });

  it('no registry membership: returns a typed error without touching the worker', async () => {
    writeTeamConfig(false);
    const teamSync = makeTeamSync();

    const result = await teamSync.rebuildFromLocal();

    expect(rebuildMock).not.toHaveBeenCalled();
    expect(backfillAllForRebuildMock).not.toHaveBeenCalled();
    expect(result).toEqual({ handedOff: 0, rejected: 0, batches: 0, error: 'team_not_configured' });
  });
});
