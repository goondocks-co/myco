import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';
import { initTeamSync } from '@myco/daemon/team-sync-init.js';

// Reconcile-eligible table allow-list the trigger pass iterates. Mocked to a
// small set so call counts stay legible (real list is 13+ project-scoped
// tables). skill_lineage is included as a protocol-3 table so the
// worker-version gate has something to skip when the worker is older.
const MOCK_RECONCILE_TABLES = ['sessions', 'spores', 'skill_lineage'];

/**
 * Drain the microtask + timer queues so a FIRE-AND-FORGET reconcile pass
 * (dispatched by reconcileClient via triggerReconcilePass, not awaited) settles
 * before we assert on its spy. Each partition is one awaited spy call; a couple
 * of macrotask turns flush them all.
 */
async function flushAsync(times = 3): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise<void>((r) => setTimeout(r, 0));
}

const {
  getWorkerProtocolVersionMock,
  enqueueBatchMock,
  listPendingMock,
  backfillUnsyncedMock,
  upsertSelfMemberMock,
  setTeamSyncEnabledMock,
  setProjectSyncMembershipMock,
  purgeNonMemberOutboxMock,
  purgePendingOutboxMock,
  localPartitionMock,
  pendingRowIdsForPartitionMock,
  enqueueOutboxMock,
  enqueueProjectRemovalTombstonesMock,
  forEachGroveMock,
} = vi.hoisted(() => ({
  enqueueBatchMock: vi.fn(),
  listPendingMock: vi.fn(() => []),
  backfillUnsyncedMock: vi.fn(() => 0),
  upsertSelfMemberMock: vi.fn(),
  setTeamSyncEnabledMock: vi.fn(),
  setProjectSyncMembershipMock: vi.fn(),
  purgeNonMemberOutboxMock: vi.fn(() => 0),
  purgePendingOutboxMock: vi.fn(() => 0),
  localPartitionMock: vi.fn(() => []),
  pendingRowIdsForPartitionMock: vi.fn(() => new Set<string>()),
  enqueueOutboxMock: vi.fn(),
  enqueueProjectRemovalTombstonesMock: vi.fn(() => ({ enqueued: 0, reset: 0 })),
  forEachGroveMock: vi.fn(),
  getWorkerProtocolVersionMock: vi.fn((): number | undefined => 3),
}));

mock.module('@myco/db/queries/team-outbox.js', () => ({
  listPending: listPendingMock,
  markSent: vi.fn(),
  markSourceRowsSynced: vi.fn(),
  pruneOld: vi.fn(),
  backfillUnsynced: backfillUnsyncedMock,
  backfillAll: vi.fn(),
  backfillAllForRebuild: vi.fn(),
  discardRows: vi.fn(),
  countPending: vi.fn(() => 0),
  countPendingByTable: vi.fn(() => ({})),
  purgePendingOutbox: purgePendingOutboxMock,
  purgeNonMemberOutbox: purgeNonMemberOutboxMock,
  enqueueOutbox: enqueueOutboxMock,
  enqueueProjectRemovalTombstones: enqueueProjectRemovalTombstonesMock,
  localPartition: localPartitionMock,
  pendingRowIdsForPartition: pendingRowIdsForPartitionMock,
  sanitizeSyncPayload: (_table: string, row: object) => row,
  RECONCILE_ELIGIBLE_TABLES: MOCK_RECONCILE_TABLES,
}));

mock.module('@myco/db/queries/team-members.js', () => ({
  upsertSelfMember: upsertSelfMemberMock,
}));

mock.module('@myco/db/queries/team-sync-state.js', () => ({
  setTeamSyncEnabled: setTeamSyncEnabledMock,
  setProjectSyncMembership: setProjectSyncMembershipMock,
}));

mock.module('@myco/db/client.js', () => ({
  getDatabase: () => ({
    transaction: (fn: () => void) => () => fn(),
  }),
  withDatabase: <T>(_db: unknown, fn: () => T) => fn(),
}));

mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    rebuild = vi.fn();
    enqueueBatch = enqueueBatchMock;
    health = vi.fn();
    getVersionCompat = vi.fn(() => 'unknown');
    getWorkerProtocolVersion = getWorkerProtocolVersionMock;
    supportsManifest = vi.fn(() => true);
    getManifest = vi.fn();
  },
}));

// forEachGrove is mocked so the multi-grove fan-out (periodic + on-demand)
// drives a test-controlled set of grove scopes without opening real SQLite DBs.
// The body is invoked once per scope, exactly as the real iterator would.
let groveScopesForMock: Array<{ id: string }> = [];
mock.module('@myco/daemon/scope-iteration.js', () => ({
  forEachGrove: forEachGroveMock,
}));

describe('team-sync reconcile triggers', () => {
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

  // Per-test spy injected as the per-partition reconcile orchestrator.
  const reconcilePartitionSpy = vi.fn(async () => {});

  beforeEach(() => {
    vi.clearAllMocks();
    groveScopesForMock = [];
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-reconcile-triggers-'));
    vaultDir = path.join(tmpDir, '.myco');
    previousMycoHome = process.env.MYCO_HOME;
    prevLegacyHomes = process.env.MYCO_TEAM_LEGACY_HOMES;
    process.env.MYCO_HOME = path.join(tmpDir, 'home');
    process.env.MYCO_TEAM_HOME = path.join(tmpDir, 'team-home');
    process.env.MYCO_TEAM_LEGACY_HOMES = '';
    fs.mkdirSync(vaultDir, { recursive: true });
    enqueueBatchMock.mockResolvedValue({ accepted: 0, rejected: [] });
    listPendingMock.mockReturnValue([]);
    backfillUnsyncedMock.mockReturnValue(0);
    upsertSelfMemberMock.mockReturnValue({ inserted: false, row: {} });
    // clearAllMocks resets call history but NOT implementations, so restore the
    // default no-op pass here (the throwing-reconcile test overrides it).
    reconcilePartitionSpy.mockImplementation(async () => {});
    // Same restore for the worker protocol probe (version-gate tests override).
    getWorkerProtocolVersionMock.mockImplementation(() => 3);
    // Default fan-out: replay whatever scopes the test registered.
    forEachGroveMock.mockImplementation(
      async (
        _cache: unknown,
        _logger: unknown,
        body: (scope: { grove: { id: string; slug: string }; groveHome: string; databasePath: string; db: object }) => Promise<void>,
      ) => {
        for (const g of groveScopesForMock) {
          await body({ grove: { id: g.id, slug: 'slug' }, groveHome: '', databasePath: '', db: {} });
        }
        return { attempted: groveScopesForMock.length, ok: groveScopesForMock.length, failed: 0 };
      },
    );
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    delete process.env.MYCO_TEAM_HOME;
    if (prevLegacyHomes === undefined) delete process.env.MYCO_TEAM_LEGACY_HOMES;
    else process.env.MYCO_TEAM_LEGACY_HOMES = prevLegacyHomes;
  });

  /** Register a team owning `projectIds` in a fresh grove; returns the grove + ids. */
  async function registerGroveWithProjects(name: string, projectIds: string[]) {
    const { createGrove, registerProjectInGrove } = await import('../../packages/myco/src/grove/registry.js');
    const { createTeamId } = await import('../../packages/myco/src/grove/ids.js');
    const { teamRegistry } = await import('../../packages/myco/src/team/registry.js');
    const mycoHome = process.env.MYCO_HOME!;
    const grove = createGrove(name, mycoHome);
    for (const projectId of projectIds) {
      const projectRoot = path.join(tmpDir, 'projects', projectId);
      fs.mkdirSync(projectRoot, { recursive: true });
      registerProjectInGrove(
        grove.id,
        { projectId, projectName: projectId, projectRoot },
        mycoHome,
      );
    }
    const teamId = createTeamId();
    teamRegistry.save({
      team_id: teamId,
      name,
      worker_url: 'https://team.example.workers.dev',
      domain: null,
      mcp_endpoint: null,
      created_at: new Date().toISOString(),
      projects: projectIds.map((project_id) => ({ grove_id: grove.id, project_id })),
    });
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', 'routing-secret');
    return { grove, teamId };
  }

  function makeTeamSync() {
    return initTeamSync({
      liveConfig: {
        current: { team: { enabled: true, worker_url: 'https://team.example.workers.dev' } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(tmpDir, 'service'),
      reconcilePartitionImpl: reconcilePartitionSpy as never,
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

  /** Distinct args[1] objects passed to the reconcile spy. */
  function reconcileArgs(): Array<{
    teamId: string;
    projectId: string;
    table: string;
    forceFullDiff: boolean | undefined;
  }> {
    return reconcilePartitionSpy.mock.calls.map((c) => (c as unknown[])[1] as never);
  }

  it('reconcileClient reconciles every owned (grove, project) × eligible table after backfill', async () => {
    const { grove } = await registerGroveWithProjects('owns-two', ['p-a', 'p-b']);
    const teamSync = makeTeamSync();

    await teamSync.reconcileClient(requestContext(grove.id, 'p-a'));
    // The reconcile pass is dispatched fire-and-forget off the poll path; let it
    // settle before counting partition reconciles.
    await flushAsync();

    // 2 projects × 3 eligible tables = 6 partition reconciles.
    expect(reconcilePartitionSpy).toHaveBeenCalledTimes(6);
    const args = reconcileArgs();
    expect(new Set(args.map((a) => a.projectId))).toEqual(new Set(['p-a', 'p-b']));
    expect(new Set(args.map((a) => a.table))).toEqual(new Set(MOCK_RECONCILE_TABLES));
    // Poll path is count-first (cheap), never a forced full diff.
    expect(args.every((a) => a.forceFullDiff === false)).toBe(true);
    // Reconcile runs only after the backfill it follows.
    expect(backfillUnsyncedMock).toHaveBeenCalled();
  });

  it('the periodic team-sync-reconcile job runs the automatic full-diff reconcile across all groves', async () => {
    const a = await registerGroveWithProjects('grove-a', ['p-a']);
    const b = await registerGroveWithProjects('grove-b', ['p-b']);
    groveScopesForMock = [{ id: a.grove.id }, { id: b.grove.id }];
    const teamSync = makeTeamSync();

    const jobs: Array<{ name: string; kind: string; runIn: string[]; fn: (ctx: unknown) => Promise<unknown> }> = [];
    const runner = { register: (j: (typeof jobs)[number]) => jobs.push(j) } as never;
    teamSync.registerFlushJob(runner, {} as never);

    const reconcileJob = jobs.find((j) => j.name === 'team-sync-reconcile');
    expect(reconcileJob).toBeDefined();
    expect(reconcileJob!.kind).toBe('housekeeping');

    await reconcileJob!.fn({ sliceBudget: { maxItems: 0, softDeadlineMs: 0 } });

    // 2 groves × 1 project × 3 tables = 6 partition reconciles.
    expect(reconcilePartitionSpy).toHaveBeenCalledTimes(6);
    const args = reconcileArgs();
    expect(new Set(args.map((a2) => a2.projectId))).toEqual(new Set(['p-a', 'p-b']));
    // The backstop always forces a full diff to catch equal-count / different-set
    // drift the poll path misses.
    expect(args.every((a2) => a2.forceFullDiff === true)).toBe(true);
  });

  it('the on-demand entrypoint reconciles automatically across all groves', async () => {
    const a = await registerGroveWithProjects('grove-a', ['p-a']);
    groveScopesForMock = [{ id: a.grove.id }];
    const teamSync = makeTeamSync();

    await teamSync.reconcileAllGroves({} as never);

    expect(reconcilePartitionSpy).toHaveBeenCalledTimes(MOCK_RECONCILE_TABLES.length);
    const args = reconcileArgs();
    expect(args.every((a2) => a2.forceFullDiff === true)).toBe(true);
  });

  it('does not reconcile a grove with no member projects (not participates / not membershipSeeded)', async () => {
    // The machine joined a team via ANOTHER grove, so machineHasAnyTeam() is
    // true, but THIS grove owns no member project — both `participates` and
    // `membershipSeeded` reduce to an empty member set, so reconcile is skipped.
    await registerGroveWithProjects('elsewhere', ['p-elsewhere']);
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const hereGrove = createGrove('here', process.env.MYCO_HOME!);
    const teamSync = makeTeamSync();

    await teamSync.reconcileClient(requestContext(hereGrove.id, 'p-here'));

    expect(reconcilePartitionSpy).not.toHaveBeenCalled();
    // Backfill still runs (it carries the machine-scoped self-row); reconcile
    // is the only thing gated off here.
    expect(backfillUnsyncedMock).toHaveBeenCalled();
  });

  it('the periodic job skips a grove with no member projects', async () => {
    const { createGrove } = await import('../../packages/myco/src/grove/registry.js');
    const empty = createGrove('empty', process.env.MYCO_HOME!);
    groveScopesForMock = [{ id: empty.id }];
    const teamSync = makeTeamSync();

    await teamSync.reconcileAllGroves({} as never);

    expect(reconcilePartitionSpy).not.toHaveBeenCalled();
  });

  it('throttles repeated reconcileClient passes for one grove but never throttles the on-demand path', async () => {
    const { grove } = await registerGroveWithProjects('owns-two', ['p-a', 'p-b']);
    groveScopesForMock = [{ id: grove.id }];
    const teamSync = makeTeamSync();

    // Two back-to-back Team-page polls of the same grove, well inside the throttle
    // window: the first dispatches a reconcile pass, the second is rate-limited.
    await teamSync.reconcileClient(requestContext(grove.id, 'p-a'));
    await teamSync.reconcileClient(requestContext(grove.id, 'p-a'));
    await flushAsync();

    // Exactly ONE poll-path pass ran (count-first; 2 projects × 3 tables = 6), not two.
    const pollPath = reconcileArgs().filter((a) => a.forceFullDiff === false);
    expect(pollPath.length).toBe(6);

    // The on-demand path bypasses the throttle entirely: it runs immediately even
    // though a poll-path pass just executed for the same grove. It full-diffs.
    await teamSync.reconcileAllGroves({} as never);
    const onDemand = reconcileArgs().filter((a) => a.forceFullDiff === true);
    expect(onDemand.length).toBe(6);
  });

  it('a throwing reconcile pass does not propagate out of reconcileClient and does not break the flush', async () => {
    reconcilePartitionSpy.mockImplementation(() => {
      throw new Error('reconcile boom');
    });
    const { grove } = await registerGroveWithProjects('owns-one', ['p-a']);
    const teamSync = makeTeamSync();

    // reconcileClient must RESOLVE (not reject) even though the injected reconcile
    // partition throws on the fire-and-forget pass.
    await expect(
      teamSync.reconcileClient(requestContext(grove.id, 'p-a')),
    ).resolves.toBeUndefined();
    await flushAsync();

    // The pass was attempted; its throw was caught + logged, never propagated.
    expect(reconcilePartitionSpy).toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalled();
    // The flush still ran despite the reconcile failure — listPending is touched
    // only by the flush drain, so its invocation proves flushPending executed.
    expect(listPendingMock).toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // forceFullDiff threading: backstop/on-demand → true, poll path → false
  // ---------------------------------------------------------------------------

  it('reconcileAllGroves (backstop/on-demand) reaches reconcilePartition with forceFullDiff:true', async () => {
    const a = await registerGroveWithProjects('force-diff-grove', ['p-fd']);
    groveScopesForMock = [{ id: a.grove.id }];
    const teamSync = makeTeamSync();

    await teamSync.reconcileAllGroves({} as never);

    const args = reconcileArgs();
    expect(args.length).toBeGreaterThan(0);
    expect(args.every((a2) => a2.forceFullDiff === true)).toBe(true);
  });

  it('reconcileClient poll path reaches reconcilePartition with forceFullDiff:false', async () => {
    const { grove } = await registerGroveWithProjects('poll-path-grove', ['p-pp']);
    const teamSync = makeTeamSync();

    await teamSync.reconcileClient(requestContext(grove.id, 'p-pp'));
    await flushAsync();

    const args = reconcileArgs();
    expect(args.length).toBeGreaterThan(0);
    expect(args.every((a2) => a2.forceFullDiff === false)).toBe(true);
  });

  it('skips tables newer than the worker protocol and warns once per team', async () => {
    // Worker advertises protocol 2 — skill_lineage (protocol 3) must be
    // skipped instead of hammering the worker with 400s every cycle.
    getWorkerProtocolVersionMock.mockImplementation(() => 2);
    const { grove } = await registerGroveWithProjects('old-worker-grove', ['p-ow']);
    const teamSync = makeTeamSync();

    await teamSync.reconcileClient(requestContext(grove.id, 'p-ow'));
    await flushAsync();

    const tables = reconcileArgs().map((a) => a.table);
    expect(new Set(tables)).toEqual(new Set(['sessions', 'spores']));
    expect(tables).not.toContain('skill_lineage');
    const warn = logger.warn.mock.calls.find(
      (c) => String((c as unknown[])[1]).includes('newer than the worker protocol'),
    );
    expect(warn).toBeDefined();
    expect(((warn as unknown[])[2] as { skipped_tables: string[] }).skipped_tables).toEqual(['skill_lineage']);
  });

  it('reconciles every table when the worker protocol is unprobed', async () => {
    // An unreachable/unprobed worker leaves the version undefined — the gate
    // stays open and the normal per-partition error handling applies.
    getWorkerProtocolVersionMock.mockImplementation(() => undefined);
    const { grove } = await registerGroveWithProjects('unprobed-grove', ['p-up']);
    const teamSync = makeTeamSync();

    await teamSync.reconcileClient(requestContext(grove.id, 'p-up'));
    await flushAsync();

    const tables = reconcileArgs().map((a) => a.table);
    expect(new Set(tables)).toEqual(new Set(MOCK_RECONCILE_TABLES));
  });
});
