/**
 * RC-7 Phase 3: quiescence-gated drain pass + retention completion
 * (hard cap → quarantine) + post-Stop deferred convergence trigger.
 *
 * Grove-scoped shapes reuse the two-database topology from
 * reconciliation-resurrection.test.ts: the suite's singleton DB plays the
 * daemon's bootstrap/ANCHOR vault, the Grove owns a REAL on-disk DB at
 * resolveGroveDbPath, and every per-dir drain body must bind to the
 * Grove DB.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { createReconciler, type Reconciler, type ReconcilerDeps } from '@myco/daemon/reconciliation.js';
import { createStopProcessor } from '@myco/daemon/stop-processing.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { EventDedupCache } from '@myco/daemon/event-dedup-cache.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { openDatabase, withDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession, closeOpenBatches } from '@myco/db/queries/batches.js';
import { listActivities } from '@myco/db/queries/activities.js';
import { listBufferSessionIds, BUFFER_QUARANTINE_DIRNAME } from '@myco/capture/buffer.js';
import { listAllProjectBufferDirs } from '@myco/capture/buffer-location.js';
import {
  clearGroveRegistryCaches,
  ensureDefaultGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { createGroveId, createProjectId, ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { resolveProjectBufferDir, resolveGroveDbPath } from '@myco/grove/paths.js';
import {
  BUFFER_QUIESCENCE_IDLE_MS,
  BUFFER_HARD_RETENTION_MS,
  TOMBSTONE_RETENTION_MS,
  CAPTURE_BUFFER_DRAIN_SESSION_CAP,
} from '@myco/constants.js';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

interface CapturedLog { kind: string; message: string; data?: Record<string, unknown> }

function makeCapturingLogger() {
  const infos: CapturedLog[] = [];
  const warns: CapturedLog[] = [];
  const logger = {
    debug: () => {},
    error: () => {},
    info: (kind: string, message: string, data?: Record<string, unknown>) => { infos.push({ kind, message, ...(data ? { data } : {}) }); },
    warn: (kind: string, message: string, data?: Record<string, unknown>) => { warns.push({ kind, message, ...(data ? { data } : {}) }); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { logger, infos, warns };
}

// Satisfies the any_agent transcript_path_missing drop rule's negation
// (the file itself need not exist).
const TRANSCRIPT = '/tmp/myco-test-transcripts/session.jsonl';

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

describe('Capture buffer drain — quiescence gate, backoff, cap, retention (Grove-scoped)', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;
  let grove: GroveRecord;
  let groveDb: Database;
  let projectId: string;
  let projectRoot: string;
  let bufferDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    sandbox = sandboxMycoHome('myco-drain-');
    clearGroveRegistryCaches();
    grove = ensureDefaultGrove(sandbox.mycoHome);
    projectId = createProjectId();
    projectRoot = path.join(sandbox.mycoHome, 'workspace', 'drain-project');
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'drain-project',
      projectRoot,
    }, sandbox.mycoHome);
    bufferDir = resolveProjectBufferDir(grove.id, projectId, sandbox.mycoHome);
    fs.mkdirSync(bufferDir, { recursive: true });
    groveDb = openDatabase(resolveGroveDbPath(grove.id, sandbox.mycoHome));
    createSchema(groveDb);
  });

  afterEach(() => {
    groveDb.close();
    clearGroveRegistryCaches();
    sandbox.restore();
  });

  function inGrove<T>(fn: () => T): T {
    return withDatabase(groveDb, fn);
  }

  function bufferPathFor(sessionId: string, dir = bufferDir): string {
    return path.join(dir, `${sessionId}.jsonl`);
  }

  function writeBuffer(sessionId: string, events: Array<Record<string, unknown>>, dir = bufferDir): void {
    fs.writeFileSync(
      bufferPathFor(sessionId, dir),
      events.map((e) => JSON.stringify(e)).join('\n') + '\n',
    );
  }

  /** Push a file's mtime into the past without touching content. */
  function ageFile(filePath: string, ageMs: number): void {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, past, past);
  }

  function makeReconciler(
    overrides: Partial<ReconcilerDeps> = {},
  ): Reconciler {
    return createReconciler({
      bufferDirs: () => [bufferDir],
      logger: silentLogger,
      projectRoot,
      machineId: 'test-machine',
      ...overrides,
    });
  }

  function seedGroveSession(sessionId: string, status: 'active' | 'completed' = 'active'): void {
    inGrove(() => upsertSession({
      id: sessionId, agent: 'claude-code', status,
      started_at: nowSec(), created_at: nowSec(), project_id: projectId,
    }));
  }

  // -- Shape 8: the quiescence gate -----------------------------------------

  it('skips a session with an OPEN batch; skips again until 5min idle after the batch closes; then drains', () => {
    const sessionId = 'quiesce-open-001';
    seedGroveSession(sessionId);
    inGrove(() => handleUserPrompt(sessionId, 'live turn', { kind: 'initial' }));

    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'live turn', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'make wedge' }, agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(20_000) },
    ]);

    const reconciler = makeReconciler();

    // Open batch → ineligible, regardless of buffer idle time.
    let summary = reconciler.runDrainPass();
    expect(summary.skippedQuiescent).toBe(1);
    expect(summary.drained).toBe(0);
    expect(inGrove(() => listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE }))).toHaveLength(0);

    // Batch closed but the buffer is still fresh → still ineligible.
    inGrove(() => closeOpenBatches(sessionId, nowSec()));
    summary = reconciler.runDrainPass();
    expect(summary.skippedQuiescent).toBe(1);
    expect(summary.drained).toBe(0);

    // Idle past the quiescence window → drains; the wedge event replays.
    ageFile(bufferPathFor(sessionId), BUFFER_QUIESCENCE_IDLE_MS + 60_000);
    summary = reconciler.runDrainPass();
    expect(summary.drained).toBe(1);
    const activities = inGrove(() => listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE }));
    expect(activities.filter((a) => a.tool_name === 'Bash')).toHaveLength(1);
    // Prompt converged against the stored batch — no duplicate.
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(1);

    // Converged-map skip: the next pass doesn't touch the session.
    summary = reconciler.runDrainPass();
    expect(summary.attempted).toBe(0);
  });

  it('drains a CLOSED session immediately — no idle requirement', () => {
    const sessionId = 'quiesce-closed-002';
    seedGroveSession(sessionId, 'completed');
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'finished work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ]);
    // Buffer mtime is NOW — only the closed status makes it eligible.

    const summary = makeReconciler().runDrainPass();
    expect(summary.drained).toBe(1);
    const batches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('finished work');
  });

  it('drains a row-absent buffer immediately (resurrection path — no live turn by construction)', () => {
    const sessionId = 'quiesce-absent-003';
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'offline session', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ]);

    const summary = makeReconciler().runDrainPass();
    expect(summary.drained).toBe(1);
    const session = inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!;
    expect(session).not.toBeNull();
    expect(session.project_id).toBe(projectId);
  });

  // -- Shape 9: shared dedup cache across drain replay + late live retry ----

  it('a delayed live retry of a drain-replayed event is suppressed by the shared dedup cache', () => {
    const sessionId = 'drain-dedup-009';
    seedGroveSession(sessionId, 'completed');
    const toolEvent = {
      type: 'tool_use',
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      agent: 'claude-code',
      transcript_path: TRANSCRIPT,
      timestamp: iso(30_000),
    };
    writeBuffer(sessionId, [toolEvent]);

    const eventDedupCache = new EventDedupCache();
    const summary = makeReconciler({ eventDedupCache }).runDrainPass();
    expect(summary.drained).toBe(1);
    expect(
      inGrove(() => listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE }))
        .filter((a) => a.tool_name === 'Bash'),
    ).toHaveLength(1);

    // The hook's delayed live retry of the same physical event hits the
    // shared cache (replay-time stamp) and is rejected as a duplicate.
    expect(eventDedupCache.isDuplicate(
      { ...toolEvent, session_id: sessionId } as { type: string; session_id: string } & Record<string, unknown>,
      Date.now(),
    )).toBe(true);
  });

  // -- Shape 11: fresh torn tail defers without backoff ----------------------

  it('a fresh torn tail defers the pass (no failure recorded); the next pass drains once the file is idle', () => {
    const sessionId = 'torn-tail-011';
    seedGroveSession(sessionId, 'completed');
    fs.writeFileSync(bufferPathFor(sessionId),
      JSON.stringify({ type: 'user_prompt', prompt: 'before the tear', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) }) + '\n'
      + '{"type":"user_prompt","pro', // torn mid-append
    );

    const reconciler = makeReconciler();

    // Fresh file (mtime = now) → torn line may still be an in-flight
    // append → pass defers. NOT a drain failure: no backoff.
    let summary = reconciler.runDrainPass();
    expect(summary.attempted).toBe(1);
    expect(summary.drained).toBe(0);
    expect(summary.failed).toBe(0);
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(0);

    // Idle file → the torn line is permanent damage: excluded, the rest
    // replays on the very NEXT pass (no backoff window to wait out).
    ageFile(bufferPathFor(sessionId), 30_000);
    summary = reconciler.runDrainPass();
    expect(summary.drained).toBe(1);
    const batches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('before the tear');
  });

  // -- Shape 19: lazy bufferDirs --------------------------------------------

  it('sees a project registered AFTER reconciler construction without a restart (lazy dirs)', () => {
    const reconciler = createReconciler({
      bufferDirs: () => listAllProjectBufferDirs(sandbox.mycoHome),
      logger: silentLogger,
      projectRoot,
      machineId: 'test-machine',
    });

    // Nothing anywhere yet.
    expect(reconciler.runDrainPass().attempted).toBe(0);

    // A new project registers mid-lifetime; its buffer appears.
    const lateProjectId = createProjectId();
    const lateRoot = path.join(sandbox.mycoHome, 'workspace', 'late-project');
    fs.mkdirSync(lateRoot, { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId: lateProjectId,
      projectName: 'late-project',
      projectRoot: lateRoot,
    }, sandbox.mycoHome);
    const lateBufferDir = resolveProjectBufferDir(grove.id, lateProjectId, sandbox.mycoHome);
    fs.mkdirSync(lateBufferDir, { recursive: true });
    const sessionId = 'late-project-019';
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'first prompt in the new project', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ], lateBufferDir);

    const summary = reconciler.runDrainPass();
    expect(summary.drained).toBe(1);
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).not.toBeNull();
  });

  // -- Per-session failure backoff -------------------------------------------

  it('an erroring session sits out 2^failures passes and recovers after a successful attempt', () => {
    const sessionId = 'backoff-005';
    // Row-absent FRESH buffer → resurrection registers in the registry;
    // a throwing register is the injected failure.
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'poisoned for a while', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(10_000) },
    ]);

    let allowRegister = false;
    const registry = {
      register: () => {
        if (!allowRegister) throw new Error('injected registry failure');
      },
    };
    const reconciler = makeReconciler({ registry: registry as never });

    // Pass 1: the attempt throws → failure recorded, 2^1 = 2 passes of backoff.
    let summary = reconciler.runDrainPass();
    expect(summary.failed).toBe(1);
    expect(summary.drained).toBe(0);

    // Passes 2 and 3: skipped under backoff — no attempt, no further failures.
    summary = reconciler.runDrainPass();
    expect(summary.skippedBackoff).toBe(1);
    expect(summary.attempted).toBe(0);
    summary = reconciler.runDrainPass();
    expect(summary.skippedBackoff).toBe(1);

    // Pass 4: backoff elapsed and the dep recovered → drains.
    allowRegister = true;
    ageFile(bufferPathFor(sessionId), BUFFER_QUIESCENCE_IDLE_MS + 60_000);
    summary = reconciler.runDrainPass();
    expect(summary.drained).toBe(1);
    expect(summary.failed).toBe(0);
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(1);

    // Backoff state cleared: next pass is a clean converged-map skip.
    summary = reconciler.runDrainPass();
    expect(summary.attempted).toBe(0);
    expect(summary.skippedBackoff).toBe(0);
  });

  // -- Per-pass session cap ----------------------------------------------------

  it('caps a pass at the session cap, logs the deferral, and drains the remainder next pass', () => {
    const total = CAPTURE_BUFFER_DRAIN_SESSION_CAP + 5;
    for (let i = 0; i < total; i++) {
      const sessionId = `cap-${String(i).padStart(3, '0')}`;
      seedGroveSession(sessionId, 'completed');
      writeBuffer(sessionId, [
        { type: 'user_prompt', prompt: `prompt ${i}`, origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
      ]);
    }

    const { logger, infos } = makeCapturingLogger();
    const reconciler = makeReconciler({ logger });

    let summary = reconciler.runDrainPass();
    expect(summary.attempted).toBe(CAPTURE_BUFFER_DRAIN_SESSION_CAP);
    expect(summary.drained).toBe(CAPTURE_BUFFER_DRAIN_SESSION_CAP);
    expect(summary.deferredByCap).toBe(5);
    expect(infos.some((l) => l.message.includes('per-pass session cap') && l.data?.deferred === 5)).toBe(true);

    // Remainder drains on the next pass; converged sessions skip.
    summary = reconciler.runDrainPass();
    expect(summary.drained).toBe(5);
    expect(summary.deferredByCap).toBe(0);
  });

  // -- Retention completion: hard cap → quarantine → prune ---------------------

  it('quarantines a diverging buffer past the hard cap (WARN with unmatched count), excludes it from enumeration, and prunes it past tombstone retention', () => {
    // A stale-dir orphan: grove-shaped dir whose project id is NOT a
    // current registration. Resurrection refuses it, so it stays
    // diverging forever — the exact shape the hard cap exists for.
    const staleDir = resolveProjectBufferDir(grove.id, createProjectId(), sandbox.mycoHome);
    fs.mkdirSync(staleDir, { recursive: true });
    const sessionId = 'quarantine-016';
    const age = BUFFER_HARD_RETENTION_MS + 60 * 60_000;
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'orphaned work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(age) },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'ls' }, agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(age) },
    ], staleDir);
    ageFile(bufferPathFor(sessionId, staleDir), age);

    const { logger, warns } = makeCapturingLogger();
    const reconciler = createReconciler({
      bufferDirs: () => [bufferDir, staleDir],
      logger,
      projectRoot,
      machineId: 'test-machine',
    });

    reconciler.runDrainPass();

    // Moved, not deleted — preserving the only copy of unreplayed events.
    const quarantinedPath = path.join(staleDir, BUFFER_QUARANTINE_DIRNAME, `${sessionId}.jsonl`);
    expect(fs.existsSync(bufferPathFor(sessionId, staleDir))).toBe(false);
    expect(fs.existsSync(quarantinedPath)).toBe(true);
    const warn = warns.find((w) => w.message.includes('quarantined'));
    expect(warn).toBeDefined();
    expect(warn!.data?.session_id).toBe(sessionId);
    // Both replayable events have no stored counterpart in the Grove DB.
    expect(warn!.data?.unmatched_events).toBe(2);

    // Quarantine is excluded from buffer enumeration: not listed, and a
    // fresh drain pass finds nothing to do (no resurrection from quarantine).
    expect(listBufferSessionIds(staleDir)).toEqual([]);
    const after = reconciler.runDrainPass();
    expect(after.attempted).toBe(0);
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();

    // Quarantined files older than the tombstone window are pruned.
    ageFile(quarantinedPath, TOMBSTONE_RETENTION_MS + 60 * 60_000);
    reconciler.cleanStaleBuffers();
    expect(fs.existsSync(quarantinedPath)).toBe(false);
  });

  it('evicts the converged-map entry when cleanup deletes a buffer — a recreated identical file re-converges instead of being skipped', () => {
    const sessionId = 'evict-on-delete-017';
    seedGroveSession(sessionId, 'completed');
    const dayPlus = 25 * 60 * 60 * 1000;
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'old converged work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(dayPlus) },
    ]);

    const reconciled: string[] = [];
    const reconciler = makeReconciler({
      onSessionReconciled: (id) => { reconciled.push(id); },
    });

    // Age FIRST, then converge, so the mark records the file's final
    // identity (the age gate requires mark CURRENCY). Snapshot the
    // identity for the recreation below.
    ageFile(bufferPathFor(sessionId), dayPlus);
    reconciler.reconcileSession(sessionId);
    expect(reconciled).toEqual([sessionId]);
    const stat = fs.statSync(bufferPathFor(sessionId));

    // Cleanup: converged (current mark) + closed past the stale window →
    // deleted, and the converged-map entry must be evicted with it.
    expect(reconciler.cleanStaleBuffers()).toBe(1);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(false);

    // Recreate the file byte-identical AND mtime-identical. Without
    // eviction the stale mark would match and the pass would never run.
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'old converged work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(dayPlus) },
    ]);
    fs.utimesSync(bufferPathFor(sessionId), stat.atime, stat.mtime);
    reconciler.reconcileSession(sessionId);
    expect(reconciled).toEqual([sessionId, sessionId]);
    // Content matched the stored batch — re-convergence, not duplication.
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(1);
  });

  // Regression (probe-proven): a STALE mark must never qualify a buffer
  // for the 24h age gate. Converged at identity I1, a late wedge event
  // appends (I2); the file is then the only durable copy of that event
  // and must ride retention to quarantine, not be deleted at 1d.
  it('retains a closed session whose buffer changed after convergence (stale mark) at 25h, then quarantines it at the 7d cap', () => {
    const sessionId = 'stale-mark-retention-020';
    seedGroveSession(sessionId, 'completed');
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'converged turn', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
    ]);

    const reconciler = makeReconciler();
    reconciler.reconcileSession(sessionId); // mark at identity I1
    expect(reconciler.hasUnconvergedBuffer(sessionId)).toBe(false);

    // Late wedge event lands in the buffer only → identity I2, mark stale.
    fs.appendFileSync(bufferPathFor(sessionId),
      JSON.stringify({ type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'make wedge' }, agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) }) + '\n',
    );
    expect(reconciler.hasUnconvergedBuffer(sessionId)).toBe(true);

    // 25h idle: the closed+marked session would pass a presence-only
    // check — currency keeps the only copy of the wedge event alive.
    ageFile(bufferPathFor(sessionId), 25 * 60 * 60 * 1000);
    expect(reconciler.cleanStaleBuffers()).toBe(0);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);

    // Past the hard cap it is QUARANTINED (preserved), never deleted.
    ageFile(bufferPathFor(sessionId), BUFFER_HARD_RETENTION_MS + 60 * 60_000);
    reconciler.cleanStaleBuffers();
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(false);
    expect(fs.existsSync(path.join(bufferDir, BUFFER_QUARANTINE_DIRNAME, `${sessionId}.jsonl`))).toBe(true);
  });

  // -- Cap fairness ------------------------------------------------------------

  it('quiescence-skips consume no cap slots — a drainable session behind cap-many gated sessions drains in the SAME pass', () => {
    // CAP sessions that are NOT quiescent (active, open batch, fresh buffer).
    for (let i = 0; i < CAPTURE_BUFFER_DRAIN_SESSION_CAP; i++) {
      const sessionId = `gated-${String(i).padStart(3, '0')}`;
      seedGroveSession(sessionId);
      inGrove(() => handleUserPrompt(sessionId, `open turn ${i}`, { kind: 'initial' }));
      writeBuffer(sessionId, [
        { type: 'user_prompt', prompt: `open turn ${i}`, origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(10_000) },
      ]);
    }
    // One drainable session (closed → quiescent immediately).
    const drainableId = 'cap-fair-drainable';
    seedGroveSession(drainableId, 'completed');
    writeBuffer(drainableId, [
      { type: 'user_prompt', prompt: 'should not be starved', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ]);

    const summary = makeReconciler().runDrainPass();
    expect(summary.skippedQuiescent).toBe(CAPTURE_BUFFER_DRAIN_SESSION_CAP);
    expect(summary.deferredByCap).toBe(0);
    expect(summary.drained).toBe(1);
    expect(inGrove(() => listBatchesBySession(drainableId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(1);
  });

  it('scan rotation: cap-many undrainable diverging buffers cannot starve a drainable one past the next pass', () => {
    // CAP benign-deferred buffers: row-absent, no replayable content —
    // every pass attempts them (consuming cap slots) and defers them for
    // retention. They never converge and never back off.
    for (let i = 0; i < CAPTURE_BUFFER_DRAIN_SESSION_CAP; i++) {
      writeBuffer(`undrainable-${String(i).padStart(3, '0')}`, [
        { type: 'session_start', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
      ]);
    }
    const drainableId = 'rotation-drainable';
    seedGroveSession(drainableId, 'completed');
    writeBuffer(drainableId, [
      { type: 'user_prompt', prompt: 'reached by rotation', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ]);

    const reconciler = makeReconciler();
    // CAP+1 cap-consuming candidates → exactly one is cap-deferred in
    // pass 1, whichever it is. Rotation starts pass 2 right after pass
    // 1's last consumed slot, so the deferred candidate goes first: the
    // drainable session converges within two passes, deterministically.
    const first = reconciler.runDrainPass();
    expect(first.deferredByCap).toBe(1);
    const second = reconciler.runDrainPass();
    expect(first.drained + second.drained).toBe(1);
    expect(inGrove(() => listBatchesBySession(drainableId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(1);
  });

  // -- Quarantine prune for unavailable Groves ----------------------------------

  it('prunes expired quarantined files in a dir whose Grove DB is unavailable (fs-only path)', () => {
    // Grove-shaped dir for a grove with NO DB file → scope 'unavailable'.
    const ghostGroveId = createGroveId();
    const ghostDir = resolveProjectBufferDir(ghostGroveId, createProjectId(), sandbox.mycoHome);
    const ghostQuarantine = path.join(ghostDir, BUFFER_QUARANTINE_DIRNAME);
    fs.mkdirSync(ghostQuarantine, { recursive: true });
    const quarantinedPath = path.join(ghostQuarantine, 'ghost-session.jsonl');
    fs.writeFileSync(quarantinedPath, JSON.stringify({ type: 'user_prompt', prompt: 'long gone' }) + '\n');
    ageFile(quarantinedPath, TOMBSTONE_RETENTION_MS + 60 * 60_000);

    const reconciler = createReconciler({
      bufferDirs: () => [ghostDir],
      logger: silentLogger,
      projectRoot,
      machineId: 'test-machine',
    });
    reconciler.cleanStaleBuffers();
    expect(fs.existsSync(quarantinedPath)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Post-Stop deferred convergence trigger (ambient single-DB harness — the
// trigger mechanism is DB-agnostic; Grove binding is covered above).
// ---------------------------------------------------------------------------

describe('Post-Stop deferred convergence trigger', () => {
  let tmpDir: string;
  let bufferDir: string;
  let vaultDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-poststop-'));
    bufferDir = path.join(tmpDir, 'buffer');
    vaultDir = path.join(tmpDir, 'vault');
    fs.mkdirSync(bufferDir, { recursive: true });
    fs.mkdirSync(vaultDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeStopProcessor(onStopProcessed: (sessionId: string) => void) {
    return createStopProcessor({
      registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
      sessionBuffers: new Map(),
      transcriptMiner: {
        getAllTurnsWithSource: () => ({ turns: [], source: 'transcript' }),
        reconcileBatchKinds: () => {},
      } as never,
      embeddingManager: { onRemoved: () => {} } as never,
      resolveEmbeddingManager: () => ({ onRemoved: () => {} } as never),
      logger: silentLogger,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      vaultDir,
      projectId: null,
      planTags: [],
      planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
      onStopProcessed,
    });
  }

  /** Drain the stop queue AND the deferred (setImmediate) trigger. */
  async function settle(processor: { getActiveProcessing: () => Promise<void> | null }): Promise<void> {
    await processor.getActiveProcessing();
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  it('replays a wedge-buffered mid-session event at the Stop boundary without a restart', async () => {
    const sessionId = 's-poststop-wedge';
    seedSession({ id: sessionId, agent: 'claude-code' });
    handleUserPrompt(sessionId, 'hello', { kind: 'initial' });

    const reconciler = createReconciler({
      bufferDirs: () => [bufferDir],
      logger: silentLogger,
      projectRoot: process.cwd(),
    });

    // Converge once so the mark exists (live-path equivalent state).
    fs.writeFileSync(path.join(bufferDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: iso(30_000) }) + '\n',
    );
    reconciler.reconcileSession(sessionId);

    // Mid-turn, the daemon wedges: a tool event lands ONLY in the buffer
    // (hook fallback). The mark is now stale.
    fs.appendFileSync(path.join(bufferDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'make wedge' }, agent: 'claude-code', timestamp: iso(5_000) }) + '\n',
    );

    const processor = makeStopProcessor((id) => reconciler.reconcileSession(id));
    await processor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', last_assistant_message: 'turn done' },
    } as never);
    await settle(processor);

    // The deferred trigger re-converged THIS session: wedge event recovered.
    const activities = listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE });
    expect(activities.filter((a) => a.tool_name === 'Bash')).toHaveLength(1);
    // No duplicate batch — the stored prompt converged.
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });

  it('does NOT run a pass when the converged mark still matches the buffer', async () => {
    const sessionId = 's-poststop-noop';
    seedSession({ id: sessionId, agent: 'claude-code' });
    handleUserPrompt(sessionId, 'hello', { kind: 'initial' });

    const reconciled: string[] = [];
    const reconciler = createReconciler({
      bufferDirs: () => [bufferDir],
      logger: silentLogger,
      projectRoot: process.cwd(),
      onSessionReconciled: (id) => { reconciled.push(id); },
    });

    fs.writeFileSync(path.join(bufferDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: iso(30_000) }) + '\n',
    );
    reconciler.reconcileSession(sessionId);
    expect(reconciled).toEqual([sessionId]);

    // Stop fires; the buffer is unchanged since the converged pass, so
    // the trigger's identity check short-circuits — no second pass.
    const processor = makeStopProcessor((id) => reconciler.reconcileSession(id));
    await processor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', last_assistant_message: 'turn done' },
    } as never);
    await settle(processor);

    expect(reconciled).toEqual([sessionId]);
  });

  it('a throwing trigger is contained — the stop chain settles and a later Stop still processes', async () => {
    const sessionId = 's-poststop-throw';
    seedSession({ id: sessionId, agent: 'claude-code' });
    handleUserPrompt(sessionId, 'hello', { kind: 'initial' });

    let calls = 0;
    const processor = makeStopProcessor(() => {
      calls++;
      throw new Error('injected trigger failure');
    });
    await processor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', last_assistant_message: 'first' },
    } as never);
    await settle(processor);
    expect(calls).toBe(1);

    // The queue is healthy: a second Stop runs to completion.
    await processor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', last_assistant_message: 'second' },
    } as never);
    await settle(processor);
    expect(calls).toBe(2);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches[0].response_summary).toBe('first');
  });
});
