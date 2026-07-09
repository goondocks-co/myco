/**
 * Integration tests for host-side `transcript_path` substitution at the capture
 * ingest handlers (plan C4).
 *
 * Proves the full routed-capture chain on the HOST: a host-served Stop whose body
 * carries a MEMBER-local `transcript_path` is stamped onto the session row with
 * the MATERIALIZED host path (C2), so the DB-fed SessionEnd trigger
 * (`handleUnregister`) then mines the host file — not the member path that does
 * not exist here. A local request is byte-identical to today (member path
 * stamped), and a routed session whose bytes have not drained degrades to no
 * stamp.
 *
 * Hermetic disk: `MYCO_TEAM_HOME` points at a tmpdir so the materialized-cache
 * resolvers never touch the developer's real `~/.myco-team`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { createStopProcessor } from '@myco/daemon/stop-processing.js';
import { createSessionLifecycleHandlers } from '@myco/daemon/api/session-lifecycle.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { resolveRoutedTranscriptPath } from '@myco/grove/paths.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const nowSec = () => Math.floor(Date.now() / 1000);

const MEMBER_MACHINE = 'alice_a1b2c3d4';
const MEMBER_PATH = '/Users/alice/.claude/projects/p/routed.jsonl';

/** Materialize a host transcript file at the C2-keyed path and return it. */
function materialize(machine: string, session: string, tid: string, content = '{"type":"x"}\n'): string {
  const filePath = resolveRoutedTranscriptPath(machine, session, tid);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

/** A minimal stop processor with a stubbed miner (no real transcript parse). */
function makeStopProcessor(vaultDir: string) {
  return createStopProcessor({
    registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
    sessionBuffers: new Map(),
    transcriptMiner: {
      getAllTurnsWithSource: vi.fn(() => ({ turns: [], source: 'transcript' })),
    } as never,
    embeddingManager: { onRemoved: vi.fn() } as never,
    resolveEmbeddingManager: () => ({ onRemoved: vi.fn() } as never),
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
    vaultDir,
    planTags: [],
    planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
  });
}

/** A host-served request context carrying the MEMBER's machine id (the id the
 *  proxied `x-myco-machine-id` header supplies and the C1 drain keys on). */
function hostServedContext(vaultDir: string) {
  return {
    projectRoot: vaultDir,
    callerRoot: null,
    projectId: null,
    groveId: null,
    machineId: MEMBER_MACHINE,
    sessionId: null,
    projectVaultDir: vaultDir,
    databasePath: vaultDir,
    source: 'headers',
    tenancySource: 'caller',
    hostServed: true,
  };
}

function makeLifecycleHandlers(
  vaultDir: string,
  miner: { reconcileAndAttributeResponses: ReturnType<typeof vi.fn> },
) {
  return createSessionLifecycleHandlers({
    registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
    sessionBuffers: new Map(),
    reconciler: { reconcileSession: vi.fn(), clearSession: vi.fn(), cleanStaleBuffers: vi.fn(() => 0) },
    stopProcessor: { clearSession: vi.fn() },
    transcriptMiner: miner,
    server: { updateDaemonJsonSessions: vi.fn() },
    powerManager: { recordActivity: vi.fn() },
    machineId: 'host-machine',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    liveConfig: { current: { agent: { event_tasks_enabled: false }, notifications: { enabled: false } } },
    vaultDir,
  } as never);
}

describe('C4 — host transcript_path substitution at ingest', () => {
  let vaultDir: string;
  let tmpTeamHome: string;
  let savedTeamHome: string | undefined;

  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());

  beforeEach(() => {
    cleanTestDb();
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-c4-vault-'));
    tmpTeamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-c4-team-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmpTeamHome;
  });

  afterAll(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
  });

  it('stamps the MATERIALIZED host path onto the session row for a host-served Stop', async () => {
    const sessionId = 'c4-stamp-001';
    const hostPath = materialize(MEMBER_MACHINE, sessionId, `tx_${'a'.repeat(32)}`);
    upsertSession({ id: sessionId, agent: 'claude-code', status: 'active', started_at: nowSec(), created_at: nowSec() });

    const stopProcessor = makeStopProcessor(vaultDir);
    await stopProcessor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', transcript_path: MEMBER_PATH, last_assistant_message: 'ok' },
      requestContext: hostServedContext(vaultDir),
    } as never);
    await stopProcessor.getActiveProcessing();

    const row = getSession(sessionId, ALL_PROJECTS_SCOPE)!;
    expect(row.transcript_path).toBe(hostPath);
    expect(row.transcript_path).not.toBe(MEMBER_PATH);
  });

  it('rotation: stamps the current (most-recent) tid when several exist for the session', async () => {
    const sessionId = 'c4-rotate-001';
    const old = materialize(MEMBER_MACHINE, sessionId, `tx_${'a'.repeat(32)}`);
    const live = materialize(MEMBER_MACHINE, sessionId, `tx_${'b'.repeat(32)}`);
    const base = nowSec();
    fs.utimesSync(old, base - 100, base - 100);
    fs.utimesSync(live, base, base);
    upsertSession({ id: sessionId, agent: 'claude-code', status: 'active', started_at: base, created_at: base });

    const stopProcessor = makeStopProcessor(vaultDir);
    await stopProcessor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', transcript_path: MEMBER_PATH, last_assistant_message: 'ok' },
      requestContext: hostServedContext(vaultDir),
    } as never);
    await stopProcessor.getActiveProcessing();

    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)!.transcript_path).toBe(live);
  });

  it('local (non-host-served) Stop stamps the member path UNCHANGED', async () => {
    const sessionId = 'c4-local-001';
    upsertSession({ id: sessionId, agent: 'claude-code', status: 'active', started_at: nowSec(), created_at: nowSec() });

    const stopProcessor = makeStopProcessor(vaultDir);
    await stopProcessor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', transcript_path: MEMBER_PATH, last_assistant_message: 'ok' },
      // requestContext omitted → local request, no substitution.
    } as never);
    await stopProcessor.getActiveProcessing();

    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)!.transcript_path).toBe(MEMBER_PATH);
  });

  it('host-served Stop with NO materialized file degrades: no bogus path is stamped', async () => {
    const sessionId = 'c4-degrade-001';
    upsertSession({ id: sessionId, agent: 'claude-code', status: 'active', started_at: nowSec(), created_at: nowSec() });

    const stopProcessor = makeStopProcessor(vaultDir);
    await stopProcessor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', transcript_path: MEMBER_PATH, last_assistant_message: 'ok' },
      requestContext: hostServedContext(vaultDir),
    } as never);
    await stopProcessor.getActiveProcessing();

    // Neither the (non-existent) member path nor any bogus path is stamped.
    const stamped = getSession(sessionId, ALL_PROJECTS_SCOPE)!.transcript_path;
    expect(stamped ?? null).toBeNull();
  });

  it('the DB-fed SessionEnd trigger resolves against the substituted host path', async () => {
    const sessionId = 'c4-sessionend-001';
    const hostPath = materialize(MEMBER_MACHINE, sessionId, `tx_${'a'.repeat(32)}`);
    upsertSession({ id: sessionId, agent: 'claude-code', status: 'active', started_at: nowSec(), created_at: nowSec() });

    // 1) Host-served Stop substitutes + stamps the host path onto the row.
    const stopProcessor = makeStopProcessor(vaultDir);
    await stopProcessor.handleStopRoute({
      body: { session_id: sessionId, agent: 'claude-code', transcript_path: MEMBER_PATH, last_assistant_message: 'ok' },
      requestContext: hostServedContext(vaultDir),
    } as never);
    await stopProcessor.getActiveProcessing();

    // 2) SessionEnd reads the stamped row and mines it — must be the HOST path.
    const reconcile = vi.fn();
    const { handleUnregister } = makeLifecycleHandlers(vaultDir, { reconcileAndAttributeResponses: reconcile });
    await handleUnregister({ body: { session_id: sessionId }, requestContext: undefined } as never);

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(sessionId, { agent: 'claude-code', transcriptPath: hostPath });
    // Explicitly: the member path is NEVER what the miner opens on the host.
    expect(reconcile.mock.calls[0][1].transcriptPath).not.toBe(MEMBER_PATH);
  });
});
