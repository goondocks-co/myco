/**
 * Tests for the activity-aware stale-session sweep predicate.
 *
 * Covers the bug where a session emitting tool_use/subagent_* events
 * under a single long-running prompt batch was swept as stale because
 * the sweep only consulted prompt_batches.started_at, not
 * activities.timestamp.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { completeStaleActiveSessions } from '@myco/daemon/jobs/session-maintenance.js';
import { MS_PER_SECOND, STALE_SESSION_THRESHOLD_MS } from '@myco/constants.js';
import { ALL_PROJECTS_SCOPE, createGroveEraId } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / MS_PER_SECOND);
const STALE_THRESHOLD_S = STALE_SESSION_THRESHOLD_MS / MS_PER_SECOND;

/** No-op completion deps — this suite asserts the sweep PREDICATE, not
 *  mining (covered in tests/daemon/jobs/session-maintenance.test.ts). */
const noopCompletion = {
  transcriptMiner: { reconcileAndAttributeResponses: () => ({}) },
};

function seedSession(id: string, opts: {
  startedAt?: number;
  batchStartedAt?: number;
  activityTimestamp?: number;
}) {
  const now = epochNow();
  upsertSession({
    id,
    agent: 'test-agent',
    started_at: opts.startedAt ?? now - STALE_THRESHOLD_S - 1,
    created_at: now,
    status: 'active',
    prompt_count: 1,
  });

  const db = getDatabase();

  let batchId: string | null = null;
  if (opts.batchStartedAt !== undefined) {
    batchId = createGroveEraId('prompt_batch');
    db.prepare(
      `INSERT INTO prompt_batches (id, session_id, prompt_number, started_at, created_at, status)
       VALUES (?, ?, 1, ?, ?, 'active')`,
    ).run(batchId, id, opts.batchStartedAt, now);
  }

  if (opts.activityTimestamp !== undefined) {
    // v43 invariant: activities.prompt_batch_id is NOT NULL. If the test
    // didn't ask for a real batch, attach the activity to a synthetic
    // recovery batch (mirrors what handleToolUse does in production).
    if (batchId === null) {
      batchId = createGroveEraId('prompt_batch');
      db.prepare(
        `INSERT INTO prompt_batches (id, session_id, prompt_number, started_at, created_at, status, kind, user_prompt, origin)
         VALUES (?, ?, 0, ?, ?, 'completed', 'recovered', '(implicit batch — capture recovered)', 'system')`,
      ).run(batchId, id, opts.activityTimestamp, now);
    }
    db.prepare(
      `INSERT INTO activities
         (session_id, prompt_batch_id, tool_name, timestamp, created_at)
       VALUES (?, ?, 'Bash', ?, ?)`,
    ).run(id, batchId, opts.activityTimestamp, now);
  }
}

describe('completeStaleActiveSessions — activity-aware predicate', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('does NOT sweep a session with recent activity even when the prompt batch is stale', () => {
    // Reproduces the confirmed bug:
    //   - Session started 2h ago
    //   - Prompt batch opened 90 min ago (older than the 60-min threshold)
    //   - Activity (tool call) recorded 5 min ago — agent is actively working
    // Before the fix: swept as stale (only prompt_batches.started_at checked).
    // After the fix: preserved because activities.timestamp < cutoff is false.
    const twoHoursAgo = epochNow() - 2 * 3600;
    const ninetyMinAgo = epochNow() - 90 * 60;
    const fiveMinAgo = epochNow() - 5 * 60;

    seedSession('active-tool-user', {
      startedAt: twoHoursAgo,
      batchStartedAt: ninetyMinAgo,
      activityTimestamp: fiveMinAgo,
    });

    const swept = completeStaleActiveSessions(noopCompletion);

    expect(swept).toBe(0);
    expect(getSession('active-tool-user', ALL_PROJECTS_SCOPE)?.status).toBe('active');
  });

  it('DOES sweep a session where both prompt batches AND activities are stale', () => {
    // Both the prompt batch and any activities are older than the threshold.
    const twoHoursAgo = epochNow() - 2 * 3600;
    const ninetyMinAgo = epochNow() - 90 * 60;
    const eightyMinAgo = epochNow() - 80 * 60;

    seedSession('fully-stale', {
      startedAt: twoHoursAgo,
      batchStartedAt: ninetyMinAgo,
      activityTimestamp: eightyMinAgo,
    });

    const swept = completeStaleActiveSessions(noopCompletion);

    expect(swept).toBe(1);
    expect(getSession('fully-stale', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('does NOT sweep a session with recent activity even when there are no prompt batches', () => {
    // Edge case: session with activities but no prompt batches (e.g., subagent-only).
    const twoHoursAgo = epochNow() - 2 * 3600;
    const fiveMinAgo = epochNow() - 5 * 60;

    seedSession('activity-only', {
      startedAt: twoHoursAgo,
      activityTimestamp: fiveMinAgo,
    });

    const swept = completeStaleActiveSessions(noopCompletion);

    expect(swept).toBe(0);
    expect(getSession('activity-only', ALL_PROJECTS_SCOPE)?.status).toBe('active');
  });

  it('DOES sweep a session with no batches and no activities if started_at is stale', () => {
    // Baseline: sessions with no batches and no activities fall back to started_at.
    const twoHoursAgo = epochNow() - 2 * 3600;

    seedSession('no-data', {
      startedAt: twoHoursAgo,
    });

    const swept = completeStaleActiveSessions(noopCompletion);

    expect(swept).toBe(1);
    expect(getSession('no-data', ALL_PROJECTS_SCOPE)?.status).toBe('completed');
  });

  it('does NOT sweep a session where only activities are recent (no batches)', () => {
    // Recent activity alone protects the session.
    const twoHoursAgo = epochNow() - 2 * 3600;
    const justNow = epochNow();

    seedSession('fresh-activity-no-batch', {
      startedAt: twoHoursAgo,
      activityTimestamp: justNow,
    });

    const swept = completeStaleActiveSessions(noopCompletion);

    expect(swept).toBe(0);
    expect(getSession('fresh-activity-no-batch', ALL_PROJECTS_SCOPE)?.status).toBe('active');
  });
});
