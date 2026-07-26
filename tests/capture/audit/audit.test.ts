import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { checkIntegrity } from '@myco/capture/audit/checks/integrity.js';
import { checkClosure, hookClosingSymbionts } from '@myco/capture/audit/checks/closure.js';
import { checkReconcile, intentionallyDropped } from '@myco/capture/audit/checks/reconcile.js';
import { captureModel, classifyRecency, symbiontContexts } from '@myco/capture/audit/context.js';
import { runAudit } from '@myco/capture/audit/index.js';
import { repair } from '@myco/capture/audit/repair.js';
import { ACTIVITIES_TABLE, PROMPT_BATCHES_TABLE, SESSIONS_TABLE } from '@myco/db/schema-ddl.js';

const HOUR = 3600;
const DAY = 24 * HOUR;

let dir: string;
let dbPath: string;
let db: Database;
const NOW = 1_785_000_000;

function seedSession(id: string, over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id,
    agent: 'claude-code',
    project_id: 'proj_test',
    project_root: '/repo/test',
    started_at: NOW - DAY,
    status: 'completed',
    prompt_count: 0,
    created_at: NOW - DAY,
    ...over,
  };
  db.query(
    `INSERT INTO sessions (id, agent, project_id, project_root, started_at, status, prompt_count, created_at)
     VALUES ($id, $agent, $project_id, $project_root, $started_at, $status, $prompt_count, $created_at)`,
  ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as never])));
}

function seedBatch(id: string, sessionId: string, over: Partial<Record<string, unknown>> = {}) {
  const row = {
    id,
    session_id: sessionId,
    project_id: 'proj_test',
    kind: 'initial',
    origin: 'human',
    status: 'completed',
    activity_count: 1,
    content_hash: 'hash',
    response_summary: 'done',
    started_at: NOW - DAY,
    created_at: NOW - DAY,
    ...over,
  };
  db.query(
    `INSERT INTO prompt_batches (id, session_id, project_id, kind, origin, status, activity_count, content_hash, response_summary, started_at, created_at)
     VALUES ($id, $session_id, $project_id, $kind, $origin, $status, $activity_count, $content_hash, $response_summary, $started_at, $created_at)`,
  ).run(Object.fromEntries(Object.entries(row).map(([k, v]) => [`$${k}`, v as never])));
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-audit-'));
  dbPath = path.join(dir, 'myco.db');
  db = new Database(dbPath);
  db.run(SESSIONS_TABLE);
  db.run(PROMPT_BATCHES_TABLE);
  db.run(ACTIVITIES_TABLE);
});

afterEach(() => {
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('integrity checks', () => {
  it('reports NULL content_hash, which defeats dedup', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { content_hash: null });

    const ids = checkIntegrity(db, { dbPath }, NOW).map((f) => f.id);
    expect(ids).toContain('batch-null-content-hash');
  });

  it('does not report an active batch for a missing response — the turn is still running', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { status: 'active', response_summary: null });

    const ids = checkIntegrity(db, { dbPath }, NOW).map((f) => f.id);
    expect(ids).not.toContain('batch-missing-response');
  });

  it('reports counter drift between a session and its batches', () => {
    seedSession('s1', { prompt_count: 5 });
    seedBatch('b1', 's1');

    const drift = checkIntegrity(db, { dbPath }, NOW).find((f) => f.id === 'session-counter-drift');
    expect(drift?.count).toBe(1);
  });

  it('scopes to a project so one project cannot report another project rows', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { content_hash: null, project_id: 'proj_other' });

    const ids = checkIntegrity(db, { dbPath, projectId: 'proj_test' }, NOW).map((f) => f.id);
    expect(ids).not.toContain('batch-null-content-hash');
  });
});

describe('recency classification', () => {
  it('calls a class still occurring active', () => {
    expect(classifyRecency(NOW - HOUR, NOW)).toBe('active');
  });

  it('calls a class that stopped accruing legacy, so cleanup is bounded', () => {
    expect(classifyRecency(NOW - 60 * DAY, NOW)).toBe('legacy');
  });

  it('refuses to guess without a timestamp', () => {
    expect(classifyRecency(null, NOW)).toBe('unknown');
  });
});

describe('capture model', () => {
  it('treats agents whose transcripts are mined as hook-and-mining', () => {
    expect(captureModel('claude-code')).toBe('hook-and-mining');
    expect(captureModel('codex')).toBe('hook-and-mining');
  });

  it('treats plugin-reported agents as such, so a NULL transcript_path is not a defect', () => {
    // pi/opencode/cline post complete events from an in-agent plugin.
    expect(captureModel('opencode')).toBe('plugin-reported');
    expect(captureModel('pi')).toBe('plugin-reported');
    expect(captureModel('cline')).toBe('plugin-reported');
  });
});

describe('session closure', () => {
  const staleThresholdMs = HOUR * 1000;

  it('does not report a session inside the stale threshold', () => {
    seedSession('s1', { status: 'active', started_at: NOW - 60 });
    const { findings } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings).toEqual([]);
  });

  it('leaves a long-running session alone while it is still active', () => {
    // Staleness is inactivity, not age. An earlier version keyed on
    // started_at and flagged every session older than the threshold —
    // including the live session doing the auditing.
    seedSession('s1', { agent: 'claude-code', status: 'active', started_at: NOW - 30 * HOUR });
    seedBatch('b1', 's1', { started_at: NOW - 60 });

    const { findings } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings).toEqual([]);
  });

  it('blames the exit hook for an agent that closes via one', () => {
    seedSession('s1', { agent: 'claude-code', status: 'active', started_at: NOW - 5 * HOUR });
    seedBatch('b1', 's1', { started_at: NOW - 4 * HOUR });
    const { findings } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings[0]?.id).toBe('closure-exit-hook-missed');
  });

  it('blames the sweep when it ran and left the session open', () => {
    seedSession('s1', { agent: 'codex', status: 'active', started_at: NOW - 5 * HOUR });
    const { findings } = checkClosure(db, { dbPath }, NOW, {
      staleThresholdMs,
      lastSweepAt: NOW - 60,
    });
    expect(findings[0]?.id).toBe('closure-sweep-missed');
  });

  it('blames the schedule when no sweep has run — a different root cause entirely', () => {
    seedSession('s1', { agent: 'codex', status: 'active', started_at: NOW - 5 * HOUR });
    const { findings } = checkClosure(db, { dbPath }, NOW, {
      staleThresholdMs,
      lastSweepAt: NOW - 90 * DAY,
    });
    expect(findings[0]?.id).toBe('closure-sweep-not-running');
  });

  it('reports a coverage gap rather than guessing when the sweep time is unknown', () => {
    seedSession('s1', { agent: 'codex', status: 'active', started_at: NOW - 5 * HOUR });
    const { findings, coverage } = checkClosure(db, { dbPath }, NOW, { staleThresholdMs });
    expect(findings).toEqual([]);
    expect(coverage[0]?.reason).toContain('cannot be told apart');
  });

  it('derives closure mode from the hook templates rather than a hardcoded list', () => {
    const closing = hookClosingSymbionts();
    expect(closing.has('claude-code')).toBe(true);
    // Sweep-closing by design per the 2026-06-12 ruling — not a defect.
    expect(closing.has('codex')).toBe(false);
    expect(closing.has('windsurf')).toBe(false);
  });
});

describe('reverse reconciliation', () => {
  it('never reports transcript loss for a plugin-reported agent', () => {
    const contexts = symbiontContexts('opencode');
    const { findings, coverage } = checkReconcile(db, { dbPath }, NOW, contexts);
    expect(findings).toEqual([]);
    expect(coverage[0]?.reason).toContain('Plugin-reported');
  });

  /** Write a codex-style rollout whose first line is the session_meta entry. */
  function plantCodexTranscript(payload: Record<string, unknown>): string {
    const file = path.join(dir, 'rollout.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session_meta', timestamp: 'x', payload })}\n`);
    return file;
  }

  it('excludes a sub-agent thread — its turns are reattributed to the parent, not lost', () => {
    const file = plantCodexTranscript({
      id: '019f57ab-0000-0000-0000-000000000001',
      cwd: '/repo/test',
      source: {
        subagent: {
          thread_spawn: {
            parent_thread_id: '019f4cc0-be39-70d2-829d-bb92981279ab',
            agent_path: '/root/task_6_reviewer',
          },
        },
      },
    });
    expect(intentionallyDropped('codex', file)).toBe(true);
  });

  it('excludes a non-interactive exec run, which the manifest drops on purpose', () => {
    const file = plantCodexTranscript({ id: 'x', cwd: '/repo/test', source: 'exec' });
    expect(intentionallyDropped('codex', file)).toBe(true);
  });

  it('does NOT exclude an ordinary interactive session — that one really is loss', () => {
    const file = plantCodexTranscript({ id: 'y', cwd: '/repo/test', source: 'cli' });
    expect(intentionallyDropped('codex', file)).toBe(false);
  });
});

describe('runAudit', () => {
  it('opens the vault read-only, so a check cannot mutate it', () => {
    seedSession('s1', { prompt_count: 1 });
    seedBatch('b1', 's1', { content_hash: null });
    const before = fs.statSync(dbPath).size;

    const report = runAudit({ dbPath, projectId: 'proj_test' });

    expect(report.findings.some((f) => f.id === 'batch-null-content-hash')).toBe(true);
    expect(fs.statSync(dbPath).size).toBe(before);
  });

  it('orders findings by severity so the worst is read first', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1', { content_hash: null });
    seedBatch('b2', 's1', { status: 'completed', activity_count: 0 });

    const severities = runAudit({ dbPath, projectId: 'proj_test' }).findings.map((f) => f.severity);
    expect(severities).toEqual([...severities].sort((a, b) => (a === 'high' ? -1 : b === 'high' ? 1 : 0)));
  });

  it('always reports which capture model each symbiont uses', () => {
    const report = runAudit({ dbPath });
    expect(report.symbionts.find((s) => s.name === 'opencode')?.model).toBe('plugin-reported');
    expect(report.symbionts.find((s) => s.name === 'codex')?.model).toBe('hook-and-mining');
  });
});

describe('repair', () => {
  it('writes nothing without apply, however many rows it found', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1');

    const plan = repair({ dbPath, findingId: 'session-counter-drift' });

    expect(plan.rowCount).toBe(1);
    expect(plan.applied).toBe(false);
    expect(db.query('SELECT prompt_count c FROM sessions WHERE id = $id').get({ $id: 's1' })).toEqual({ c: 9 });
  });

  it('recomputes the counter from the rows it summarises when applied', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1');

    const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true });

    expect(plan.applied).toBe(true);
    expect(db.query('SELECT prompt_count c FROM sessions WHERE id = $id').get({ $id: 's1' })).toEqual({ c: 1 });
  });

  it('backs the vault up before its first write', () => {
    seedSession('s1', { prompt_count: 9 });
    seedBatch('b1', 's1');

    const plan = repair({ dbPath, findingId: 'session-counter-drift', apply: true });

    expect(plan.backupPath).toBe(`${dbPath}.bak`);
    expect(fs.existsSync(`${dbPath}.bak`)).toBe(true);
  });

  it('flags a large change set for re-confirmation instead of applying it silently', () => {
    for (let i = 0; i < 5; i++) {
      seedSession(`s${i}`, { prompt_count: 9 });
      seedBatch(`b${i}`, `s${i}`);
    }
    const plan = repair({ dbPath, findingId: 'session-counter-drift', confirmThreshold: 2 });
    expect(plan.requiresConfirmation).toBe(true);
    expect(plan.applied).toBe(false);
  });

  it('refuses content_hash backfill rather than writing a wrong dedup key', () => {
    const plan = repair({ dbPath, findingId: 'batch-null-content-hash', apply: true });
    expect(plan.supported).toBe(false);
    expect(plan.refusal).toContain('ordinal');
  });

  it('refuses to delete orphaned batches, which hold captured work', () => {
    const plan = repair({ dbPath, findingId: 'batch-orphaned', apply: true });
    expect(plan.supported).toBe(false);
    expect(plan.refusal).toContain('forbidden');
  });

  it('refuses an unknown finding id rather than doing nothing quietly', () => {
    const plan = repair({ dbPath, findingId: 'not-a-finding', apply: true });
    expect(plan.supported).toBe(false);
    expect(plan.refusal).toContain('Unknown finding id');
  });
});
