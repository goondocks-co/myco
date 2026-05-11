import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { createMaintenanceHandlers, __testing } from '@myco/daemon/api/maintenance.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDir } from '@myco/grove/paths.js';
import {
  createGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import type { RouteRequest } from '@myco/daemon/router.js';

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
  let logger: DaemonLogger;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'maint-api-'));
    mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    logger = makeLogger(workDir);
  });

  afterEach(() => {
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
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
    it('returns 404 for an unknown Grove id', async () => {
      const { cache, handlers } = makeHandlers();
      const response = await handlers.handleGroveMaintenance(emptyRequest({ id: 'grv_does_not_exist' }));
      expect(response.status).toBe(404);
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
});
