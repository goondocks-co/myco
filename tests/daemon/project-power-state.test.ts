import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ProjectPowerStateTracker,
  readProjectActivitySeed,
} from '@myco/daemon/project-power-state.js';
import { openDatabase, type Database } from '@myco/db/client.js';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';

const PROJECT_A = assertGroveProjectId('proj_' + 'a'.repeat(32));
const PROJECT_B = assertGroveProjectId('proj_' + 'b'.repeat(32));
const GROVE_X = 'grv_' + 'c'.repeat(32);
const GROVE_Y = 'grv_' + 'd'.repeat(32);

const THRESHOLDS = {
  idleThresholdMs: 5 * 60 * 1000,
  sleepThresholdMs: 30 * 60 * 1000,
  deepSleepThresholdMs: 90 * 60 * 1000,
};

describe('ProjectPowerStateTracker', () => {
  it('returns deep_sleep for un-seeded projects', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    expect(tracker.getState(GROVE_X, PROJECT_A)).toBe('deep_sleep');
  });

  it('moves through active → idle → sleep → deep_sleep as time passes since last activity', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    const start = 1_000_000_000_000;
    tracker.recordActivity(GROVE_X, PROJECT_A, start);

    expect(tracker.getState(GROVE_X, PROJECT_A, start + 0)).toBe('active');
    expect(tracker.getState(GROVE_X, PROJECT_A, start + THRESHOLDS.idleThresholdMs - 1)).toBe('active');
    expect(tracker.getState(GROVE_X, PROJECT_A, start + THRESHOLDS.idleThresholdMs)).toBe('idle');
    expect(tracker.getState(GROVE_X, PROJECT_A, start + THRESHOLDS.sleepThresholdMs)).toBe('sleep');
    expect(tracker.getState(GROVE_X, PROJECT_A, start + THRESHOLDS.deepSleepThresholdMs)).toBe('deep_sleep');
  });

  it('isolates per-(grove, project) state — each tuple has its own clock', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    const t = 1_000_000_000_000;
    tracker.recordActivity(GROVE_X, PROJECT_A, t);
    tracker.recordActivity(GROVE_Y, PROJECT_A, t - THRESHOLDS.deepSleepThresholdMs - 1);

    // Same project id, different grove: independent state.
    expect(tracker.getState(GROVE_X, PROJECT_A, t + 1000)).toBe('active');
    expect(tracker.getState(GROVE_Y, PROJECT_A, t + 1000)).toBe('deep_sleep');
  });

  it('recordActivity wakes a deep-sleeping project back to active', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    const start = 1_000_000_000_000;
    tracker.recordActivity(GROVE_X, PROJECT_A, start);
    const later = start + THRESHOLDS.deepSleepThresholdMs * 2;
    expect(tracker.getState(GROVE_X, PROJECT_A, later)).toBe('deep_sleep');

    tracker.recordActivity(GROVE_X, PROJECT_A, later);
    expect(tracker.getState(GROVE_X, PROJECT_A, later)).toBe('active');
  });

  it('seed only overwrites when the seed is newer than the live record', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    const live = 2_000_000;
    const stale = 1_000_000;
    const fresh = 3_000_000;

    tracker.recordActivity(GROVE_X, PROJECT_A, live);
    tracker.seed([{ groveId: GROVE_X, projectId: PROJECT_A, lastActivityMs: stale }]);
    expect(tracker.getLastActivity(GROVE_X, PROJECT_A)).toBe(live);

    tracker.seed([{ groveId: GROVE_X, projectId: PROJECT_A, lastActivityMs: fresh }]);
    expect(tracker.getLastActivity(GROVE_X, PROJECT_A)).toBe(fresh);
  });

  it('getStateWithHold lifts deep_sleep to sleep when the caller holds it', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    const start = 1_000_000_000_000;
    tracker.recordActivity(GROVE_X, PROJECT_A, start);
    const later = start + THRESHOLDS.deepSleepThresholdMs + 1;

    expect(tracker.getStateWithHold(GROVE_X, PROJECT_A, false, later)).toBe('deep_sleep');
    expect(tracker.getStateWithHold(GROVE_X, PROJECT_A, true, later)).toBe('sleep');
  });

  it('getStateWithHold leaves non-deep_sleep states untouched', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    const start = 1_000_000_000_000;
    tracker.recordActivity(GROVE_X, PROJECT_A, start);
    const idleAt = start + THRESHOLDS.idleThresholdMs + 1;

    expect(tracker.getStateWithHold(GROVE_X, PROJECT_A, true, idleAt)).toBe('idle');
    expect(tracker.getStateWithHold(GROVE_X, PROJECT_A, false, idleAt)).toBe('idle');
  });

  it('clear forgets a project (e.g. project removed)', () => {
    const tracker = new ProjectPowerStateTracker(THRESHOLDS);
    tracker.recordActivity(GROVE_X, PROJECT_A);
    expect(tracker.getLastActivity(GROVE_X, PROJECT_A)).toBeDefined();
    tracker.clear(GROVE_X, PROJECT_A);
    expect(tracker.getLastActivity(GROVE_X, PROJECT_A)).toBeUndefined();
    expect(tracker.getState(GROVE_X, PROJECT_A)).toBe('deep_sleep');
  });
});

describe('readProjectActivitySeed', () => {
  let workDir: string;
  let prevHome: string | undefined;
  let db: Database;
  let groveId: string;

  beforeEach(() => {
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pps-seed-')));
    const mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    prevHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    clearGroveRegistryCaches();

    const grove = createGrove('Solo', mycoHome);
    groveId = grove.id;
    ensureGroveDatabase(grove.id, mycoHome);
    db = openDatabase(resolveGroveDbPath(grove.id, mycoHome));
  });

  afterEach(() => {
    try { db.close(); } catch { /* noop */ }
    if (prevHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevHome;
    clearGroveRegistryCaches();
    fs.rmSync(workDir, { recursive: true, force: true });
  });

  it('returns an empty list when sessions and prompt_batches are empty', () => {
    expect(readProjectActivitySeed(db, groveId)).toEqual([]);
  });

  it('takes the most recent session created_at per project, converting seconds → ms', () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('s1', PROJECT_A, 1000, 1000);
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('s2', PROJECT_A, 2000, 2000);

    const seed = readProjectActivitySeed(db, groveId);
    expect(seed).toHaveLength(1);
    expect(seed[0]).toEqual({
      groveId,
      projectId: PROJECT_A,
      lastActivityMs: 2_000_000,
    });
  });

  it('combines sessions and prompt_batches, taking the max per project', () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('s1', PROJECT_A, 1000, 1000);
    db.prepare(
      `INSERT INTO prompt_batches (session_id, user_prompt, project_id, created_at, status)
       VALUES (?, ?, ?, ?, ?)`,
    ).run('s1', 'hello', PROJECT_A, 5000, 'active');

    const seed = readProjectActivitySeed(db, groveId);
    expect(seed).toHaveLength(1);
    expect(seed[0].lastActivityMs).toBe(5_000_000);
  });

  it('returns one row per project when multiple projects exist in the grove', () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('s1', PROJECT_A, 100, 100);
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('s2', PROJECT_B, 200, 200);

    const seed = readProjectActivitySeed(db, groveId);
    const byProject = new Map(seed.map((row) => [row.projectId, row.lastActivityMs]));
    expect(byProject.get(PROJECT_A)).toBe(100_000);
    expect(byProject.get(PROJECT_B)).toBe(200_000);
  });

  it('skips rows where project_id is NULL', () => {
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', NULL, ?, ?)`,
    ).run('s1', 1000, 1000);

    expect(readProjectActivitySeed(db, groveId)).toEqual([]);
  });
});
