import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { createMaintenanceHandlers, __testing } from '@myco/daemon/api/maintenance.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import {
  createGrove,
  registerProjectInGrove,
  UnknownGroveError,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { withDatabase } from '@myco/db/client.js';
import { upsertReleaseState } from '@myco/db/queries/release-provenance.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';
import { acquireProjectLease } from '@myco/grove/project-lease.js';

function makeLogger(workDir: string): DaemonLogger {
  return new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });
}

function makeConfig(): MycoConfig {
  return MycoConfigSchema.parse({ version: 3 });
}

function emptyRequest(params: Record<string, string> = {}): RouteRequest {
  return { body: undefined, query: {}, params, pathname: '/api/maintenance/summary' };
}

// Stub embedding factory: real one needs an LLM provider, which is
// overkill for these tests. The summary path is resilient to missing
// embedding runtimes (returns 0 pending).
function noopEmbeddingFactory() {
  return { vectorStore: undefined as never, embeddingManager: undefined };
}

function withinHours(iso: string | null, hours: number): boolean {
  if (!iso) return false;
  return Date.now() - Date.parse(iso) < hours * 60 * 60 * 1000;
}

describe('maintenance API', () => {
  let workDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let previousVariant: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-api-'));
    mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    // Keep the daemon-variant env out of these cases (ownership is the
    // home now, not the variant); restore it in afterEach.
    previousVariant = process.env.MYCO_SERVICE_VARIANT;
    delete process.env.MYCO_SERVICE_VARIANT;
    logger = makeLogger(workDir);
  });

  afterEach(() => {
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
    if (previousVariant === undefined) delete process.env.MYCO_SERVICE_VARIANT;
    else process.env.MYCO_SERVICE_VARIANT = previousVariant;
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  function createGroveWithDb(name: string): GroveRecord {
    const grove = createGrove(name, mycoHome);
    ensureGroveDatabase(grove.id, mycoHome);
    return grove;
  }

  function registerProject(grove: GroveRecord, projectId: string, slug: string): void {
    const projectRoot = path.join(workDir, 'projects', slug);
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: slug,
      projectRoot,
    }, mycoHome);
  }

  function makeHandlers() {
    const cache = new GroveRuntimeCache();
    const liveConfig = { current: makeConfig() };
    const handlers = createMaintenanceHandlers({
      logger,
      liveConfig,
      cache,
      embeddingRuntimeFactory: noopEmbeddingFactory,
      mycoHome,
      daemonStateDir: path.join(mycoHome, 'service'),
      lockNamespace: testPerUserLockNamespace,
    });
    return { cache, handlers, liveConfig };
  }

  // ---------------------------------------------------------------------
  // computeFlags
  // ---------------------------------------------------------------------

  describe('computeFlags', () => {
    it('counts overdue backups against the configured threshold', () => {
      const longAgo = new Date(Date.now() - 100 * 60 * 60 * 1000).toISOString();
      const recent = new Date(Date.now() - 1 * 60 * 60 * 1000).toISOString();
      const flags = __testing.computeFlags(
        [
          {
            grove: { id: 'g1', slug: 'a', name: 'A', mode: 'local' },
            project_count: 0, db_size_bytes: 0, log_count: 0, embedding_pending: 0,
            last_backup_at: longAgo,
            last_optimize_at: recent,
            last_vacuum_at: null,
            last_integrity_check: null,
            error: null,
          },
          {
            grove: { id: 'g2', slug: 'b', name: 'B', mode: 'local' },
            project_count: 0, db_size_bytes: 0, log_count: 0, embedding_pending: 0,
            last_backup_at: recent,
            last_optimize_at: recent,
            last_vacuum_at: null,
            last_integrity_check: null,
            error: null,
          },
        ],
        { backup_overdue_hours: 36, optimize_overdue_hours: 72 },
      );
      expect(flags.backup_overdue).toBe(1);
      expect(flags.optimize_overdue).toBe(0);
      expect(flags.error_count).toBe(0);
    });

    it('treats null last_* as overdue', () => {
      const flags = __testing.computeFlags(
        [
          {
            grove: { id: 'g1', slug: 'a', name: 'A', mode: 'local' },
            project_count: 0, db_size_bytes: 0, log_count: 0, embedding_pending: 0,
            last_backup_at: null,
            last_optimize_at: null,
            last_vacuum_at: null,
            last_integrity_check: null,
            error: null,
          },
        ],
        { backup_overdue_hours: 36, optimize_overdue_hours: 72 },
      );
      expect(flags.backup_overdue).toBe(1);
      expect(flags.optimize_overdue).toBe(1);
    });

    it('counts integrity_issues only when status is "issues"', () => {
      const recent = new Date(Date.now() - 1000).toISOString();
      const flags = __testing.computeFlags(
        [
          {
            grove: { id: 'g1', slug: 'a', name: 'A', mode: 'local' },
            project_count: 0, db_size_bytes: 0, log_count: 0, embedding_pending: 0,
            last_backup_at: recent,
            last_optimize_at: recent,
            last_vacuum_at: null,
            last_integrity_check: { at: recent, status: 'issues' },
            error: null,
          },
          {
            grove: { id: 'g2', slug: 'b', name: 'B', mode: 'local' },
            project_count: 0, db_size_bytes: 0, log_count: 0, embedding_pending: 0,
            last_backup_at: recent,
            last_optimize_at: recent,
            last_vacuum_at: null,
            last_integrity_check: { at: recent, status: 'ok' },
            error: null,
          },
        ],
        { backup_overdue_hours: 36, optimize_overdue_hours: 72 },
      );
      expect(flags.integrity_issues).toBe(1);
    });

    it('counts errored Groves separately and skips threshold checks for them', () => {
      const flags = __testing.computeFlags(
        [
          {
            grove: { id: 'g1', slug: 'a', name: 'A', mode: 'local' },
            project_count: 0, db_size_bytes: 0, log_count: 0, embedding_pending: 0,
            last_backup_at: null, last_optimize_at: null, last_vacuum_at: null,
            last_integrity_check: null,
            error: 'broken',
          },
        ],
        { backup_overdue_hours: 36, optimize_overdue_hours: 72 },
      );
      expect(flags.error_count).toBe(1);
      expect(flags.backup_overdue).toBe(0);
      expect(flags.optimize_overdue).toBe(0);
    });
  });

  // ---------------------------------------------------------------------
  // resolveLastIntegrity
  // ---------------------------------------------------------------------

  describe('resolveLastIntegrity', () => {
    it('returns null when no signal exists', () => {
      expect(__testing.resolveLastIntegrity(null, null)).toBeNull();
    });
    it('prefers ok when ok timestamp is more recent', () => {
      const result = __testing.resolveLastIntegrity(2000, 1000);
      expect(result?.status).toBe('ok');
    });
    it('prefers issues when issues timestamp is more recent', () => {
      const result = __testing.resolveLastIntegrity(1000, 2000);
      expect(result?.status).toBe('issues');
    });
    it('treats equal timestamps as ok (last write wins toward green)', () => {
      const result = __testing.resolveLastIntegrity(2000, 2000);
      expect(result?.status).toBe('ok');
    });
  });

  // ---------------------------------------------------------------------
  // GET /api/maintenance/summary
  // ---------------------------------------------------------------------

  describe('handleSummary', () => {
    it('is empty when no Groves are registered', async () => {
      const { cache, handlers } = makeHandlers();
      const response = await handlers.handleSummary(emptyRequest());
      const body = response.body as Awaited<ReturnType<typeof handlers.handleSummary>>['body'] & {
        groves: unknown[];
      };
      expect(body.groves).toEqual([]);
      cache.closeAll();
    });

    it('returns one row per registered Grove with project counts', async () => {
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      registerProject(a, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a2');
      registerProject(b, 'proj_cccccccccccccccccccccccccccccccc', 'b1');

      const { cache, handlers } = makeHandlers();
      const response = await handlers.handleSummary(emptyRequest());
      const body = response.body as {
        groves: Array<{ grove: { id: string }; project_count: number; error: string | null }>;
      };
      const byId = new Map(body.groves.map((g) => [g.grove.id, g]));
      expect(byId.get(a.id)?.project_count).toBe(2);
      expect(byId.get(b.id)?.project_count).toBe(1);
      expect(byId.get(a.id)?.error).toBeNull();
      cache.closeAll();
    });

    it('includes release provenance counts for each Grove', async () => {
      const grove = createGroveWithDb('Alpha');
      const { cache, handlers } = makeHandlers();
      const db = cache.getDatabase(resolveGroveDbPath(grove.id, mycoHome));
      withDatabase(db, () => {
        upsertReleaseState({
          namespace: 'sessions',
          record_id: 'session-maintenance-release',
          state: 'unknown',
          confidence: 'low',
          basis_kind: 'missing_git_evidence',
          checked_at: 1_800_000_000,
          created_at: 1_800_000_000,
        });
      });

      const response = await handlers.handleSummary(emptyRequest());
      const body = response.body as {
        groves: Array<{ release_provenance?: { derived_count: number; unknown_count: number; last_checked_at: string | null } }>;
      };
      expect(body.groves[0]?.release_provenance).toMatchObject({
        derived_count: 1,
        unknown_count: 1,
        last_checked_at: '2027-01-15T08:00:00.000Z',
      });
      cache.closeAll();
    });

    it('flags Groves with no backup as backup_overdue', async () => {
      createGroveWithDb('Alpha');
      const { cache, handlers } = makeHandlers();
      const response = await handlers.handleSummary(emptyRequest());
      const body = response.body as {
        flags: { backup_overdue: number };
        thresholds: { backup_overdue_hours: number };
      };
      expect(body.flags.backup_overdue).toBe(1);
      expect(body.thresholds.backup_overdue_hours).toBeGreaterThan(0);
      cache.closeAll();
    });

    it('reports a backup as recent when a backup file exists in the Grove home', async () => {
      const grove = createGroveWithDb('Alpha');
      const groveHome = resolveGroveDir(grove.id, mycoHome);
      const backupDir = path.join(groveHome, 'backups');
      fs.mkdirSync(backupDir, { recursive: true });
      // listBackups parses files matching the BACKUP_FILENAME_PATTERN —
      // e.g. <machine_id>.sql; touch one with a recent mtime.
      const file = path.join(backupDir, 'machine-test.sql');
      fs.writeFileSync(file, 'INSERT OR IGNORE INTO sessions (id) VALUES ("x");\n');

      const { cache, handlers } = makeHandlers();
      const response = await handlers.handleSummary(emptyRequest());
      const body = response.body as {
        groves: Array<{ last_backup_at: string | null }>;
        flags: { backup_overdue: number };
      };
      expect(body.groves).toHaveLength(1);
      expect(body.groves[0]!.last_backup_at).not.toBeNull();
      expect(withinHours(body.groves[0]!.last_backup_at, 1)).toBe(true);
      expect(body.flags.backup_overdue).toBe(0);
      cache.closeAll();
    });
  });

  // ---------------------------------------------------------------------
  // GET /api/groves/:id/maintenance
  // ---------------------------------------------------------------------

  describe('handleGroveMaintenance', () => {
    it('throws UnknownGroveError for an unknown Grove id without creating groves/<id>/ (transport maps it to 404)', async () => {
      const { cache, handlers } = makeHandlers();
      const unknownId = 'grove_' + 'f'.repeat(32);
      for (const id of [unknownId, 'grv_does_not_exist']) {
        let caught: unknown;
        try {
          await handlers.handleGroveMaintenance(emptyRequest({ id }));
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(UnknownGroveError);
      }
      // The well-formed unknown id must not have materialized a Grove dir.
      expect(fs.existsSync(resolveGroveDir(unknownId, mycoHome))).toBe(false);
      cache.closeAll();
    });

    it('refuses a Grove that lives in another daemon home, without opening its DB', async () => {
      // Ownership is the home: a Grove created under a different MYCO_HOME
      // is not present in this handler's home (`mycoHome`), so the
      // home-scoped lookup returns null and `assertOwnedGrove` throws
      // UnknownGroveError — the foreign Grove's DB is never opened here.
      // Proven with two real homes; a no-op gate would open it.
      const foreignHome = path.join(workDir, 'home-B');
      fs.mkdirSync(foreignHome, { recursive: true });
      const grove = createGrove('Dogfood', foreignHome);
      const { cache, handlers } = makeHandlers();
      let caught: unknown;
      try {
        await handlers.handleGroveMaintenance(emptyRequest({ id: grove.id }));
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(UnknownGroveError);
      expect(fs.existsSync(resolveGroveDbPath(grove.id, mycoHome))).toBe(false);
      cache.closeAll();
    });

    it('returns the same shape as a row in /summary for the requested Grove', async () => {
      const grove = createGroveWithDb('Alpha');
      registerProject(grove, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      const { cache, handlers } = makeHandlers();
      const response = await handlers.handleGroveMaintenance(emptyRequest({ id: grove.id }));
      const body = response.body as { grove: { id: string }; project_count: number };
      expect(body.grove.id).toBe(grove.id);
      expect(body.project_count).toBe(1);
      cache.closeAll();
    });
  });

  // ---------------------------------------------------------------------
  // handleReleaseProvenanceReconcile — project write admission
  //
  // This route carries no project in its path, so the central per-project
  // HTTP write gate never fires; `reconcileReleaseProvenance` upserts
  // project-scoped `knowledge_release_state` rows for every project in
  // every Grove. The consult therefore lives in the per-project loop.
  // ---------------------------------------------------------------------

  describe('handleReleaseProvenanceReconcile — write admission', () => {
    const HELD = 'proj_11111111111111111111111111111111';
    const FREE = 'proj_22222222222222222222222222222222';

    interface ReconcileRow { project_id: string; error?: string }
    function rows(body: unknown): ReconcileRow[] {
      return (body as { results: ReconcileRow[] }).results;
    }
    function visitedProjectIds(body: unknown): string[] {
      // A skipped project still appears, carrying an error explaining why —
      // a 200 that silently omitted it would read as "reconciled".
      return rows(body).filter((r) => !r.error?.startsWith('skipped:')).map((r) => r.project_id);
    }
    function skippedProjectIds(body: unknown): string[] {
      return rows(body).filter((r) => r.error?.startsWith('skipped:')).map((r) => r.project_id);
    }

    it('visits every project when no lease is held (the gate is not always-on)', async () => {
      const grove = createGroveWithDb('Alpha');
      registerProject(grove, HELD, 'held');
      registerProject(grove, FREE, 'free');
      const { cache, handlers } = makeHandlers();

      const response = await handlers.handleReleaseProvenanceReconcile(emptyRequest({}));

      expect(visitedProjectIds(response.body).sort()).toEqual([HELD, FREE].sort());
      expect(skippedProjectIds(response.body)).toEqual([]);
      cache.closeAll();
    });

    it('skips a project whose write lease is held, and visits the others', async () => {
      const grove = createGroveWithDb('Alpha');
      registerProject(grove, HELD, 'held');
      registerProject(grove, FREE, 'free');
      acquireProjectLease(HELD, 'residency-detach', 'leaving the team', null, mycoHome, testPerUserLockNamespace);
      const { cache, handlers } = makeHandlers();

      const response = await handlers.handleReleaseProvenanceReconcile(emptyRequest({}));

      expect(visitedProjectIds(response.body)).toEqual([FREE]);
      // Reported, not silently dropped.
      expect(skippedProjectIds(response.body)).toEqual([HELD]);
      expect(rows(response.body).find((r) => r.project_id === HELD)!.error).toContain('being moved');
      cache.closeAll();
    });

    it('skips on an unreadable lease record — a torn read is never "unheld"', async () => {
      const grove = createGroveWithDb('Alpha');
      registerProject(grove, HELD, 'held');
      registerProject(grove, FREE, 'free');
      const leasePath = path.join(mycoHome, 'leases', `${HELD}.json`);
      fs.mkdirSync(path.dirname(leasePath), { recursive: true });
      fs.writeFileSync(leasePath, '{ torn', 'utf-8');
      const { cache, handlers } = makeHandlers();

      const response = await handlers.handleReleaseProvenanceReconcile(emptyRequest({}));

      expect(visitedProjectIds(response.body)).toEqual([FREE]);
      expect(skippedProjectIds(response.body)).toEqual([HELD]);
      cache.closeAll();
    });
  });
});
