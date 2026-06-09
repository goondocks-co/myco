import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
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

    const count = completeStaleActiveSessions();

    expect(count).toBe(1);
    const session = getSession('stale-1', ALL_PROJECTS_SCOPE);
    expect(session?.status).toBe('completed');
  });

  it('completes active sessions whose last prompt is older than threshold', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-2', { status: 'active', batchStartedAt: staleTime });

    const count = completeStaleActiveSessions();

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

    const count = completeStaleActiveSessions();

    expect(count).toBe(1);
    expect(getSession('registered-but-idle', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('skips recently active sessions', () => {
    seedSession('fresh-1', { status: 'active', batchStartedAt: epochNow() });

    const count = completeStaleActiveSessions();

    expect(count).toBe(0);
    const session = getSession('fresh-1', ALL_PROJECTS_SCOPE);
    expect(session?.status).toBe('active');
  });

  it('skips already completed sessions', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('completed-1', { status: 'completed', startedAt: staleTime });

    const count = completeStaleActiveSessions();

    expect(count).toBe(0);
  });

  it('honors the configured threshold override', () => {
    // 10-minute session — stale under a 5-minute threshold, fresh under the default.
    const tenMinAgo = epochNow() - 10 * 60;
    seedSession('config-threshold', { status: 'active', batchStartedAt: tenMinAgo });

    expect(completeStaleActiveSessions(STALE_THRESHOLD_S)).toBe(0);
    expect(getSession('config-threshold', ALL_PROJECTS_SCOPE)?.status).toBe('active');

    expect(completeStaleActiveSessions(5 * 60)).toBe(1);
    expect(getSession('config-threshold', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('sets ended_at on the completed row', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('ended-at-check', { status: 'active', startedAt: staleTime });

    const before = epochNow();
    completeStaleActiveSessions();
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

    completeStaleActiveSessions();

    expect(openBatchCount('stale-open-batch')).toBe(0);
  });

  it('leaves open batches of a fresh (non-swept) session untouched', () => {
    seedSession('fresh-open-batch', { status: 'active', batchStartedAt: epochNow() });

    completeStaleActiveSessions();

    expect(openBatchCount('fresh-open-batch')).toBe(1);
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
