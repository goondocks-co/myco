/**
 * Capture-pipeline end-to-end integration test.
 *
 * Drives the real `createEventDispatcher` through a multi-event session and
 * asserts the full DB shape after — sessions row, prompt_batches with
 * sequential prompt_numbers, activities linked to the open batch.
 *
 * This is the first canary integration test in Phase 3 of the suite audit
 * (see #295 / #296 for context). It complements the function-level tests
 * in `tests/daemon/capture.test.ts` (which call `handleUserPrompt` /
 * `handleToolUse` directly) and `tests/daemon/event-dispatch.test.ts`
 * (which exercise individual dispatcher decision branches) by covering
 * what neither does: a single continuous lifecycle running through the
 * dispatcher's wrapping layers — dedup window, auto-registration,
 * request-context resolution, the `ensureSessionRowExists` defensive
 * layer (added in #284), DB persistence — and asserting that the rows
 * land correctly across multiple turns.
 *
 * If this fails, the capture pipeline is silently dropping work. That's
 * the bug shape that shipped in #278, #280, #284, #285, #286 — the test
 * exists to fail loudly the next time anything in this chain regresses,
 * instead of letting it leak to a user.
 *
 * Stop processing (`POST /events/stop`) lives in a separate processor
 * with heavier deps (transcriptMiner, embeddingManager) and is covered
 * by its own future integration test; this file stays focused on the
 * `/events` dispatcher path.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivities, countActivities } from '@myco/db/queries/activities.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

function makeDispatcher() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-e2e-log-'));
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-e2e-vault-'));
  const logger = new DaemonLogger(logDir, { level: 'warn' });
  const registry = new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} });
  const powerManager = new PowerManager({
    idleThresholdMs: 60_000,
    sleepThresholdMs: 120_000,
    deepSleepThresholdMs: 180_000,
    activeIntervalMs: 60_000,
    sleepIntervalMs: 60_000,
    logger,
  });
  const sessionBuffers = new Map();

  const handler = createEventDispatcher({
    registry,
    sessionBuffers,
    powerManager,
    logger,
    machineId: 'local',
    liveConfig: {
      current: {
        agent: { summary_batch_interval: 20 },
        canopy: { exclude: { patterns: [] } },
      } as never,
    },
    vaultDir,
    reconcileSession: () => {},
    planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
    triggerTitleSummary: async () => {},
  });

  return { handler, registry, sessionBuffers };
}

function post(handler: ReturnType<typeof makeDispatcher>['handler'], body: Record<string, unknown>) {
  return handler({
    requestContext: TEST_REQUEST_CONTEXT,
    body,
    query: {},
    params: {},
    pathname: '/events',
  });
}

describe('capture pipeline — end-to-end through dispatcher', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('persists a two-batch session — sessions row, batches with prompt_numbers, activities linked', async () => {
    const { handler } = makeDispatcher();
    const sessionId = 'capture-e2e-001';
    const agent = 'claude-code';

    // Turn 1 — user prompt arrives for a never-registered session. The
    // dispatcher's `ensureSessionRowExists` defensive layer (#284) is what
    // makes this safe; if that regresses, no session row exists when the
    // batch insert hits the FK and the whole turn vanishes.
    const r1 = await post(handler, {
      type: 'user_prompt',
      session_id: sessionId,
      agent,
      prompt: 'Write a hello world program',
      transcript_path: '/tmp/fake-transcript.jsonl',
    });
    expect(r1.body).toMatchObject({ ok: true });

    let session = getSession(sessionId, ALL_PROJECTS_SCOPE);
    expect(session).not.toBeNull();
    expect(session!.id).toBe(sessionId);

    // Two tool uses inside turn 1 — both should attach to the open batch.
    await post(handler, {
      type: 'tool_use',
      session_id: sessionId,
      agent,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/hello.ts', content: 'console.log("hi")' },
    });
    await post(handler, {
      type: 'tool_use',
      session_id: sessionId,
      agent,
      tool_name: 'Bash',
      tool_input: { command: 'bun /tmp/hello.ts' },
    });

    // Turn 2 — a new user prompt opens a new batch with prompt_number=2.
    await post(handler, {
      type: 'user_prompt',
      session_id: sessionId,
      agent,
      prompt: 'Now add a test for it',
      transcript_path: '/tmp/fake-transcript.jsonl',
    });

    // One tool use inside turn 2.
    await post(handler, {
      type: 'tool_use',
      session_id: sessionId,
      agent,
      tool_name: 'Write',
      tool_input: { file_path: '/tmp/hello.test.ts', content: 'expect(1).toBe(1)' },
    });

    // --- Verify session ---
    session = getSession(sessionId, ALL_PROJECTS_SCOPE);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('active');
    expect(session!.ended_at).toBeNull();

    // --- Verify batches ---
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches.length).toBe(2);
    const [batch1, batch2] = batches;

    expect(batch1.prompt_number).toBe(1);
    expect(batch1.user_prompt).toBe('Write a hello world program');

    expect(batch2.prompt_number).toBe(2);
    expect(batch2.user_prompt).toBe('Now add a test for it');

    // --- Verify activities ---
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities.length).toBe(3);

    // First two activities belong to batch 1, in order.
    expect(activities[0].prompt_batch_id).toBe(batch1.id);
    expect(activities[0].tool_name).toBe('Write');
    expect(activities[0].file_path).toBe('/tmp/hello.ts');

    expect(activities[1].prompt_batch_id).toBe(batch1.id);
    expect(activities[1].tool_name).toBe('Bash');

    // Third activity belongs to batch 2.
    expect(activities[2].prompt_batch_id).toBe(batch2.id);
    expect(activities[2].tool_name).toBe('Write');
    expect(activities[2].file_path).toBe('/tmp/hello.test.ts');

    expect(countActivities(sessionId, ALL_PROJECTS_SCOPE)).toBe(3);
  });

  it('drops duplicate user_prompt within the dedup window without creating a second batch', async () => {
    const { handler } = makeDispatcher();
    const sessionId = 'capture-e2e-dedup-001';
    const agent = 'claude-code';
    const event = {
      type: 'user_prompt',
      session_id: sessionId,
      agent,
      prompt: 'identical prompt that should only persist once',
      transcript_path: '/tmp/fake-transcript.jsonl',
    };

    await post(handler, event);
    await post(handler, event);
    await post(handler, event);

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches.length).toBe(1);
    expect(batches[0].prompt_number).toBe(1);
  });
});
