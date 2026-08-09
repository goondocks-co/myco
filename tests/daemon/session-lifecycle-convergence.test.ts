import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { createSessionLifecycleHandlers } from '@myco/daemon/api/session-lifecycle.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { getDatabase } from '@myco/db/client.js';
import { insertSessionTombstone, hasSessionTombstone, SESSION_TOMBSTONE_SOURCE } from '@myco/db/queries/session-tombstones.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const nowSec = () => Math.floor(Date.now() / 1000);

function makeHandlers(vaultDir: string, miner: { reconcileAndAttributeResponses: ReturnType<typeof vi.fn> }) {
  return createSessionLifecycleHandlers({
    registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
    sessionBuffers: new Map(),
    reconciler: { reconcileSession: vi.fn(), clearSession: vi.fn(), cleanStaleBuffers: vi.fn(() => 0) },
    stopProcessor: { clearSession: vi.fn() },
    transcriptMiner: miner,
    server: { updateDaemonJsonSessions: vi.fn() },
    powerManager: { recordActivity: vi.fn() },
    machineId: 'test-machine',
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    liveConfig: { current: { agent: { event_tasks_enabled: false }, notifications: { enabled: false } } },
    vaultDir,
  } as never);
}

function req(session_id: string) {
  return { body: { session_id }, requestContext: undefined } as never;
}

describe('SessionEnd transcript convergence (handleUnregister)', () => {
  let vaultDir: string;
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => {
    cleanTestDb();
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-session-end-'));
  });

  it('runs the authoritative convergence with the session agent + transcript_path on session end', async () => {
    const transcriptPath = path.join(vaultDir, 'transcript.jsonl');
    fs.writeFileSync(transcriptPath, '');
    upsertSession({
      id: 'sess-end-1',
      agent: 'claude-code',
      status: 'active',
      started_at: nowSec(),
      created_at: nowSec(),
      transcript_path: transcriptPath,
    });
    const reconcile = vi.fn();
    const { handleUnregister } = makeHandlers(vaultDir, { reconcileAndAttributeResponses: reconcile });

    await handleUnregister(req('sess-end-1'));

    // The final turn's response must be attributed at the session boundary —
    // even when no trailing tool event / clean per-turn Stop occurred.
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith('sess-end-1', {
      agent: 'claude-code',
      transcriptPath,
    });
    // Convergence runs BEFORE the session is closed.
    const session = getSession('sess-end-1', ALL_PROJECTS_SCOPE)!;
    expect(session.status).toBe('completed');
  });

  it('skips convergence when the session never recorded a transcript_path', async () => {
    upsertSession({
      id: 'sess-end-2',
      agent: 'claude-code',
      status: 'active',
      started_at: nowSec(),
      created_at: nowSec(),
    });
    const reconcile = vi.fn();
    const { handleUnregister } = makeHandlers(vaultDir, { reconcileAndAttributeResponses: reconcile });

    await handleUnregister(req('sess-end-2'));

    expect(reconcile).not.toHaveBeenCalled();
    expect(getSession('sess-end-2', ALL_PROJECTS_SCOPE)!.status).toBe('completed');
  });

  it('still closes the session when convergence throws (best-effort)', async () => {
    const transcriptPath = path.join(vaultDir, 't2.jsonl');
    fs.writeFileSync(transcriptPath, '');
    upsertSession({
      id: 'sess-end-3', agent: 'claude-code', status: 'active',
      started_at: nowSec(), created_at: nowSec(), transcript_path: transcriptPath,
    });
    const reconcile = vi.fn(() => { throw new Error('boom'); });
    const { handleUnregister } = makeHandlers(vaultDir, { reconcileAndAttributeResponses: reconcile });

    await handleUnregister(req('sess-end-3'));

    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(getSession('sess-end-3', ALL_PROJECTS_SCOPE)!.status).toBe('completed');
  });
});

describe('explicit register supersedes a session tombstone', () => {
  let vaultDir: string;
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => {
    cleanTestDb();
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-register-tomb-'));
  });
  afterEach(() => { fs.rmSync(vaultDir, { recursive: true, force: true }); });

  function registerReq(session_id: string) {
    return {
      body: { session_id, agent: 'claude-code' },
      requestContext: {
        projectRoot: vaultDir,
        projectId: 'proj_0123456789abcdef0123456789abcdef',
        groveId: 'grove_0123456789abcdef0123456789abcdef',
        machineId: 'test-machine',
        sessionId: null,
        projectVaultDir: vaultDir,
        databasePath: path.join(vaultDir, 'myco.db'),
        source: 'headers',
      },
    } as never;
  }

  it('POST /sessions/register clears any tombstone and recreates the row', async () => {
    const sessionId = 'reload-after-delete-001';
    insertSessionTombstone(getDatabase(), {
      sessionId,
      projectId: null,
      source: SESSION_TOMBSTONE_SOURCE.PHANTOM_REAP,
    });

    const { handleRegister } = makeHandlers(vaultDir, { reconcileAndAttributeResponses: vi.fn(() => ({})) });
    await handleRegister(registerReq(sessionId));

    expect(hasSessionTombstone(sessionId)).toBe(false);
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).not.toBeNull();
  });

  it('clears api_delete tombstones too — an explicit same-id reload is the sanctioned supersede', async () => {
    const sessionId = 'reload-after-delete-002';
    insertSessionTombstone(getDatabase(), {
      sessionId,
      projectId: null,
      source: SESSION_TOMBSTONE_SOURCE.API_DELETE,
    });

    const { handleRegister } = makeHandlers(vaultDir, { reconcileAndAttributeResponses: vi.fn(() => ({})) });
    await handleRegister(registerReq(sessionId));

    expect(hasSessionTombstone(sessionId)).toBe(false);
    expect(getSession(sessionId, ALL_PROJECTS_SCOPE)).not.toBeNull();
  });
});
