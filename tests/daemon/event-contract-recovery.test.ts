import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { createEventDispatcher } from '@myco/daemon/event-dispatch.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { PowerManager } from '@myco/daemon/power.js';
import { DaemonLogger } from '@myco/daemon/logger.js';
import { EventBuffer } from '@myco/capture/buffer.js';
import { getDatabase } from '@myco/db/client.js';
import { countActivities, listActivities } from '@myco/db/queries/activities.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { shouldBufferFallback } from '@myco/hooks/send-event.js';
import { TEST_REQUEST_CONTEXT } from '../helpers/request-context';

/**
 * The full RC-7c recovery loop, no restart:
 *
 *   1. a per-type handler fails AFTER the daemon-side buffer append;
 *   2. the /events response honestly reports `persisted:false,
 *      buffered:true` and the dispatcher clears the session's converged
 *      mark;
 *   3. the hook-side decision table reads that response and does NOT
 *      write its own buffer copy (the daemon copy is the durable one);
 *   4. the post-Stop convergence trigger (reconciler.reconcileSession —
 *      the same call `onStopProcessed` wires) replays the daemon-appended
 *      copy and the row appears.
 */
describe('honest /events contract — end-to-end recovery loop', () => {
  let tmpDir: string;
  let bufferDir: string;
  let logger: DaemonLogger;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-contract-recovery-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
    logger = new DaemonLogger(path.join(tmpDir, 'logs'), { level: 'debug' });
  });

  afterEach(() => {
    logger.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('handler failure → honest response → no hook buffer → post-Stop trigger converges the daemon copy', async () => {
    const sessionId = 'contract-recovery-e2e-001';
    const transcriptPath = path.join(tmpDir, `${sessionId}.jsonl`);
    fs.writeFileSync(transcriptPath, '');

    const registry = new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} });
    const powerManager = new PowerManager({
      idleThresholdMs: 60_000,
      sleepThresholdMs: 120_000,
      deepSleepThresholdMs: 180_000,
      activeIntervalMs: 60_000,
      sleepIntervalMs: 60_000,
      logger,
      onTick: () => {},
      deepSleepHolder: () => null,
    });
    const reconciler = createReconciler({
      bufferDirs: () => [bufferDir],
      logger,
      projectRoot: tmpDir,
    });
    // Pre-seeded buffer stands in for the Grove-bound dispatch path (the
    // test request context is not Grove-bound); the reconciler scans the
    // same dir, exactly like production where dispatcher and reconciler
    // share the project's buffer location.
    const sessionBuffers = new Map<string, EventBuffer>();
    sessionBuffers.set(sessionId, new EventBuffer(bufferDir, sessionId));

    const handler = createEventDispatcher({
      registry,
      sessionBuffers,
      powerManager,
      logger,
      machineId: 'local',
      liveConfig: { current: {
        agent: { summary_batch_interval: 20 },
        canopy: { exclude: { patterns: [] } },
      } as never },
      vaultDir: tmpDir,
      reconcileSession: reconciler.reconcileSession,
      // The production wiring under test: handler failure clears the
      // converged mark so the post-Stop trigger can re-converge.
      clearConvergedMark: reconciler.clearSession,
      planWatchConfig: { watchDirs: [], projectRoot: tmpDir },
      triggerTitleSummary: async () => {},
    });

    const post = (body: Record<string, unknown>) => handler({
      requestContext: TEST_REQUEST_CONTEXT,
      body, query: {}, params: {}, pathname: '/events',
    });

    // Turn opens normally — the live path persists the prompt.
    const promptRes = await post({
      type: 'user_prompt',
      session_id: sessionId,
      agent: 'claude-code',
      transcript_path: transcriptPath,
      prompt: 'implement the honest hook contract',
    });
    expect(promptRes.body).toMatchObject({ ok: true, persisted: true });

    // Mid-turn, the activity insert fails (table offline) AFTER the
    // daemon-side buffer append succeeded.
    const db = getDatabase();
    db.exec('ALTER TABLE activities RENAME TO activities_offline');
    let toolRes;
    try {
      toolRes = await post({
        type: 'tool_use',
        session_id: sessionId,
        agent: 'claude-code',
        transcript_path: transcriptPath,
        tool_name: 'Bash',
        tool_input: { command: 'bun test' },
      });
    } finally {
      db.exec('ALTER TABLE activities_offline RENAME TO activities');
    }
    expect(toolRes.body).toEqual({ ok: true, persisted: false, buffered: true });

    // The hook-side decision table reads that response and refuses to
    // re-buffer — the daemon-appended copy is the durable one.
    expect(shouldBufferFallback({ ok: true, data: toolRes.body }, 'tool_use')).toBe(false);
    const bufferLines = fs.readFileSync(path.join(bufferDir, `${sessionId}.jsonl`), 'utf-8')
      .trim().split('\n');
    expect(bufferLines).toHaveLength(2); // prompt + tool_use, daemon copies only
    expect(countActivities(sessionId, ALL_PROJECTS_SCOPE)).toBe(0); // genuinely lost from the DB so far

    // Post-Stop convergence trigger (what stop-processing's onStopProcessed
    // invokes at the turn boundary): the prompt converges against its
    // stored batch; the tool_use is unmatched and replays.
    reconciler.reconcileSession(sessionId);

    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities).toHaveLength(1);
    expect(activities[0].tool_name).toBe('Bash');
  });
});
