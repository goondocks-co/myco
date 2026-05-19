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
 * with heavier deps (transcriptMiner, embeddingManager). Unit-level
 * coverage for its session-capture rules lives in
 * `tests/daemon/stop-processing.test.ts`; a full integration test that
 * exercises the wired-up HTTP path is still a TODO — see issue #285 for
 * the regression that motivated the bucket-level coverage push.
 * This file stays focused on the `/events` dispatcher path.
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

  it('does NOT dedup three different prompts on the same session (negative-dedup invariant)', async () => {
    // The identical-prompt case above passes even if dedup were always-on
    // (a buggy "always coalesce" would still produce one batch). This
    // negative-dedup test pins the other half of the contract: distinct
    // prompts must NOT be coalesced — each produces its own batch.
    const { handler } = makeDispatcher();
    const sessionId = 'capture-e2e-no-dedup-001';
    const agent = 'claude-code';
    const prompts = [
      'first distinct prompt',
      'second distinct prompt',
      'third distinct prompt',
    ];

    for (const prompt of prompts) {
      await post(handler, {
        type: 'user_prompt',
        session_id: sessionId,
        agent,
        prompt,
        transcript_path: '/tmp/fake-transcript.jsonl',
      });
    }

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches.length).toBe(3);
    expect(batches.map((b) => b.prompt_number)).toEqual([1, 2, 3]);
    expect(batches.map((b) => b.user_prompt)).toEqual(prompts);
  });
});

// Mid-session daemon restart with the agent still alive. Asserts that
// the buffer JSONL is drained at startup, every activity ends up with
// a non-NULL prompt_batch_id, and synthetic recovery batches carry the
// 'recovered' kind.
import { createReconciler } from '@myco/daemon/reconciliation.js';

function makeDispatcherWithRealReconciler(opts: { bufferDir: string; vaultDir?: string }) {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-capture-e2e-log-'));
  // Default vaultDir = parent of bufferDir, so the dispatcher's internal
  // EventBuffer writes to the same directory the reconciler reads from.
  const vaultDir = opts.vaultDir ?? path.dirname(opts.bufferDir);
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
  const reconciler = createReconciler({ bufferDir: opts.bufferDir, logger: logger as never, projectRoot: process.cwd() });

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
    reconcileSession: reconciler.reconcileSession,
    planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
    triggerTitleSummary: async () => {},
  });

  return { handler, registry, sessionBuffers, reconciler, vaultDir };
}

describe('capture pipeline — mid-session restart replay', () => {
  let tmpBuffer: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    // Shared vault root across the two simulated daemons so the dispatcher's
    // internal EventBuffer writes are visible to the reconciler at restart.
    // bufferDir is the conventional <vaultRoot>/buffer subdir.
    const vaultRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-replay-vault-'));
    fs.mkdirSync(path.join(vaultRoot, 'buffer'), { recursive: true });
    tmpBuffer = path.join(vaultRoot, 'buffer');
    (globalThis as Record<string, unknown>).__replayVaultRoot = vaultRoot;
  });

  it('mid-session daemon restart with no SessionStart re-fire does not lose buffer events or orphan activities', async () => {
    const sessionId = 'replay-incident-001';
    const agent = 'claude-code';
    const vaultRoot = (globalThis as Record<string, unknown>).__replayVaultRoot as string;
    const bufferPath = path.join(tmpBuffer, `${sessionId}.jsonl`);
    const appendBuffer = (event: Record<string, unknown>) => {
      fs.appendFileSync(bufferPath, JSON.stringify(event) + '\n');
    };

    // ── Phase A: original daemon. Dispatcher's internal EventBuffer
    //    writes to <vaultRoot>/buffer/, the same dir Phase B's reconciler
    //    reads — exactly mirroring production layout. ──
    const a = makeDispatcherWithRealReconciler({ bufferDir: tmpBuffer, vaultDir: vaultRoot });
    const transcriptPath = '/tmp/fake-transcript.jsonl';
    await post(a.handler, { type: 'user_prompt', session_id: sessionId, agent, prompt: 'investigate the wedge', transcript_path: transcriptPath });
    await post(a.handler, { type: 'tool_use', session_id: sessionId, agent, tool_name: 'Read', tool_input: { file_path: '/x.ts' }, transcript_path: transcriptPath });
    await post(a.handler, { type: 'tool_use', session_id: sessionId, agent, tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: transcriptPath });

    // Simulate the wedge — daemon stops responding. Production hooks keep
    // writing the buffer JSONL even when the POST fails, so events arrive
    // in the journal but not the DB. Append directly to mirror that.
    appendBuffer({ type: 'user_prompt', prompt: 'second wedge prompt', timestamp: '2026-05-18T17:42:49.644Z' });
    appendBuffer({ type: 'tool_use', tool_name: 'Edit', tool_input: { file_path: '/y.ts' }, timestamp: '2026-05-18T17:43:00.000Z' });

    // ── Phase B: daemon restart. New dispatcher, new reconciler. The
    //    agent is still alive; it does NOT re-register the session. ──
    const b = makeDispatcherWithRealReconciler({ bufferDir: tmpBuffer, vaultDir: vaultRoot });

    // Startup reconciliation must drain the buffer file and replay the
    // events the live path missed during the wedge. With the cache-
    // poisoning fix, this works even though the session row still exists.
    b.reconciler.runStartupReconciliation();

    // Post-restart, the agent sends a fresh tool_use FOLLOWING the
    // (wedge-buffered) "second wedge prompt." If everything is intact:
    //   - the buffered prompt now exists as batch #2
    //   - the buffered tool_use now exists as activity attached to it
    //   - the post-restart tool_use also attaches to batch #2 (the open one)
    await post(b.handler, { type: 'tool_use', session_id: sessionId, agent, tool_name: 'Write', tool_input: { file_path: '/z.ts' }, transcript_path: '/tmp/fake-transcript.jsonl' });

    // ── Assertions ──
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches.length).toBeGreaterThanOrEqual(2);
    expect(batches[0].user_prompt).toBe('investigate the wedge');
    expect(batches[1].user_prompt).toBe('second wedge prompt');

    // Crucially: every activity has a non-NULL prompt_batch_id.
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities.length).toBeGreaterThanOrEqual(4);
    for (const a of activities) {
      expect(a.prompt_batch_id).not.toBeNull();
    }
  });

  it('agent-side tool_use arrives with no preceding user_prompt — handler opens an implicit recovery batch instead of orphaning', async () => {
    const sessionId = 'replay-recovery-001';
    const agent = 'claude-code';
    const { handler } = makeDispatcherWithRealReconciler({ bufferDir: tmpBuffer });

    // No user_prompt — directly a tool_use. transcript_path is required
    // by the auto-registration gate (capture rules); with it set, the
    // session row gets created and handleToolUse runs. The runtime
    // defense in handleToolUse opens an implicit recovery batch so the
    // activity has a parent even when no real prompt has arrived yet.
    const res = await post(handler, {
      type: 'tool_use',
      session_id: sessionId,
      agent,
      tool_name: 'Read',
      tool_input: { file_path: '/a.ts' },
      transcript_path: '/tmp/fake-transcript.jsonl',
    });
    expect(res.body).toMatchObject({ ok: true });

    const allBatches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(allBatches.length).toBeGreaterThanOrEqual(1);
    const recovered = allBatches.find((b) => b.kind === 'recovered');
    expect(recovered).toBeDefined();
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities.length).toBe(1);
    expect(activities[0].prompt_batch_id).toBe(recovered!.id);
  });
});
