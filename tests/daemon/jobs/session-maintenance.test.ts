import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import {
  completeStaleActiveSessions,
  findDeadSessionIds,
} from '../../../src/daemon/jobs/session-maintenance.js';
import { MS_PER_SECOND, STALE_SESSION_THRESHOLD_MS } from '../../../src/constants.js';

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

  if (opts.batchStartedAt !== undefined) {
    const db = getDatabase();
    db.prepare(
      `INSERT INTO prompt_batches (session_id, prompt_number, started_at, created_at, status)
       VALUES (?, ?, ?, ?, 'active')`,
    ).run(id, 1, opts.batchStartedAt, now);
  }
}

describe('completeStaleActiveSessions', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('completes active sessions with no prompts older than threshold', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-1', { status: 'active', startedAt: staleTime });

    const count = completeStaleActiveSessions([]);

    expect(count).toBe(1);
    const session = getSession('stale-1');
    expect(session?.status).toBe('completed');
  });

  it('completes active sessions whose last prompt is older than threshold', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('stale-2', { status: 'active', batchStartedAt: staleTime });

    const count = completeStaleActiveSessions([]);

    expect(count).toBe(1);
    const session = getSession('stale-2');
    expect(session?.status).toBe('completed');
  });

  it('skips registered sessions', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('registered-1', { status: 'active', startedAt: staleTime });

    const count = completeStaleActiveSessions(['registered-1']);

    expect(count).toBe(0);
    const session = getSession('registered-1');
    expect(session?.status).toBe('active');
  });

  it('skips recently active sessions', () => {
    seedSession('fresh-1', { status: 'active', batchStartedAt: epochNow() });

    const count = completeStaleActiveSessions([]);

    expect(count).toBe(0);
    const session = getSession('fresh-1');
    expect(session?.status).toBe('active');
  });

  it('skips already completed sessions', () => {
    const staleTime = epochNow() - STALE_THRESHOLD_S - 1;
    seedSession('completed-1', { status: 'completed', startedAt: staleTime });

    const count = completeStaleActiveSessions([]);

    expect(count).toBe(0);
  });
});

describe('findDeadSessionIds', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('returns sessions with 0 prompts', () => {
    seedSession('dead-0', { promptCount: 0 });

    const ids = findDeadSessionIds([]);

    expect(ids).toContain('dead-0');
  });

  it('returns sessions with 1 prompt', () => {
    seedSession('dead-1', { promptCount: 1 });

    const ids = findDeadSessionIds([]);

    expect(ids).toContain('dead-1');
  });

  it('skips sessions with 2+ prompts', () => {
    seedSession('alive-1', { promptCount: 2 });

    const ids = findDeadSessionIds([]);

    expect(ids).not.toContain('alive-1');
  });

  it('skips registered sessions', () => {
    seedSession('reg-dead', { promptCount: 0 });

    const ids = findDeadSessionIds(['reg-dead']);

    expect(ids).not.toContain('reg-dead');
  });
});
