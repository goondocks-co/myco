/**
 * RC-7 Phase 2: session tombstones + gate-checked resurrection + retention.
 *
 * The reconciler's row-absent path discriminates four ways:
 *   1. row exists                          → converge (P1 pass)
 *   2. row absent + tombstone              → discard buffer, never resurrect
 *   3. row absent + replayable events      → RESURRECT, gated on (a) the
 *      buffer dir's (grove, project) being the project's CURRENT
 *      registration and (b) the same capture rules live auto-registration
 *      applies
 *   4. row absent + nothing replayable     → leave for retention
 *
 * Two-database topology, deliberately: the suite's singleton DB
 * (setupTestDb) plays the daemon's bootstrap/ANCHOR vault, and the Grove
 * owns a REAL on-disk DB at resolveGroveDbPath. Every per-dir reconcile
 * must bind to the GROVE DB — the boot-scoping regression this pins was
 * invisible to single-DB tests where the singleton played both roles.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { nowSec } from '../helpers/sessions.js';
import { createReconciler, type Reconciler } from '@myco/daemon/reconciliation.js';
import { runSessionMaintenance } from '@myco/daemon/jobs/session-maintenance.js';
import { openDatabase, withDatabase, type Database } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import {
  upsertSession,
  getSession,
  closeSession,
  deleteSessionCascade,
} from '@myco/db/queries/sessions.js';
import {
  SESSION_TOMBSTONE_SOURCE,
  hasSessionTombstone,
  getSessionTombstone,
} from '@myco/db/queries/session-tombstones.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { listActivities } from '@myco/db/queries/activities.js';
import {
  clearGroveRegistryCaches,
  ensureDefaultGrove,
  registerProjectInGrove,
  type GroveRecord,
} from '@myco/grove/registry.js';
import { createProjectId, ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { resolveProjectBufferDir, resolveGroveDbPath } from '@myco/grove/paths.js';
import { STALE_SESSION_THRESHOLD_MS, STALE_BUFFER_MAX_AGE_MS } from '@myco/constants.js';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

function makeWarnLogger() {
  const warns: string[] = [];
  const logger = {
    debug: () => {}, info: () => {}, error: () => {},
    warn: (_kind: string, msg: string) => { warns.push(msg); },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { logger, warns };
}

// A transcript_path that exists as a string satisfies the any_agent
// transcript_path_missing drop rule's negation; the file itself need not
// exist (missing meta just skips meta-based rules).
const TRANSCRIPT = '/tmp/myco-test-transcripts/session.jsonl';

describe('Buffer reconciliation — tombstones + gate-checked resurrection', () => {
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
    sandbox = sandboxMycoHome('myco-resurrection-');
    clearGroveRegistryCaches();
    grove = ensureDefaultGrove(sandbox.mycoHome);
    projectId = createProjectId();
    projectRoot = path.join(sandbox.mycoHome, 'workspace', 'demo-project');
    fs.mkdirSync(projectRoot, { recursive: true });
    registerProjectInGrove(grove.id, {
      projectId,
      projectName: 'demo-project',
      projectRoot,
    }, sandbox.mycoHome);
    bufferDir = resolveProjectBufferDir(grove.id, projectId, sandbox.mycoHome);
    fs.mkdirSync(bufferDir, { recursive: true });
    // The Grove's REAL on-disk DB — distinct from the singleton, which
    // plays the daemon's bootstrap/anchor vault in these tests.
    groveDb = openDatabase(resolveGroveDbPath(grove.id, sandbox.mycoHome));
    createSchema(groveDb);
  });

  afterEach(() => {
    groveDb.close();
    clearGroveRegistryCaches();
    sandbox.restore();
  });

  /** Run grove-side seeds/assertions against the Grove's real DB. */
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

  /** Push a buffer file's mtime into the past. */
  function ageBuffer(sessionId: string, ageMs: number, dir = bufferDir): void {
    const past = new Date(Date.now() - ageMs);
    fs.utimesSync(bufferPathFor(sessionId, dir), past, past);
  }

  function makeReconciler(
    logger = silentLogger,
    dirs = [bufferDir],
    extra: { registry?: { register: (id: string, meta: unknown) => void } } = {},
  ): Reconciler {
    return createReconciler({
      bufferDirs: () => dirs,
      logger,
      projectRoot,
      machineId: 'test-machine',
      ...(extra.registry ? { registry: extra.registry as never } : {}),
    });
  }

  function iso(msAgo: number): string {
    return new Date(Date.now() - msAgo).toISOString();
  }

  // -- Boot scoping: the per-dir Grove DB binding (regression pins) ----------

  it('BOOT: a tombstone in the GROVE DB blocks resurrection — buffer deleted, anchor untouched', () => {
    const sessionId = 'boot-tombstone-001';
    inGrove(() => {
      upsertSession({ id: sessionId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId });
      deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.API_DELETE);
    });
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'deleted before the restart', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
    ]);

    // Bare startup call — no ambient request scope, exactly like main().
    // The reconciler must bind the dir to the GROVE DB itself; an
    // anchor-bound pass would miss the tombstone and resurrect.
    makeReconciler().runStartupReconciliation();

    // No resurrection anywhere.
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(0);
    // Anchor (singleton) untouched.
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeNull();
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    // Buffer discarded.
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(false);
  });

  it('BOOT: a gate-passing resurrection lands in the GROVE DB, not the anchor', () => {
    const sessionId = 'boot-resurrect-002';
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'offline work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'make build' }, agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ]);

    makeReconciler().runStartupReconciliation();

    // Session + batches + activities live in the GROVE DB.
    const groveSession = inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!;
    expect(groveSession).not.toBeNull();
    expect(groveSession.project_id).toBe(projectId);
    const groveBatches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(groveBatches).toHaveLength(1);
    expect(groveBatches[0].user_prompt).toBe('offline work');
    expect(
      inGrove(() => listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE }))
        .filter((a) => a.tool_name === 'Bash'),
    ).toHaveLength(1);
    // The ANCHOR got nothing.
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeNull();
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  // -- Shape 3: offline gate-passing session is resurrected -----------------

  it('resurrects a gate-passing offline session: row created with correct agent + identity, batches + activities replayed', () => {
    const sessionId = 'resurrect-pass-001';
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'fix the flaky test', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'npm test' }, agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(30_000) },
    ]);

    makeReconciler().reconcileSession(sessionId);

    const session = inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!;
    expect(session).not.toBeNull();
    expect(session.agent).toBe('claude-code');
    expect(session.project_id).toBe(projectId);
    expect(session.project_root).toBe(projectRoot);
    expect(session.machine_id).toBe('test-machine');
    // Fresh events → still active, no premature close.
    expect(session.status).toBe('active');

    const batches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('fix the flaky test');
    const activities = inGrove(() => listActivities({ session_id: sessionId, scope: ALL_PROJECTS_SCOPE }));
    expect(activities.filter((a) => a.tool_name === 'Bash')).toHaveLength(1);
    // Buffer is retained (it converged; cleanup is age-gated, not eager).
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);
  });

  it('takes agent from the first buffered event carrying one (hook-shape events without agent are skipped)', () => {
    const sessionId = 'resurrect-agent-002';
    writeBuffer(sessionId, [
      // Hook-side buffered copy: transcript_path but no agent field.
      { type: 'user_prompt', prompt: 'first', origin: 'human', transcript_path: TRANSCRIPT, timestamp: iso(50_000) },
      { type: 'tool_use', tool_name: 'Read', tool_input: { file: 'a.ts' }, agent: 'cursor', transcript_path: TRANSCRIPT, timestamp: iso(20_000) },
    ]);

    makeReconciler().reconcileSession(sessionId);

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!.agent).toBe('cursor');
  });

  it('closes a resurrected session immediately when its newest buffered event is older than the stale threshold — and never registers it in the registry', () => {
    const sessionId = 'resurrect-stale-003';
    const staleAge = STALE_SESSION_THRESHOLD_MS + 5 * 60_000;
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'historic work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(staleAge + 60_000) },
      { type: 'tool_use', tool_name: 'Bash', tool_input: { command: 'ls' }, agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(staleAge) },
    ]);

    const registered: string[] = [];
    makeReconciler(silentLogger, [bufferDir], {
      registry: { register: (id) => { registered.push(id); } },
    }).reconcileSession(sessionId);

    const session = inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!;
    expect(session.status).toBe('completed');
    expect(session.ended_at).not.toBeNull();
    // The completion chokepoint also closed the replayed batch.
    const batches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(batches).toHaveLength(1);
    expect(batches[0].ended_at).not.toBeNull();
    // Closed-at-birth resurrections must not enter the in-memory registry:
    // no unregister ever comes, and registry membership shields a session
    // from the dead sweep.
    expect(registered).toEqual([]);
  });

  it('registers a FRESH resurrection in the in-memory registry (live session may continue)', () => {
    const sessionId = 'resurrect-fresh-registry-003b';
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'still going', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(10_000) },
    ]);

    const registered: string[] = [];
    makeReconciler(silentLogger, [bufferDir], {
      registry: { register: (id) => { registered.push(id); } },
    }).reconcileSession(sessionId);

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!.status).toBe('active');
    expect(registered).toEqual([sessionId]);
  });

  // -- Shape 4: gate-rejected resurrection is refused ------------------------

  it('refuses a gate-rejected session: no row, buffer deleted, and no flap when the stop-gate cleanup also fires', () => {
    const sessionId = 'resurrect-reject-004';
    // No transcript_path on any event → the any_agent
    // transcript_path_missing rule drops it (the Codex ephemeral /
    // phantom shape buffered by older bufferOnIgnored-era hooks).
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'generate a title', origin: 'human', agent: 'codex', timestamp: iso(60_000) },
    ]);

    const reconciler = makeReconciler();
    reconciler.reconcileSession(sessionId);

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(0);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(false);

    // The stop-gate path (cleanupInvalidCapturedSession) firing for the
    // same id is a no-op: nothing to delete, no tombstone for a row that
    // never existed, and the reconciler stays settled. No flap.
    const cascade = inGrove(() => deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.INVALID_CAPTURE));
    expect(cascade.deleted).toBe(false);
    expect(inGrove(() => hasSessionTombstone(sessionId))).toBe(false);
    reconciler.reconcileSession(sessionId);
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
  });

  // -- Shape 5: tombstoned session never resurrects --------------------------

  it('a tombstoned session with a lingering buffer produces zero rows and the buffer is deleted', () => {
    const sessionId = 'tombstone-005';
    inGrove(() => {
      upsertSession({ id: sessionId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId });
      deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.API_DELETE);
    });
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'should never come back', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
    ]);

    makeReconciler().reconcileSession(sessionId);

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(0);
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(false);
    expect(inGrove(() => getSessionTombstone(sessionId))!.source).toBe('api_delete');
  });

  // -- Shape 6: same-id reload after delete ----------------------------------

  it('a same-id reload after delete converges normally — the live-recreated row outranks the tombstone', () => {
    const sessionId = 'reload-006';
    inGrove(() => {
      upsertSession({ id: sessionId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId });
      deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.API_DELETE);
    });
    expect(inGrove(() => hasSessionTombstone(sessionId))).toBe(true);

    // The reload: the live dispatcher gate passed and recreated the row,
    // and the API delete path cleared the reconciler's per-lifetime mark.
    inGrove(() => upsertSession({ id: sessionId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId }));
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'second life', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(10_000) },
    ]);

    const reconciler = makeReconciler();
    reconciler.clearSession(sessionId);
    reconciler.reconcileSession(sessionId);

    const batches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('second life');
  });

  // -- Shape 17: moved-project stale dir --------------------------------------

  it('skips + WARNs on a buffer in a stale dir (identity no longer the project\'s current registration), leaving the file', () => {
    const sessionId = 'moved-017';
    // Grove-shaped dir for a project id that is NOT registered — the
    // moved/re-homed shape (the project re-registered under a new id).
    const staleDir = resolveProjectBufferDir(grove.id, createProjectId(), sandbox.mycoHome);
    fs.mkdirSync(staleDir, { recursive: true });
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'orphaned by a move', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
    ], staleDir);

    const { logger, warns } = makeWarnLogger();
    makeReconciler(logger, [staleDir]).reconcileSession(sessionId);

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).toBeNull();
    expect(fs.existsSync(bufferPathFor(sessionId, staleDir))).toBe(true);
    expect(warns.some((w) => w.includes('not a current project registration'))).toBe(true);
  });

  it('leaves a row-absent, tombstone-free buffer with no replayable events for retention (no action)', () => {
    const sessionId = 'retention-018';
    writeBuffer(sessionId, [
      { type: 'session_start', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
    ]);

    makeReconciler().reconcileSession(sessionId);

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(true);
  });

  // -- Dead-session sweep defers on unconverged buffers ------------------------

  it('sweep defers a zero-batch session with an unconverged buffer; after convergence a genuinely-empty session sweeps + tombstones', async () => {
    const sessionId = 'sweep-defer-007';
    inGrove(() => upsertSession({
      id: sessionId, agent: 'claude-code', status: 'completed',
      started_at: nowSec(), created_at: nowSec(), project_id: projectId,
    }));
    // Replayable (stop) but yields no batch — the genuinely-empty shape.
    writeBuffer(sessionId, [
      { type: 'stop', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(60_000) },
    ]);

    const reconciler = makeReconciler();
    const embeddingStub = { onRemoved: () => {} } as never;
    const maintenanceDeps = {
      logger: silentLogger,
      registeredSessionIds: () => [] as string[],
      embeddingManager: embeddingStub,
      resolveProjectVaultDir: () => null,
      hasUnconvergedBuffer: (id: string) => reconciler.hasUnconvergedBuffer(id),
    };
    // Production runs maintenance inside forEachGrove's withDatabase scope;
    // mirror that binding here.
    const runMaintenance = () => withDatabase(groveDb, () => runSessionMaintenance(maintenanceDeps));

    // Cycle 1: buffer not yet converged → sweep defers.
    await runMaintenance();
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).not.toBeNull();
    expect(inGrove(() => hasSessionTombstone(sessionId))).toBe(false);

    // Reconcile trigger converges the buffer (still zero batches).
    reconciler.reconcileSession(sessionId);
    expect(reconciler.hasUnconvergedBuffer(sessionId)).toBe(false);
    expect(inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }))).toHaveLength(0);

    // Cycle 2: genuinely empty → swept, tombstoned, buffer removed.
    await runMaintenance();
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).toBeNull();
    expect(inGrove(() => getSessionTombstone(sessionId))!.source).toBe('maintenance_sweep');
    expect(fs.existsSync(bufferPathFor(sessionId))).toBe(false);
  });

  // -- Shape 16 (P2 scope): convergence-aware retention -------------------------

  it('retention: diverging buffer at 25h survives; converged+closed at 25h is deleted; tombstoned is deleted immediately', () => {
    const dayPlus = STALE_BUFFER_MAX_AGE_MS + 60 * 60_000; // 25h

    const reconciler = makeReconciler();

    // Converged + closed, 25h old → eligible. The file is aged BEFORE the
    // converging pass so the mark records the file's final identity — the
    // age gate requires mark CURRENCY, not mere presence (in production
    // an untouched file keeps its converge-time identity as it ages).
    const convergedId = 'retain-converged-016';
    inGrove(() => upsertSession({ id: convergedId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId }));
    writeBuffer(convergedId, [
      { type: 'user_prompt', prompt: 'done work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(dayPlus) },
    ]);
    ageBuffer(convergedId, dayPlus);
    reconciler.reconcileSession(convergedId);
    inGrove(() => closeSession(convergedId, nowSec()));

    // Converged but still ACTIVE at 25h → retained.
    const activeId = 'retain-active-016';
    inGrove(() => upsertSession({ id: activeId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId }));
    writeBuffer(activeId, [
      { type: 'user_prompt', prompt: 'long-running', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(dayPlus) },
    ]);
    reconciler.reconcileSession(activeId);
    ageBuffer(activeId, dayPlus);

    // Diverging (closed but never converged this lifetime) at 25h → retained.
    const divergingId = 'retain-diverging-016';
    inGrove(() => upsertSession({ id: divergingId, agent: 'claude-code', status: 'completed', started_at: nowSec(), created_at: nowSec(), project_id: projectId }));
    writeBuffer(divergingId, [
      { type: 'user_prompt', prompt: 'unreplayed events', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(dayPlus) },
    ]);
    ageBuffer(divergingId, dayPlus);

    // Tombstoned with a FRESH buffer → deleted immediately.
    const tombstonedId = 'retain-tombstoned-016';
    inGrove(() => {
      upsertSession({ id: tombstonedId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId });
      deleteSessionCascade(tombstonedId, SESSION_TOMBSTONE_SOURCE.API_DELETE);
    });
    writeBuffer(tombstonedId, [
      { type: 'user_prompt', prompt: 'deleted session leftovers', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(1000) },
    ]);

    // No ambient binding — the cleanup must bind each dir to its Grove DB
    // itself (boot + cross-grove unregister shape).
    const removed = reconciler.cleanStaleBuffers();

    expect(removed).toBe(2);
    expect(fs.existsSync(bufferPathFor(convergedId))).toBe(false);
    expect(fs.existsSync(bufferPathFor(tombstonedId))).toBe(false);
    expect(fs.existsSync(bufferPathFor(activeId))).toBe(true);
    expect(fs.existsSync(bufferPathFor(divergingId))).toBe(true);
  });

  it('startup reconciliation converges FIRST, then cleans — an aged diverging buffer is replayed, not destroyed', () => {
    const sessionId = 'startup-order-008';
    inGrove(() => upsertSession({ id: sessionId, agent: 'claude-code', started_at: nowSec(), created_at: nowSec(), project_id: projectId }));
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'survived the outage', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(STALE_BUFFER_MAX_AGE_MS + 60 * 60_000) },
    ]);
    // Older than the old clean-first ordering's 24h purge.
    ageBuffer(sessionId, STALE_BUFFER_MAX_AGE_MS + 60 * 60_000);

    makeReconciler().runStartupReconciliation();

    const batches = inGrove(() => listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }));
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('survived the outage');
  });

  it('resurrected stale sessions do not linger as actives that the stale sweep would have to mop up', async () => {
    // Companion to the close-if-stale shape: after resurrection+close, the
    // maintenance sweep sees a completed session with real batches and
    // leaves it alone (it is not "dead": it has prompts).
    const sessionId = 'resurrect-no-zombie-009';
    const staleAge = STALE_SESSION_THRESHOLD_MS + 10 * 60_000;
    writeBuffer(sessionId, [
      { type: 'user_prompt', prompt: 'old but real work', origin: 'human', agent: 'claude-code', transcript_path: TRANSCRIPT, timestamp: iso(staleAge) },
    ]);
    const reconciler = makeReconciler();
    reconciler.reconcileSession(sessionId);
    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))!.status).toBe('completed');

    await withDatabase(groveDb, () => runSessionMaintenance({
      logger: silentLogger,
      registeredSessionIds: () => [],
      embeddingManager: { onRemoved: () => {} } as never,
      resolveProjectVaultDir: () => null,
      hasUnconvergedBuffer: (id: string) => reconciler.hasUnconvergedBuffer(id),
    }));

    expect(inGrove(() => getSession(sessionId, ALL_PROJECTS_SCOPE))).not.toBeNull();
    expect(inGrove(() => hasSessionTombstone(sessionId))).toBe(false);
  });
});
