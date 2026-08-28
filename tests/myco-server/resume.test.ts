/**
 * Resume classification and admission — the properties 1.4 encodes, each of
 * which is silent when dropped.
 */
import { describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import {
  admitResume, classifyFailure, RESUME_MAX_ATTEMPTS, TERMINAL_RESUME_STATUSES,
  type FailureObservation,
} from '@myco-server-worker/core/resume.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import type { ReadScope } from '@myco-server-worker/read/scope.js';

const SCOPE: ReadScope = { projectId: 'proj_one' };
const AGENT = 'agent_1';
const NOW = 1_700_000_000_000;

function store(): { db: RelationalStore; sqlite: Database } {
  const sqlite = new Database(':memory:');
  for (const f of renderMigrationFiles()) sqlite.exec(f.sql);
  sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, ?, ?)`).run(SCOPE.projectId, 'p', NOW);
  sqlite.query(`INSERT INTO agents (id, name, source, enabled, created_at) VALUES (?, 'a', 'built-in', 1, ?)`).run(AGENT, NOW);
  return { db: sqliteRelationalStore(sqlite), sqlite };
}

const seedRun = (sqlite: Database, id: string, over: Partial<{ status: string; startedAt: number; completedAt: number | null; resumable: number; attempts: number; task: string; dryRun: number }> = {}) =>
  sqlite.query(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, resumable, resume_attempts, dry_run, started_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(SCOPE.projectId, id, AGENT, over.task ?? 'digest', over.status ?? 'failed',
      over.resumable ?? 1, over.attempts ?? 0, over.dryRun ?? 0,
      over.startedAt ?? NOW, over.completedAt ?? null);

const observed = (over: Partial<FailureObservation> = {}): FailureObservation => ({
  wasResume: false, hadPriorSession: false, recordedAnyTurns: false, errorClass: 'other', ...over,
});

const resumeRow = (id: string, over: Partial<{ attempts: number; startedAt: number; task: string; dryRun: boolean }> = {}) => ({
  id, agentId: AGENT, task: over.task ?? 'digest', dryRun: over.dryRun ?? false,
  startedAt: over.startedAt ?? NOW, resumeAttempts: over.attempts ?? 0,
});

describe('classifying a failure', () => {
  it('treats an ordinary failure as resumable and keeps its checkpoint', () => {
    expect(classifyFailure(observed())).toEqual({ resumable: true, status: 'ready', clearCheckpoints: false });
  });

  it('retires an expired session and DISCARDS the poisoned checkpoint', () => {
    const decision = classifyFailure(observed({ wasResume: true, hadPriorSession: true, errorClass: 'session-expired' }));
    expect(decision).toEqual({ resumable: false, status: 'session_expired', clearCheckpoints: true });
  });

  it('retires an unsatisfiable postcondition and KEEPS its checkpoint for inspection', () => {
    const decision = classifyFailure(observed({ errorClass: 'postcondition-unsatisfiable' }));
    expect(decision).toEqual({ resumable: false, status: 'postcondition_unsatisfiable', clearCheckpoints: false });
  });

  it('needs all three conditions for the zombie guard, never two', () => {
    // A fresh run that merely reports an expired session is an ordinary failure.
    expect(classifyFailure(observed({ hadPriorSession: true, errorClass: 'session-expired' })).status).toBe('ready');
    // A resume with no prior session cannot have a poisoned one.
    expect(classifyFailure(observed({ wasResume: true, errorClass: 'session-expired' })).status).toBe('ready');
    // A resume that DID work is a real failure, not a dead session.
    expect(classifyFailure(observed({ wasResume: true, hadPriorSession: true, recordedAnyTurns: true, errorClass: 'session-expired' })).status).toBe('ready');
  });

  it('keeps every terminal status distinct from ready', () => {
    expect(TERMINAL_RESUME_STATUSES).not.toContain('ready');
    expect(TERMINAL_RESUME_STATUSES.length).toBe(4);
  });
});

describe('admitting a resume', () => {
  it('consumes an attempt before dispatch, so a crash mid-resume still counts', async () => {
    const { db, sqlite } = store();
    seedRun(sqlite, 'r1');
    expect(await admitResume(db, SCOPE, resumeRow('r1'))).toEqual({ admit: true, attempt: 1 });
    expect((sqlite.query(`SELECT resume_attempts a FROM agent_runs WHERE id='r1'`).get() as { a: number }).a).toBe(1);
  });

  it('retires a run at the cap rather than resuming it again', async () => {
    const { db, sqlite } = store();
    seedRun(sqlite, 'r1', { attempts: RESUME_MAX_ATTEMPTS });
    expect(await admitResume(db, SCOPE, resumeRow('r1', { attempts: RESUME_MAX_ATTEMPTS }))).toEqual({ admit: false, status: 'exhausted' });
    const row = sqlite.query(`SELECT resumable, resume_status s FROM agent_runs WHERE id='r1'`).get() as { resumable: number; s: string };
    expect(row).toEqual({ resumable: 0, s: 'exhausted' });
  });

  it('never lets two racing wakes both consume the last attempt', async () => {
    const { db, sqlite } = store();
    seedRun(sqlite, 'r1', { attempts: RESUME_MAX_ATTEMPTS - 1 });
    const row = resumeRow('r1', { attempts: RESUME_MAX_ATTEMPTS - 1 });
    const [a, b] = await Promise.all([admitResume(db, SCOPE, row), admitResume(db, SCOPE, row)]);
    expect([a.admit, b.admit].filter(Boolean)).toHaveLength(1);
    expect((sqlite.query(`SELECT resume_attempts a FROM agent_runs WHERE id='r1'`).get() as { a: number }).a).toBe(RESUME_MAX_ATTEMPTS);
  });

  it('supersedes a run whose work a newer completed run already finished', async () => {
    const { db, sqlite } = store();
    seedRun(sqlite, 'failed', { startedAt: NOW });
    seedRun(sqlite, 'winner', { status: 'completed', startedAt: NOW + 1, completedAt: NOW + 100 });
    expect(await admitResume(db, SCOPE, resumeRow('failed'))).toEqual({ admit: false, status: 'superseded' });
    const row = sqlite.query(`SELECT resumable, resume_status s FROM agent_runs WHERE id='failed'`).get() as { resumable: number; s: string };
    expect(row).toEqual({ resumable: 0, s: 'superseded' });
  });

  it('checks supersession BEFORE the cap, so a finished job does not spend a retry', async () => {
    const { db, sqlite } = store();
    seedRun(sqlite, 'failed', { attempts: RESUME_MAX_ATTEMPTS });
    seedRun(sqlite, 'winner', { status: 'completed', completedAt: NOW + 100 });
    const outcome = await admitResume(db, SCOPE, resumeRow('failed', { attempts: RESUME_MAX_ATTEMPTS }));
    expect(outcome).toEqual({ admit: false, status: 'superseded' });
  });

  it('compares against the ORIGINAL dispatch, so a resumed run is not superseded by work older than it', async () => {
    const { db, sqlite } = store();
    // Dispatched long ago, resumed moments ago. A run that completed BEFORE the
    // original dispatch does not supersede it.
    seedRun(sqlite, 'failed', { startedAt: NOW });
    seedRun(sqlite, 'older', { status: 'completed', startedAt: NOW - 10_000, completedAt: NOW - 5_000 });
    expect(await admitResume(db, SCOPE, resumeRow('failed'))).toEqual({ admit: true, attempt: 1 });
  });

  it('supersedes only an equivalent run: not another task, and not across the dry-run line', async () => {
    const { db, sqlite } = store();
    seedRun(sqlite, 'failed');
    seedRun(sqlite, 'other_task', { status: 'completed', task: 'extract', completedAt: NOW + 100 });
    seedRun(sqlite, 'dry', { status: 'completed', dryRun: 1, completedAt: NOW + 100 });
    expect(await admitResume(db, SCOPE, resumeRow('failed'))).toEqual({ admit: true, attempt: 1 });
  });
});
