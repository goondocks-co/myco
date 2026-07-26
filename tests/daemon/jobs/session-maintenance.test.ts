import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { acquireProjectLease, releaseProjectLease } from '@myco/grove/project-lease.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import {
  completeStaleActiveSessions,
  findDeadSessionIds,
} from '@myco/daemon/jobs/session-maintenance.js';
import { MS_PER_SECOND, STALE_SESSION_THRESHOLD_MS } from '@myco/constants.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / MS_PER_SECOND);

/** Threshold in seconds. */
const STALE_THRESHOLD_S = STALE_SESSION_THRESHOLD_MS / MS_PER_SECOND;

/** Recording fake for the completion chokepoint's mining seam. */
function makeRecordingMiner() {
  const calls: Array<{ sessionId: string; agent: string; transcriptPath: string }> = [];
  return {
    calls,
    completion: {
      transcriptMiner: {
        reconcileAndAttributeResponses(sessionId: string, input: { agent: string; transcriptPath: string }) {
          calls.push({ sessionId, ...input });
          return {};
        },
      },
    },
  };
}

/** No-op completion deps for tests that don't assert mining. */
const noopCompletion = makeRecordingMiner().completion;

function seedSession(id: string, opts: {
  status?: string;
  promptCount?: number;
  startedAt?: number;
  batchStartedAt?: number;
}) {
  const now = epochNow();
  upsertSession({
    id,
    agent: 'test-agent',
    started_at: opts.startedAt ?? now,
    created_at: now,
    status: opts.status ?? 'active',
    prompt_count: opts.promptCount ?? 0,
  });

  // findDeadSessionIds (R4.18) derives the count from prompt_batches rows
  // directly, not from the cached sessions.prompt_count column. Seed real
  // rows so the helper's intent ("this session has N prompts") holds for
  // both the cached column and the derived count.
  const db = getDatabase();
  const insert = db.prepare(
    `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
     VALUES (?, ?, ?, ?, 'active')`,
  );
  const promptCount = opts.promptCount ?? 0;
  const baseStart = opts.batchStartedAt ?? opts.startedAt ?? now;
  for (let i = 1; i <= promptCount; i++) {
    insert.run(id, i, baseStart, now);
  }
  // Even when promptCount=0, callers may set batchStartedAt to assert the
  // stale-active path on a session that had a single in-progress batch.
  if (opts.batchStartedAt !== undefined && promptCount === 0) {
    insert.run(id, 1, opts.batchStartedAt, now);
  }
}

describe('completeStaleActiveSessions', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('completes active sessions with no prompts older than threshold', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-1', { status: 'active', startedAt: staleTime });

    const count = completeStaleActiveSessions(noopCompletion);

    expect(count).toBe(1);
    const session = getSession('stale-1', ALL_PROJECTS_SCOPE);
    expect(session?.status).toBe('completed');
  });

  it('completes active sessions whose last prompt is older than threshold', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-2', { status: 'active', batchStartedAt: staleTime });

    const count = completeStaleActiveSessions(noopCompletion);

    expect(count).toBe(1);
    const session = getSession('stale-2', ALL_PROJECTS_SCOPE);
    expect(session?.status).toBe('completed');
  });

  it('completes idle sessions regardless of whether they are still registered', () => {
    // Registry-exclusion was previously applied here and created a bug: a
    // user with the TUI open but idle for >24h kept a session indefinitely
    // active, which blocked every intelligence task from seeing its data.
    // The activity-timestamp check itself is sufficient protection — a
    // resumed session gets flipped back to 'active' by event-dispatch.
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('registered-but-idle', { status: 'active', startedAt: staleTime });

    const count = completeStaleActiveSessions(noopCompletion);

    expect(count).toBe(1);
    expect(getSession('registered-but-idle', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('skips recently active sessions', () => {
    seedSession('fresh-1', { status: 'active', batchStartedAt: epochNow() });

    const count = completeStaleActiveSessions(noopCompletion);

    expect(count).toBe(0);
    const session = getSession('fresh-1', ALL_PROJECTS_SCOPE);
    expect(session?.status).toBe('active');
  });

  it('skips already completed sessions', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('completed-1', { status: 'completed', startedAt: staleTime });

    const count = completeStaleActiveSessions(noopCompletion);

    expect(count).toBe(0);
  });

  it('honors the configured threshold override', () => {
    // 10-minute session — stale under a 5-minute threshold, fresh under the default.
    const tenMinAgo = epochNow() - 10 * 60;
    seedSession('config-threshold', { status: 'active', batchStartedAt: tenMinAgo });

    expect(completeStaleActiveSessions(noopCompletion, STALE_THRESHOLD_S)).toBe(0);
    expect(getSession('config-threshold', ALL_PROJECTS_SCOPE)?.status).toBe('active');

    expect(completeStaleActiveSessions(noopCompletion, 5 * 60)).toBe(1);
    expect(getSession('config-threshold', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('sets ended_at on the completed row', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('ended-at-check', { status: 'active', startedAt: staleTime });

    const before = epochNow();
    completeStaleActiveSessions(noopCompletion);
    const session = getSession('ended-at-check', ALL_PROJECTS_SCOPE);

    expect(session?.ended_at).not.toBeNull();
    expect(session?.ended_at).toBeGreaterThanOrEqual(before);
  });

  const openBatchCount = (sessionId: string): number =>
    (getDatabase()
      .prepare(`SELECT COUNT(*) AS n FROM prompt_batches WHERE session_id = ? AND ended_at IS NULL`)
      .get(sessionId) as { n: number }).n;

  it('closes the open batch when sweeping a stale session', () => {
    // A plan-mode→execution run that never returns end_turn leaves its last
    // turn open forever (no Stop closed it). When the sweep finally completes
    // the idle session, that batch must close too — otherwise the session
    // shows a perpetually-open turn.
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-open-batch', { status: 'active', batchStartedAt: staleTime });
    expect(openBatchCount('stale-open-batch')).toBe(1);

    completeStaleActiveSessions(noopCompletion);

    expect(openBatchCount('stale-open-batch')).toBe(0);
  });

  it('leaves open batches of a fresh (non-swept) session untouched', () => {
    seedSession('fresh-open-batch', { status: 'active', batchStartedAt: epochNow() });

    completeStaleActiveSessions(noopCompletion);

    expect(openBatchCount('fresh-open-batch')).toBe(1);
  });

  it('runs the final transcript-mining convergence for a swept session with a transcript source (the unmined-tail case)', () => {
    // The reviewer-caught data-loss failure mode: a session swept stale got
    // no SessionEnd, so its transcript tail since the last per-turn Stop is
    // UNMINED. The sweep must route through the completion chokepoint,
    // which mines against the stamped transcript_path BEFORE the status
    // flip — otherwise "completed" would not imply "mined" and the routed-
    // transcript cache GC could prune a host's only transcript copy.
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-unmined', { status: 'active', startedAt: staleTime });
    upsertSession({
      id: 'stale-unmined',
      agent: 'claude-code',
      started_at: staleTime,
      created_at: staleTime,
      transcript_path: '/routed/materialized/stale-unmined.jsonl',
    });
    const { calls, completion } = makeRecordingMiner();

    const count = completeStaleActiveSessions(completion);

    expect(count).toBe(1);
    expect(calls).toEqual([{
      sessionId: 'stale-unmined',
      agent: 'claude-code',
      transcriptPath: '/routed/materialized/stale-unmined.jsonl',
    }]);
    expect(getSession('stale-unmined', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('does not invoke the miner for a swept session with no transcript source, and still completes it', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-no-source', { status: 'active', startedAt: staleTime });
    const { calls, completion } = makeRecordingMiner();

    const count = completeStaleActiveSessions(completion);

    expect(count).toBe(1);
    expect(calls).toEqual([]);
    expect(getSession('stale-no-source', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('a mining failure never blocks the sweep — the session still completes', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-mine-throws', { status: 'active', startedAt: staleTime });
    upsertSession({
      id: 'stale-mine-throws',
      agent: 'claude-code',
      started_at: staleTime,
      created_at: staleTime,
      transcript_path: '/routed/materialized/stale-mine-throws.jsonl',
    });
    const throwingCompletion = {
      transcriptMiner: {
        reconcileAndAttributeResponses() { throw new Error('mine failed'); },
      },
    };

    const count = completeStaleActiveSessions(throwingCompletion);

    expect(count).toBe(1);
    expect(getSession('stale-mine-throws', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });
});

describe('findDeadSessionIds', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns completed sessions with 0 prompts', () => {
    seedSession('dead-0', { promptCount: 0, status: 'completed' });

    const ids = findDeadSessionIds([]);

    expect(ids).toContain('dead-0');
  });

  it('does NOT return sessions with 1 prompt (1-prompt sessions have captured work)', () => {
    seedSession('alive-1prompt', { promptCount: 1, status: 'completed' });

    const ids = findDeadSessionIds([]);

    expect(ids).not.toContain('alive-1prompt');
  });

  it('does NOT return sessions with 2+ prompts', () => {
    seedSession('alive-2prompts', { promptCount: 2, status: 'completed' });

    const ids = findDeadSessionIds([]);

    expect(ids).not.toContain('alive-2prompts');
  });

  it('does NOT return active sessions even if they have 0 prompts (race protection)', () => {
    seedSession('fresh-session', { promptCount: 0, status: 'active' });

    const ids = findDeadSessionIds([]);

    expect(ids).not.toContain('fresh-session');
  });

  it('skips registered sessions', () => {
    seedSession('reg-dead', { promptCount: 0, status: 'completed' });

    const ids = findDeadSessionIds(['reg-dead']);

    expect(ids).not.toContain('reg-dead');
  });

  it('R4.18: derives count from prompt_batches, ignoring a stale-low cached prompt_count', () => {
    // Drift scenario: a real session has prompt_batches rows but
    // sessions.prompt_count was never bumped (writer-side bug, partial
    // backfill, etc). Before R4.18 this was deleted as "dead" because
    // findDeadSessionIds read the cached column. After the audit it reads
    // a LEFT JOIN'd COUNT(*) and the session is preserved.
    upsertSession({
      id: 'drift-stale-cache',
      agent: 'test-agent',
      started_at: epochNow(),
      created_at: epochNow(),
      status: 'completed',
      prompt_count: 0, // ← stale cache claims zero
    });
    const db = getDatabase();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
       VALUES (?, ?, ?, ?, 'active')`,
    ).run('drift-stale-cache', 1, epochNow(), epochNow());
    db.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
       VALUES (?, ?, ?, ?, 'active')`,
    ).run('drift-stale-cache', 2, epochNow(), epochNow());

    const ids = findDeadSessionIds([]);

    expect(ids).not.toContain('drift-stale-cache');
  });

  it('regression: 1-prompt session that made real changes survives cleanup (opencode test case)', () => {
    // During live opencode testing, a session that had exactly 1 user prompt
    // produced a real code change (LogTable.tsx sticky header, committed).
    // The session was auto-deleted within ~45s of TUI exit because the old
    // DEAD_SESSION_MAX_PROMPTS = 1 policy considered it "dead". This test
    // pins the protection so that regression can't recur.
    seedSession('ses_opencode_realwork', { promptCount: 1, status: 'completed' });

    const ids = findDeadSessionIds([]);

    expect(ids).not.toContain('ses_opencode_realwork');
  });
});

describe('write admission — the sweep skips projects whose lease is held', () => {
  const PAUSED_PROJECT = 'proj_' + 'a'.repeat(32);
  const FREE_PROJECT = 'proj_' + 'b'.repeat(32);
  let mycoHome: string;
  const prevMycoHome = process.env.MYCO_HOME;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => {
    teardownTestDb();
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevMycoHome;
  });
  beforeEach(() => {
    cleanTestDb();
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-lease-home-'));
    process.env.MYCO_HOME = mycoHome;
  });

  function holdLease(projectId: string) {
    acquireProjectLease(projectId, 'test-op', 'admission test', mycoHome, testPerUserLockNamespace);
  }

  function seedProjectSession(id: string, projectId: string, opts: {
    status?: string; promptCount?: number; startedAt?: number;
  }) {
    seedSession(id, opts);
    getDatabase().prepare('UPDATE sessions SET project_id = ? WHERE id = ?').run(projectId, id);
  }

  it('does not complete a stale session whose project lease is held; completes it after release', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedProjectSession('paused-stale', PAUSED_PROJECT, { status: 'active', startedAt: staleTime });
    seedProjectSession('free-stale', FREE_PROJECT, { status: 'active', startedAt: staleTime });
    holdLease(PAUSED_PROJECT);

    expect(completeStaleActiveSessions(noopCompletion)).toBe(1);
    expect(getSession('paused-stale', ALL_PROJECTS_SCOPE)?.status).toBe('active');
    expect(getSession('free-stale', ALL_PROJECTS_SCOPE)?.status).toBe('completed');

    releaseProjectLease(PAUSED_PROJECT, 'test-op', mycoHome, testPerUserLockNamespace);
    expect(completeStaleActiveSessions(noopCompletion)).toBe(1);
    expect(getSession('paused-stale', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('does not report a dead session whose project lease is held; reports it after release', () => {
    seedProjectSession('paused-dead', PAUSED_PROJECT, { status: 'completed', promptCount: 0 });
    seedProjectSession('free-dead', FREE_PROJECT, { status: 'completed', promptCount: 0 });
    holdLease(PAUSED_PROJECT);

    expect(findDeadSessionIds([])).toEqual(['free-dead']);

    releaseProjectLease(PAUSED_PROJECT, 'test-op', mycoHome, testPerUserLockNamespace);
    expect(findDeadSessionIds([]).sort()).toEqual(['free-dead', 'paused-dead']);
  });

  it('an unreadable lease counts as held, never as unheld', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedProjectSession('torn-lease', PAUSED_PROJECT, { status: 'active', startedAt: staleTime });
    const leasePath = path.join(mycoHome, 'leases', `${PAUSED_PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    expect(completeStaleActiveSessions(noopCompletion)).toBe(0);
    expect(getSession('torn-lease', ALL_PROJECTS_SCOPE)?.status).toBe('active');
  });

  it('sessions with no project id sweep normally while a lease is held elsewhere', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('projectless-stale', { status: 'active', startedAt: staleTime });
    holdLease(PAUSED_PROJECT);

    expect(completeStaleActiveSessions(noopCompletion)).toBe(1);
    expect(getSession('projectless-stale', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });
});
