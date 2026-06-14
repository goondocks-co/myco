/**
 * Integration tests for the multi-Grove team-sync flush fan-out.
 *
 * Verifies that registerFlushJob (and its `flushAllGroves` core) drains
 * pending outbox rows in *every* registered Grove's SQLite DB, not just
 * the boot Grove. Pre-Grove behavior used the global `getDatabase()`
 * singleton, which meant non-boot Groves' team_outbox tables were
 * silently never read once the daemon was multi-Grove. See plan
 * 4ab20d9762619a6e (A1, A2, A4) and the release-blocker review finding
 * #1.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { vi } from '../helpers/vi-shim.js';

const enqueueBatchByGrove = new Map<string, Array<{ count: number }>>();
const connectMock = vi.fn();

// Track which TeamSyncClient was hit per Grove so we can assert that the
// flush actually fanned out and that each invocation drained that
// Grove's outbox (rather than the boot Grove's).
mock.module('@myco/daemon/team-sync.js', () => ({
  TeamSyncClient: class {
    private readonly groveTag: string;
    constructor(options: { workerUrl: string }) {
      // Worker URLs are shaped `https://grove-<groveId>.example...` in
      // these fixtures so we can route each enqueueBatch back to its
      // originating Grove for assertions.
      const match = options.workerUrl.match(/grove-([^.]+)/);
      this.groveTag = match ? match[1] : 'unknown';
    }
    connect = connectMock;
    enqueueBatch = async (records: unknown[]) => {
      // Filter out the `team_members` self-row enqueue that reconcileClient
      // emits — these tests assert seeded-row fanout, and the self-member
      // bookkeeping happens incidentally during reconcile().
      const seeded = (records as Array<{ table_name?: string }>).filter(
        (r) => r.table_name !== 'team_members',
      );
      if (seeded.length > 0) {
        const list = enqueueBatchByGrove.get(this.groveTag) ?? [];
        list.push({ count: seeded.length });
        enqueueBatchByGrove.set(this.groveTag, list);
      }
      return { accepted: records.length, rejected: [] };
    };
    getCollectiveStatus = vi.fn();
    getMcpToken = vi.fn(() => null);
    getMcpEndpoint = vi.fn(() => null);
  },
}));

import { initTeamSync } from '@myco/daemon/team-sync-init.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { withDatabase } from '@myco/db/client.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGrove, type GroveRecord } from '@myco/grove/registry.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import { enqueueOutbox, listPending } from '@myco/db/queries/team-outbox.js';
import { getSyncableProjectIds } from '@myco/db/queries/team-sync-state.js';
import { teamRegistry } from '@myco/team/registry.js';
import { createTeamId, createProjectId } from '@myco/grove/ids.js';

describe('team-sync flush fan-out across Groves', () => {
  let tmpDir: string;
  let mycoHome: string;
  let bootVaultDir: string;
  let previousMycoHome: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-fanout-'));
    mycoHome = path.join(tmpDir, 'home');
    bootVaultDir = path.join(tmpDir, '.myco');
    fs.mkdirSync(mycoHome, { recursive: true });
    fs.mkdirSync(path.join(mycoHome, 'service'), { recursive: true });
    fs.mkdirSync(bootVaultDir, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    logger = new DaemonLogger(path.join(tmpDir, 'logs'), { level: 'error' });
    enqueueBatchByGrove.clear();
    projectByGrove.clear();
    connectMock.mockReset();
    connectMock.mockResolvedValue({});
  });

  afterEach(() => {
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Each Grove maps to one team whose single project's rows we seed. flush
  // routing is registry-driven, so the Grove must participate via the registry
  // (not just grove.yaml). The team worker_url embeds the grove id so the mock
  // above can still route enqueueBatch back per Grove via the `grove-<id>` tag.
  const projectByGrove = new Map<string, string>();

  function createGroveWithTeamConfig(name: string): GroveRecord {
    const grove = createGrove(name, mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    const groveDir = resolveGroveDir(grove.id, mycoHome);
    fs.mkdirSync(groveDir, { recursive: true });
    fs.writeFileSync(
      path.join(groveDir, 'grove.yaml'),
      [
        'team:',
        '  enabled: true',
        `  worker_url: https://grove-${grove.id}.example.workers.dev`,
      ].join('\n'),
      'utf-8',
    );
    fs.writeFileSync(
      path.join(groveDir, 'secrets.env'),
      `MYCO_TEAM_API_KEY=secret-for-${grove.id}\n`,
      'utf-8',
    );

    const projectId = createProjectId();
    projectByGrove.set(grove.id, projectId);
    const teamId = createTeamId();
    teamRegistry.save(
      {
        team_id: teamId,
        name: `${name} Team`,
        // worker_url embeds the grove id so the per-Grove mock routing holds.
        worker_url: `https://grove-${grove.id}.example.workers.dev`,
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: grove.id, project_id: projectId }],
      },
      mycoHome,
    );
    teamRegistry.writeSecret(teamId, 'MYCO_TEAM_API_KEY', `secret-for-${grove.id}`, mycoHome);
    return grove;
  }

  function seedOutbox(grove: GroveRecord, cache: GroveRuntimeCache, rowIds: string[]): void {
    const dbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    const db = cache.getDatabase(dbPath);
    const projectId = projectByGrove.get(grove.id) ?? null;
    withDatabase(db, () => {
      for (const rowId of rowIds) {
        enqueueOutbox({
          table_name: 'spores',
          row_id: rowId,
          payload: JSON.stringify({ id: rowId, content: 'x', project_id: projectId }),
          machine_id: 'machine-1',
          project_id: projectId,
          created_at: Math.floor(Date.now() / 1000),
        });
      }
    });
  }

  function pendingCount(grove: GroveRecord, cache: GroveRuntimeCache): number {
    const dbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    const db = cache.getDatabase(dbPath);
    return withDatabase(db, () => listPending().length);
  }

  /** Seed an UNSYNCED source spore (synced_at NULL) so reconcile's backfill picks it up. */
  function seedUnsyncedSpore(grove: GroveRecord, cache: GroveRuntimeCache, id: string): void {
    const dbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    const db = cache.getDatabase(dbPath);
    const projectId = projectByGrove.get(grove.id)!;
    withDatabase(db, () => {
      db.prepare(
        `INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('user','user','built-in',1,1)`,
      ).run();
      db.prepare(
        `INSERT INTO spores (id, project_id, agent_id, observation_type, content, created_at, machine_id)
         VALUES (?, ?, 'user', 'decision', 'x', 1, 'machine-1')`,
      ).run(id, projectId);
    });
  }

  function syncableProjects(grove: GroveRecord, cache: GroveRuntimeCache): string[] {
    const dbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    const db = cache.getDatabase(dbPath);
    return withDatabase(db, () => getSyncableProjectIds());
  }

  function buildGroveCtx(grove: GroveRecord) {
    return {
      projectRoot: tmpDir,
      projectVaultDir: bootVaultDir,
      projectId: projectByGrove.get(grove.id) ?? 'placeholder',
      groveId: grove.id,
      machineId: 'machine-1',
      sessionId: null,
      databasePath: path.join(mycoHome, 'groves', grove.id, 'myco.db'),
      source: 'explicit',
    } as never;
  }

  async function reconcile(teamSync: ReturnType<typeof initTeamSync>, grove: GroveRecord, cache: GroveRuntimeCache): Promise<void> {
    const dbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    await withDatabase(cache.getDatabase(dbPath), async () => {
      await teamSync.reconcileClient(buildGroveCtx(grove));
    });
  }

  it('drains pending outbox rows in every registered Grove', async () => {
    const groveOne = createGroveWithTeamConfig('Alpha');
    const groveTwo = createGroveWithTeamConfig('Bravo');
    const cache = new GroveRuntimeCache();

    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });

    // Reconcile first so the TeamSyncClient exists for each Grove. Then
    // seed the outbox — reconcile auto-flushes pending rows on success,
    // so seeding before reconcile would drain the rows we want to test.
    await reconcile(teamSync, groveOne, cache);
    await reconcile(teamSync, groveTwo, cache);

    seedOutbox(groveOne, cache, ['s1', 's2']);
    seedOutbox(groveTwo, cache, ['s3']);
    expect(pendingCount(groveOne, cache)).toBe(2);
    expect(pendingCount(groveTwo, cache)).toBe(1);

    expect(teamSync.getTeamClient(buildGroveCtx(groveOne))).not.toBeNull();
    expect(teamSync.getTeamClient(buildGroveCtx(groveTwo))).not.toBeNull();

    const aggregate = await teamSync.flushAllGroves(cache);

    expect(aggregate.groves).toBe(2);
    expect(aggregate.flushed).toBe(3);
    expect(aggregate.errors).toBe(0);

    // Both Groves' outboxes were drained from their own DBs.
    expect(pendingCount(groveOne, cache)).toBe(0);
    expect(pendingCount(groveTwo, cache)).toBe(0);

    // Both per-Grove TeamSyncClients were hit independently.
    expect(enqueueBatchByGrove.get(groveOne.id)?.[0]?.count).toBe(2);
    expect(enqueueBatchByGrove.get(groveTwo.id)?.[0]?.count).toBe(1);

    cache.closeAll();
  });

  it('isolates per-Grove flush so an unconfigured peer still drains', async () => {
    const groveOne = createGroveWithTeamConfig('Alpha');
    const groveTwo = createGroveWithTeamConfig('Bravo');
    const cache = new GroveRuntimeCache();

    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });

    // Make Grove One's team unbuildable by clearing its registry secret.
    // getOrBuildTeamClient returns null for that team, so Grove One's rows
    // stay pending (never dropped); Grove Two still drains on the same tick.
    const teamOne = teamRegistry
      .list(mycoHome)
      .find((t) => t.projects.some((p) => p.grove_id === groveOne.id))!;
    fs.writeFileSync(
      path.join(mycoHome, 'teams', teamOne.team_id, 'secrets.env'),
      '',
      'utf-8',
    );

    seedOutbox(groveOne, cache, ['s1']);
    seedOutbox(groveTwo, cache, ['s2']);

    const aggregate = await teamSync.flushAllGroves(cache);

    expect(aggregate.groves).toBe(2);
    expect(aggregate.flushed).toBe(1);
    expect(pendingCount(groveOne, cache)).toBe(1);
    expect(pendingCount(groveTwo, cache)).toBe(0);

    cache.closeAll();
  });

  it('shutdown-style flush drains pending rows before DB close', async () => {
    // Mirrors the shutdown sequence in daemon/main.ts: flushAllGroves
    // runs *before* runtimeCache.closeAll(), so rows enqueued just
    // before SIGTERM still get handed off to the worker. This locks
    // the ordering down — a refactor that closes DBs first would
    // surface here as a 0-flushed result instead of 2.
    const grove = createGroveWithTeamConfig('Alpha');
    const cache = new GroveRuntimeCache();

    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });
    await reconcile(teamSync, grove, cache);
    seedOutbox(grove, cache, ['x1', 'x2']);
    expect(pendingCount(grove, cache)).toBe(2);

    // SHUTDOWN: drain first, then close.
    const aggregate = await teamSync.flushAllGroves(cache);
    cache.closeAll();

    expect(aggregate.flushed).toBe(2);
    expect(aggregate.errors).toBe(0);
    expect(enqueueBatchByGrove.get(grove.id)?.[0]?.count).toBe(2);
  });

  it('handles registries with zero Groves cleanly', async () => {
    const cache = new GroveRuntimeCache();
    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });

    const aggregate = await teamSync.flushAllGroves(cache);

    expect(aggregate).toEqual({
      groves: 0,
      flushed: 0,
      rejected: 0,
      batches: 0,
      errors: 0,
    });

    cache.closeAll();
  });

  // --- reconcileGrove: the affected-grove immediate reconcile (Task 4b) ---

  it('reconcileGrove reconciles + backfills + flushes ONLY the affected grove', async () => {
    const affected = createGroveWithTeamConfig('Affected');
    const sibling = createGroveWithTeamConfig('Sibling');
    const cache = new GroveRuntimeCache();

    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });

    // Both groves own a member project (assigned by createGroveWithTeamConfig),
    // and each has an unsynced source spore. Reconciling only the affected grove
    // must backfill + flush its row to its worker while leaving the sibling's
    // row pending (untouched until its own reconcile / next flush tick).
    seedUnsyncedSpore(affected, cache, 'sp-affected');
    seedUnsyncedSpore(sibling, cache, 'sp-sibling');

    await teamSync.reconcileGrove(cache, affected.id);

    // Affected grove: membership table populated, its spore backfilled + flushed.
    expect(syncableProjects(affected, cache)).toEqual([projectByGrove.get(affected.id)!]);
    expect(pendingCount(affected, cache)).toBe(0);
    expect(enqueueBatchByGrove.get(affected.id)?.[0]?.count).toBe(1);

    // Sibling grove untouched by this reconcile — its row never reached a worker.
    expect(enqueueBatchByGrove.has(sibling.id)).toBe(false);
    expect(pendingCount(sibling, cache)).toBe(0);

    cache.closeAll();
  });

  it('reconcileGrove on a grove with no member projects clears membership and purges its outbox', async () => {
    // A grove whose only project is NOT a team member (a removed/never-assigned
    // project). reconcileGrove must set empty membership and purge the
    // project-scoped outbox rows, while the machine HAS joined a team elsewhere.
    const elsewhere = createGroveWithTeamConfig('Elsewhere');   // owns a member project
    const orphan = createGroveWithTeamConfig('Orphan');
    // Strip Orphan's project from its team so the grove owns no member project.
    const orphanTeam = teamRegistry
      .list(mycoHome)
      .find((t) => t.projects.some((p) => p.grove_id === orphan.id))!;
    teamRegistry.save(
      { ...orphanTeam, projects: orphanTeam.projects.filter((p) => p.grove_id !== orphan.id) },
      mycoHome,
    );

    const cache = new GroveRuntimeCache();
    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });

    // Pre-seed an orphan outbox row for the now-non-member project.
    seedOutbox(orphan, cache, ['stale-1']);
    expect(pendingCount(orphan, cache)).toBe(1);

    await teamSync.reconcileGrove(cache, orphan.id);

    expect(syncableProjects(orphan, cache)).toEqual([]);
    // The project-scoped stale row is purged by purgeNonMemberOutbox.
    expect(pendingCount(orphan, cache)).toBe(0);
    // The elsewhere grove (a different served grove) is NOT touched by a
    // single-grove reconcile.
    expect(enqueueBatchByGrove.has(elsewhere.id)).toBe(false);

    cache.closeAll();
  });

  it('reconcileGrove for an unknown grove id is a no-op (served-by / not-found scoping)', async () => {
    createGroveWithTeamConfig('Present');
    const cache = new GroveRuntimeCache();
    const teamSync = initTeamSync({
      liveConfig: {
        current: { team: { enabled: false, worker_url: undefined } },
      } as never,
      machineId: 'machine-1',
      logger: logger as never,
      vaultDir: bootVaultDir,
      serverVersion: '1.2.3',
      daemonStateDir: path.join(mycoHome, 'service'),
    });

    // No throw, no enqueue — a grove not served here is silently skipped and
    // the owning daemon's flush-tick backstop covers it.
    await teamSync.reconcileGrove(cache, 'grove_ffffffffffffffffffffffffffffffff');
    expect(enqueueBatchByGrove.size).toBe(0);

    cache.closeAll();
  });
});
