import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, type Database } from '@myco/db/client';
import { ensureGroveDatabase } from '@myco/grove/database.js';
import { createGrove, clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { resolveGroveDbPath } from '@myco/grove/paths.js';
import { decideColdProjectGate } from '@myco/daemon/task-scheduling.js';

const VALID_PROJECT_ID = 'proj_' + 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5';

describe('decideColdProjectGate', () => {
  let workDir: string;
  let prevHome: string | undefined;
  let db: Database;

  beforeEach(() => {
    workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cold-')));
    const mycoHome = path.join(workDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    prevHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    clearGroveRegistryCaches();

    const grove = createGrove('Solo', mycoHome);
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

  it('returns should_run=true with state=null when threshold is 0 (gate disabled)', () => {
    const decision = decideColdProjectGate({
      db,
      projectId: VALID_PROJECT_ID,
      thresholdDays: 0,
    });
    expect(decision).toEqual({ should_run: true, state: null });
  });

  it('returns should_run=true with state=null when projectId is null', () => {
    const decision = decideColdProjectGate({ db, projectId: null, thresholdDays: 14 });
    expect(decision).toEqual({ should_run: true, state: null });
  });

  it('returns should_run=true with state=null when projectId is non-Grove (legacy/boot)', () => {
    const decision = decideColdProjectGate({
      db,
      projectId: '/legacy/path/to/project',
      thresholdDays: 14,
    });
    expect(decision).toEqual({ should_run: true, state: null });
  });

  it('returns cold + should_run=false when no recent sessions or batches', () => {
    const decision = decideColdProjectGate({
      db,
      projectId: VALID_PROJECT_ID,
      thresholdDays: 14,
      now: Date.now(),
    });
    expect(decision.should_run).toBe(false);
    expect(decision.state).toBe('cold');
  });

  it('returns warm + should_run=true when a recent session exists', () => {
    const now = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('sess-fresh', VALID_PROJECT_ID, now, now);
    const decision = decideColdProjectGate({
      db,
      projectId: VALID_PROJECT_ID,
      thresholdDays: 14,
    });
    expect(decision.should_run).toBe(true);
    expect(decision.state).toBe('warm');
  });

  it('treats sessions older than the threshold as cold', () => {
    const longAgoSec = Math.floor((Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000);
    db.prepare(
      `INSERT INTO sessions (id, agent, project_id, started_at, created_at)
       VALUES (?, 'test', ?, ?, ?)`,
    ).run('sess-stale', VALID_PROJECT_ID, longAgoSec, longAgoSec);
    const decision = decideColdProjectGate({
      db,
      projectId: VALID_PROJECT_ID,
      thresholdDays: 14,
    });
    expect(decision.should_run).toBe(false);
    expect(decision.state).toBe('cold');
  });
});
