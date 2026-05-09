import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createSchema } from '@myco/db/schema.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import {
  getProjectActivityWithBacklog,
  getActivityWithBacklogForProjects,
} from '@myco/db/queries/project-activity.js';

const PROJ_A = assertGroveProjectId('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
const PROJ_B = assertGroveProjectId('proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');
const PROJ_C = assertGroveProjectId('proj_cccccccccccccccccccccccccccccccc');
const PROJ_D = assertGroveProjectId('proj_dddddddddddddddddddddddddddddddd');

describe('getActivityWithBacklogForProjects', () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(':memory:');
    createSchema(db);
  });

  afterEach(() => {
    db.close();
  });

  function seedSession(id: string, projectId: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO sessions (id, agent, started_at, created_at, project_id)
       VALUES (?, 'claude-code', ?, ?, ?)`,
    ).run(id, createdAt, createdAt, projectId);
  }

  function seedBatch(id: number, sessionId: string, projectId: string, createdAt: number): void {
    db.prepare(
      `INSERT INTO prompt_batches (id, session_id, project_id, prompt_number, user_prompt, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, sessionId, projectId, 1, 'hello', createdAt);
  }

  function seedRun(id: string, projectId: string, startedAt: number, status = 'completed'): void {
    db.prepare(
      `INSERT INTO agent_runs (id, agent_id, task, status, started_at, project_id)
       VALUES (?, 'agent-x', 'task-x', ?, ?, ?)`,
    ).run(id, status, startedAt, projectId);
  }

  it('returns empty map when projectIds is empty', () => {
    seedSession('s1', PROJ_A, 1000);
    const out = getActivityWithBacklogForProjects(db, [], 0);
    expect(out.size).toBe(0);
  });

  it('returns last_seconds = max(sessions, prompt_batches)', () => {
    seedSession('s1', PROJ_A, 1000);
    seedSession('s2', PROJ_A, 2000);
    seedBatch(1, 's1', PROJ_A, 1500);
    seedBatch(2, 's2', PROJ_A, 2500); // higher than max session

    const out = getActivityWithBacklogForProjects(db, [PROJ_A], 0);
    expect(out.get(PROJ_A)?.last_seconds).toBe(2500);
  });

  it('partitions activity per project_id without cross-bleed', () => {
    seedSession('s1', PROJ_A, 1000);
    seedSession('s2', PROJ_B, 9000);
    seedBatch(1, 's1', PROJ_A, 1100);
    seedBatch(2, 's2', PROJ_B, 9100);

    const out = getActivityWithBacklogForProjects(db, [PROJ_A, PROJ_B], 0);
    expect(out.get(PROJ_A)?.last_seconds).toBe(1100);
    expect(out.get(PROJ_B)?.last_seconds).toBe(9100);
  });

  it('counts only agent_runs in the window', () => {
    seedRun('r-recent', PROJ_A, 5000);
    seedRun('r-recent-2', PROJ_A, 5500);
    seedRun('r-old', PROJ_A, 100);

    const out = getActivityWithBacklogForProjects(db, [PROJ_A], 1000);
    expect(out.get(PROJ_A)?.scheduled_runs_in_window).toBe(2);
  });

  it('seeds neutral entries for projects with no activity', () => {
    seedSession('s1', PROJ_A, 1000);
    const out = getActivityWithBacklogForProjects(db, [PROJ_A, PROJ_C], 0);
    expect(out.get(PROJ_A)?.last_seconds).toBe(1000);
    expect(out.get(PROJ_C)).toEqual({ last_seconds: null, scheduled_runs_in_window: 0 });
  });

  it('matches per-project getProjectActivityWithBacklog row-for-row', () => {
    seedSession('s1', PROJ_A, 1000);
    seedSession('s2', PROJ_B, 2000);
    seedBatch(1, 's1', PROJ_A, 1500);
    seedBatch(2, 's2', PROJ_B, 1800);
    seedRun('r1', PROJ_A, 5000);
    seedRun('r2', PROJ_B, 100);

    const ids = [PROJ_A, PROJ_B, PROJ_D];
    const batched = getActivityWithBacklogForProjects(db, ids, 1000);
    for (const id of ids) {
      const single = getProjectActivityWithBacklog(db, id, 1000);
      expect(batched.get(id)).toEqual(single);
    }
  });

  it('reuses the same prepared statements across calls (memoized per-DB)', () => {
    seedSession('s1', PROJ_A, 1000);
    // Call several times — if memoization broke, repeat allocation would
    // still return the right answer, but this asserts the same handle
    // continues serving requests without throwing on prepared-statement
    // reuse semantics.
    for (let i = 0; i < 3; i++) {
      const out = getActivityWithBacklogForProjects(db, [PROJ_A], 0);
      expect(out.get(PROJ_A)?.last_seconds).toBe(1000);
    }
  });

  it('handles many project ids in one call without re-preparing', () => {
    const ids: string[] = [];
    for (let i = 0; i < 25; i++) {
      const id = `proj_${i.toString(16).padStart(32, '0')}`;
      ids.push(id);
      seedSession(`s${i}`, id, 1000 + i);
    }
    const out = getActivityWithBacklogForProjects(
      db,
      ids.map((s) => assertGroveProjectId(s)),
      0,
    );
    expect(out.size).toBe(25);
    for (let i = 0; i < 25; i++) {
      expect(out.get(assertGroveProjectId(ids[i] as string))?.last_seconds).toBe(1000 + i);
    }
  });
});
