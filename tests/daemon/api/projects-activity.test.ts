import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { createProjectsActivityHandler } from '@myco/daemon/api/projects-activity.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { openDatabase, closeDatabase } from '@myco/db/client.js';
import {
  createGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { MycoConfigSchema, type MycoConfig } from '@myco/config/schema.js';
import { epochSeconds } from '@myco/constants.js';
import type { RouteRequest } from '@myco/daemon/router.js';

function makeLogger(workDir: string): DaemonLogger {
  return new DaemonLogger(path.join(workDir, 'logs'), { level: 'error' });
}

function makeConfig(coldDays = 14): MycoConfig {
  return MycoConfigSchema.parse({
    version: 3,
    agent: { cold_project_threshold_days: coldDays },
  });
}

function emptyRequest(): RouteRequest {
  return { body: undefined, query: {}, params: {}, pathname: '/api/projects/activity' };
}

describe('projects activity API', () => {
  let workDir: string;
  let mycoHome: string;
  let previousMycoHome: string | undefined;
  let logger: DaemonLogger;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-activity-'));
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

  /**
   * Insert one session row directly into the Grove's DB at a given
   * `created_at` (epoch seconds). Used to simulate "last activity"
   * for warm/cold tests without going through the lifecycle path.
   */
  function insertSession(grove: GroveRecord, projectId: string, secondsAgo: number): void {
    const databasePath = resolveGroveDbPath(grove.id, mycoHome);
    const db = openDatabase(databasePath);
    try {
      const now = epochSeconds();
      db.prepare(
        `INSERT INTO sessions (id, project_id, agent, started_at, created_at, status)
         VALUES (?, ?, 'claude-code', ?, ?, 'active')`,
      ).run(`sess-${Math.random()}`, projectId, now - secondsAgo, now - secondsAgo);
    } finally {
      closeDatabase(databasePath);
    }
  }

  function makeHandler(coldDays = 14) {
    const cache = new GroveRuntimeCache();
    const liveConfig = { current: makeConfig(coldDays) };
    const handler = createProjectsActivityHandler({
      logger,
      liveConfig,
      cache,
      mycoHome,
      daemonStateDir: path.join(mycoHome, 'service'),
    });
    return { cache, handler };
  }

  it('returns an empty list when no projects are registered', async () => {
    const { cache, handler } = makeHandler();
    const response = await handler(emptyRequest());
    const body = response.body as { projects: unknown[]; active_window_days: number };
    expect(body.projects).toEqual([]);
    expect(body.active_window_days).toBe(14);
    cache.closeAll();
  });

  it('returns one row per (grove, project) tuple', async () => {
    const a = createGroveWithDb('Alpha');
    const b = createGroveWithDb('Bravo');
    registerProject(a, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
    registerProject(a, 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'a2');
    registerProject(b, 'proj_cccccccccccccccccccccccccccccccc', 'b1');

    const { cache, handler } = makeHandler();
    const response = await handler(emptyRequest());
    const body = response.body as { projects: Array<{ project_id: string; grove_id: string }> };
    expect(body.projects).toHaveLength(3);
    const ids = new Set(body.projects.map((p) => `${p.grove_id}:${p.project_id}`));
    expect(ids).toContain(`${a.id}:proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`);
    expect(ids).toContain(`${a.id}:proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`);
    expect(ids).toContain(`${b.id}:proj_cccccccccccccccccccccccccccccccc`);
    cache.closeAll();
  });

  it('marks projects with recent activity as active and old projects as cold', async () => {
    const grove = createGroveWithDb('Alpha');
    const warm = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const cold = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    registerProject(grove, warm, 'warm');
    registerProject(grove, cold, 'cold');

    insertSession(grove, warm, 60); // 1 minute ago
    insertSession(grove, cold, 60 * 60 * 24 * 30); // 30 days ago

    const { cache, handler } = makeHandler(14);
    const response = await handler(emptyRequest());
    const body = response.body as {
      projects: Array<{ project_id: string; is_active: boolean; last_activity_at: string | null }>;
    };
    const warmRow = body.projects.find((p) => p.project_id === warm);
    const coldRow = body.projects.find((p) => p.project_id === cold);
    expect(warmRow?.is_active).toBe(true);
    expect(coldRow?.is_active).toBe(false);
    expect(warmRow?.last_activity_at).not.toBeNull();
    expect(coldRow?.last_activity_at).not.toBeNull();
    cache.closeAll();
  });

  it('treats projects with zero activity as cold and reports null last_activity_at', async () => {
    const grove = createGroveWithDb('Alpha');
    registerProject(grove, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'a1');
    const { cache, handler } = makeHandler();
    const response = await handler(emptyRequest());
    const body = response.body as { projects: Array<{ is_active: boolean; last_activity_at: string | null }> };
    expect(body.projects[0]!.is_active).toBe(false);
    expect(body.projects[0]!.last_activity_at).toBeNull();
    cache.closeAll();
  });

  it('sorts active projects before cold ones', async () => {
    const grove = createGroveWithDb('Alpha');
    const warm = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const cold = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    registerProject(grove, cold, 'z-cold'); // alphabetically later
    registerProject(grove, warm, 'a-warm');
    insertSession(grove, warm, 60);

    const { cache, handler } = makeHandler();
    const response = await handler(emptyRequest());
    const body = response.body as { projects: Array<{ project_id: string; is_active: boolean }> };
    expect(body.projects[0]!.project_id).toBe(warm);
    expect(body.projects[0]!.is_active).toBe(true);
    cache.closeAll();
  });

  it('reflects the configured active-window threshold', async () => {
    const { cache, handler } = makeHandler(7);
    const response = await handler(emptyRequest());
    const body = response.body as { active_window_days: number };
    expect(body.active_window_days).toBe(7);
    cache.closeAll();
  });
});
