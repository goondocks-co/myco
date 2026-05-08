import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import {
  forEachGrove,
  forEachRegisteredProject,
  isProjectActive,
} from '@myco/daemon/scope-iteration.js';
import { openDatabase, getDatabase } from '@myco/db/client.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { createGrove, registerProjectInGrove, type GroveRecord } from '@myco/grove/registry.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

const MACHINE_ID = 'machine-test';

function makeLogger(workDir: string): DaemonLogger {
  return new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });
}

describe('scope-iteration', () => {
  let workDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scope-iteration-'));
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

  function registerProject(grove: GroveRecord, projectId: string, slug: string): string {
    const projectRoot = path.join(workDir, 'projects', slug);
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: slug,
      projectRoot,
    }, mycoHome);
    return projectRoot;
  }

  // -------------------------------------------------------------------------
  // forEachGrove
  // -------------------------------------------------------------------------

  describe('forEachGrove', () => {
    it('is a no-op summary when no Groves are registered', async () => {
      const cache = new GroveRuntimeCache();
      const summary = await forEachGrove(cache, logger, () => {
        throw new Error('body should not run');
      }, { mycoHome });
      expect(summary).toEqual({ attempted: 0, ok: 0, failed: 0, skipped: 0 });
      cache.closeAll();
    });

    it('visits every Grove and exposes the per-Grove DB + paths', async () => {
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      const cache = new GroveRuntimeCache();
      const seen: Array<{ id: string; databasePath: string }> = [];
      const summary = await forEachGrove(cache, logger, ({ grove, databasePath, db }) => {
        seen.push({ id: grove.id, databasePath });
        // Schema is real — we should be able to query.
        db.prepare('SELECT 1').get();
      }, { mycoHome });
      expect(summary).toEqual({ attempted: 2, ok: 2, failed: 0, skipped: 0 });
      const ids = seen.map((s) => s.id).sort();
      expect(ids).toEqual([a.id, b.id].sort());
      expect(seen.find((s) => s.id === a.id)?.databasePath).toBe(resolveGroveDbPath(a.id, mycoHome));
      cache.closeAll();
    });

    it('scopes getDatabase() to the per-Grove handle inside the body', async () => {
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      const cache = new GroveRuntimeCache();
      const observed = new Map<string, string>();
      await forEachGrove(cache, logger, ({ grove, databasePath }) => {
        const scopedDb = getDatabase();
        // Smoke: scoped handle is the one we expect — write a marker row
        // and read it back via getDatabase() to confirm scoping holds.
        scopedDb.prepare('CREATE TABLE IF NOT EXISTS marker (k TEXT)').run();
        scopedDb.prepare('INSERT INTO marker (k) VALUES (?)').run(grove.id);
        const row = getDatabase()
          .prepare('SELECT k FROM marker WHERE k = ?')
          .get(grove.id) as { k: string } | undefined;
        observed.set(databasePath, row?.k ?? '');
      }, { mycoHome });
      expect(observed.get(resolveGroveDbPath(a.id, mycoHome))).toBe(a.id);
      expect(observed.get(resolveGroveDbPath(b.id, mycoHome))).toBe(b.id);
      cache.closeAll();
    });

    it('isolates per-Grove failures and continues the sweep', async () => {
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      const c = createGroveWithDb('Charlie');
      const cache = new GroveRuntimeCache();
      const visited: string[] = [];
      const summary = await forEachGrove(cache, logger, ({ grove }) => {
        visited.push(grove.id);
        if (grove.id === b.id) throw new Error('boom');
      }, { mycoHome });
      expect(summary.attempted).toBe(3);
      expect(summary.ok).toBe(2);
      expect(summary.failed).toBe(1);
      expect(visited.sort()).toEqual([a.id, b.id, c.id].sort());
      cache.closeAll();
    });

    it('shouldVisitGrove skips Groves before any DB open', async () => {
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      const c = createGroveWithDb('Charlie');
      const cache = new GroveRuntimeCache();
      const visited: string[] = [];
      const summary = await forEachGrove(cache, logger, ({ grove }) => {
        visited.push(grove.id);
      }, {
        mycoHome,
        shouldVisitGrove: (grove) => grove.id !== b.id,
      });
      expect(summary.attempted).toBe(2);
      expect(summary.ok).toBe(2);
      expect(summary.failed).toBe(0);
      expect(summary.skipped).toBe(1);
      expect(visited.sort()).toEqual([a.id, c.id].sort());
      cache.closeAll();
    });

    it('shouldVisitGrove returning false for every Grove is a fast no-op', async () => {
      createGroveWithDb('Alpha');
      createGroveWithDb('Bravo');
      const cache = new GroveRuntimeCache();
      let bodyCalls = 0;
      const summary = await forEachGrove(cache, logger, () => {
        bodyCalls += 1;
      }, {
        mycoHome,
        shouldVisitGrove: () => false,
      });
      expect(bodyCalls).toBe(0);
      expect(summary.attempted).toBe(0);
      expect(summary.skipped).toBe(2);
      // The cache was never touched — size stays at 0.
      expect(cache.size()).toBe(0);
      cache.closeAll();
    });

    it('keeps the Grove pinned across body await points so a deeper sweep cannot evict it', async () => {
      // Capacity 1 + an inner getDatabase(otherGrove) inside the body
      // would normally evict the outer Grove. Pinning prevents that.
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      const cache = new GroveRuntimeCache({ capacity: 1 });
      const dbHandlesByGrove = new Map<string, ReturnType<GroveRuntimeCache['getDatabase']>>();
      await forEachGrove(cache, logger, async ({ grove, db }) => {
        dbHandlesByGrove.set(grove.id, db);
        // Touch an unrelated DB inside the body — must not invalidate
        // our pinned handle.
        cache.getDatabase(resolveGroveDbPath(
          grove.id === a.id ? b.id : a.id,
          mycoHome,
        ));
        await Promise.resolve();
        // Original handle is still usable.
        expect(() => db.prepare('SELECT 1').get()).not.toThrow();
      }, { mycoHome });
      expect(dbHandlesByGrove.size).toBe(2);
      cache.closeAll();
    });
  });

  // -------------------------------------------------------------------------
  // forEachRegisteredProject
  // -------------------------------------------------------------------------

  describe('forEachRegisteredProject', () => {
    it('visits every (grove, project) tuple', async () => {
      const a = createGroveWithDb('Alpha');
      const b = createGroveWithDb('Bravo');
      registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      registerProject(a, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a2');
      registerProject(b, 'proj_cccccccccccccccccccccccccccccccc', 'b1');
      const cache = new GroveRuntimeCache();
      const seen: Array<{ groveId: string; projectId: string }> = [];
      const summary = await forEachRegisteredProject(cache, logger, ({ grove, projectId }) => {
        seen.push({ groveId: grove.id, projectId });
      }, { mycoHome, machineId: MACHINE_ID });
      expect(summary.attempted).toBe(3);
      expect(summary.ok).toBe(3);
      expect(seen.length).toBe(3);
      expect(seen.filter((s) => s.groveId === a.id).map((s) => s.projectId).sort()).toEqual([
        'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      ].sort());
      cache.closeAll();
    });

    it('builds a request context with the right projectId, groveId, and paths', async () => {
      const a = createGroveWithDb('Alpha');
      const root = registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      const cache = new GroveRuntimeCache();
      let captured: ReturnType<typeof JSON.parse> | null = null;
      await forEachRegisteredProject(cache, logger, ({ requestContext }) => {
        captured = JSON.parse(JSON.stringify(requestContext));
      }, { mycoHome, machineId: MACHINE_ID });
      expect(captured).toMatchObject({
        projectRoot: path.resolve(root),
        projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        groveId: a.id,
        machineId: MACHINE_ID,
        sessionId: null,
        databasePath: resolveGroveDbPath(a.id, mycoHome),
        source: 'explicit',
      });
      cache.closeAll();
    });

    it('reuses the Grove DB handle across all projects in that Grove', async () => {
      const a = createGroveWithDb('Alpha');
      registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      registerProject(a, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a2');
      const cache = new GroveRuntimeCache();
      const handles = new Set<unknown>();
      await forEachRegisteredProject(cache, logger, ({ db }) => {
        handles.add(db);
      }, { mycoHome, machineId: MACHINE_ID });
      expect(handles.size).toBe(1);
      cache.closeAll();
    });

    it('isolates per-project failures', async () => {
      const a = createGroveWithDb('Alpha');
      registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      registerProject(a, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a2');
      const cache = new GroveRuntimeCache();
      const summary = await forEachRegisteredProject(cache, logger, ({ projectId }) => {
        if (projectId === 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa') {
          throw new Error('boom');
        }
      }, { mycoHome, machineId: MACHINE_ID });
      expect(summary).toEqual({ attempted: 2, ok: 1, failed: 1 });
      cache.closeAll();
    });

    it('honors shouldVisit predicate to gate the body', async () => {
      const a = createGroveWithDb('Alpha');
      registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
      registerProject(a, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a2');
      const cache = new GroveRuntimeCache();
      const visited: string[] = [];
      await forEachRegisteredProject(cache, logger, ({ projectId }) => {
        visited.push(projectId);
      }, {
        mycoHome,
        machineId: MACHINE_ID,
        shouldVisit: ({ projectId }) => projectId === 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });
      expect(visited).toEqual(['proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']);
      cache.closeAll();
    });
  });

  // -------------------------------------------------------------------------
  // isProjectActive
  // -------------------------------------------------------------------------

  describe('isProjectActive', () => {
    it('returns false for projects with no recent sessions or batches', () => {
      const grove = createGroveWithDb('Alpha');
      const dbPath = resolveGroveDbPath(grove.id, mycoHome);
      const db = openDatabase(dbPath);
      try {
        const projectId = assertGroveProjectId('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        const cutoff = Math.floor(Date.now() / 1000) - 60;
        expect(isProjectActive(db, projectId, cutoff)).toBe(false);
      } finally {
        db.close();
      }
    });

    it('returns true when sessions has a row at or after the cutoff', () => {
      const grove = createGroveWithDb('Alpha');
      const dbPath = resolveGroveDbPath(grove.id, mycoHome);
      const db = openDatabase(dbPath);
      try {
        const projectId = assertGroveProjectId('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
          `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
           VALUES (?, 'test', ?, ?, ?)`,
        ).run('sess-active', projectId, now, now);
        expect(isProjectActive(db, projectId, now - 1)).toBe(true);
        expect(isProjectActive(db, projectId, now + 60)).toBe(false);
      } finally {
        db.close();
      }
    });

    it('returns true when prompt_batches has a recent row even if sessions does not', () => {
      const grove = createGroveWithDb('Alpha');
      const dbPath = resolveGroveDbPath(grove.id, mycoHome);
      const db = openDatabase(dbPath);
      try {
        const projectId = assertGroveProjectId('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        const now = Math.floor(Date.now() / 1000);
        // A session row is still required for the FK on prompt_batches,
        // but its created_at is BEFORE the cutoff so the activity must
        // come from the batch row.
        const oldSessionAt = now - 86400;
        db.prepare(
          `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
           VALUES (?, 'test', ?, ?, ?)`,
        ).run('sess-old', projectId, oldSessionAt, oldSessionAt);
        db.prepare(
          `INSERT INTO prompt_batches (project_id, session_id, kind, created_at)
           VALUES (?, ?, 'initial', ?)`,
        ).run(projectId, 'sess-old', now);
        expect(isProjectActive(db, projectId, now - 1)).toBe(true);
      } finally {
        db.close();
      }
    });

    it('does not match other projects in the same Grove DB', () => {
      const grove = createGroveWithDb('Alpha');
      const dbPath = resolveGroveDbPath(grove.id, mycoHome);
      const db = openDatabase(dbPath);
      try {
        const otherId = assertGroveProjectId('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
        const askedId = assertGroveProjectId('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
        const now = Math.floor(Date.now() / 1000);
        db.prepare(
          `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
           VALUES (?, 'test', ?, ?, ?)`,
        ).run('sess-other', otherId, now, now);
        expect(isProjectActive(db, askedId, now - 1)).toBe(false);
      } finally {
        db.close();
      }
    });
  });
});

