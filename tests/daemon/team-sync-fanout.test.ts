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
      const list = enqueueBatchByGrove.get(this.groveTag) ?? [];
      list.push({ count: records.length });
      enqueueBatchByGrove.set(this.groveTag, list);
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
    connectMock.mockReset();
    connectMock.mockResolvedValue({});
  });

  afterEach(() => {
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

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
    return grove;
  }

  function seedOutbox(grove: GroveRecord, cache: GroveRuntimeCache, rowIds: string[]): void {
    const dbPath = path.join(mycoHome, 'groves', grove.id, 'myco.db');
    const db = cache.getDatabase(dbPath);
    withDatabase(db, () => {
      for (const rowId of rowIds) {
        enqueueOutbox({
          table_name: 'spores',
          row_id: rowId,
          payload: JSON.stringify({ id: rowId, content: 'x' }),
          machine_id: 'machine-1',
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

  function buildGroveCtx(grove: GroveRecord) {
    return {
      projectRoot: tmpDir,
      projectVaultDir: bootVaultDir,
      projectId: 'placeholder',
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

    // Only reconcile Grove Two. Grove One has no live client so its
    // flushPending early-returns (handedOff=0) without touching the
    // outbox; Grove Two should still drain on the same fan-out tick.
    await reconcile(teamSync, groveTwo, cache);

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
});
