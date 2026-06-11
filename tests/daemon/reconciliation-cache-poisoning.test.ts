import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { deleteSessionCascade } from '@myco/db/queries/sessions.js';
import { SESSION_TOMBSTONE_SOURCE } from '@myco/db/queries/session-tombstones.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// A session row being absent is no longer one shape — the reconciler
// discriminates three ways:
//   - tombstoned (deliberately deleted)      → discard the buffer, mark
//   - never-registered buffer dir            → skip WITHOUT marking, so a
//     later call after the row appears completes the replay
//   - gate-rejected resurrection candidate   → discard the buffer, no row
//     (covered in reconciliation-resurrection.test.ts — it needs a real
//     sandboxed Grove registration to pass the identity gate)

describe('Buffer reconciliation — cache poisoning protection', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-cache-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a row-absent skip for a never-registered buffer dir does NOT mark the session reconciled — a later call after the row appears completes the replay', () => {
    const sessionId = 'cache-poison-001';
    const promptText = 'investigate the wedge';
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: promptText, timestamp: '2026-05-18T17:37:20.907Z' }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: [bufferDir], logger: silentLogger, projectRoot: process.cwd() });

    // First call: session row not present, no tombstone, and the buffer
    // dir is not a current Grove registration — the identity gate refuses
    // resurrection, leaves the file, and must NOT poison the cache.
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    expect(fs.existsSync(bufferPath)).toBe(true);

    // Simulate the /events auto-register path: the session row appears.
    seedSession({ id: sessionId, agent: 'claude-code' });

    // Second call: the row now exists, the buffer is still on disk. The
    // reconciler must replay and open the batch.
    reconciler.reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe(promptText);
  });

  it('a row-absent TOMBSTONED session is terminal — the buffer is discarded and the session marked converged', () => {
    const sessionId = 'cache-poison-004';
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'stale events', timestamp: '2026-05-18T17:37:20.907Z' }) + '\n',
    );
    // Real deletion flow: the cascade removes the row AND writes the tombstone.
    seedSession({ id: sessionId, agent: 'claude-code' });
    deleteSessionCascade(sessionId, SESSION_TOMBSTONE_SOURCE.API_DELETE);

    const reconciler = createReconciler({ bufferDirs: [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession(sessionId);

    // Skip-not-resurrect: no rows created, buffer gone, marked converged
    // (a second call is a no-op even though nothing replayed).
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    expect(fs.existsSync(bufferPath)).toBe(false);
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  it('a missing buffer file does NOT poison the cache either — a later call after the buffer is written replays it', () => {
    const sessionId = 'cache-poison-002';
    seedSession({ id: sessionId, agent: 'claude-code' });

    const reconciler = createReconciler({ bufferDirs: [bufferDir], logger: silentLogger, projectRoot: process.cwd() });

    // No buffer file on disk yet — reconciler should silently no-op.
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);

    // Now the buffer is written (e.g. a hook fires and the daemon was hot
    // enough that the buffer was created but not yet drained).
    const promptText = 'follow-up question';
    fs.writeFileSync(path.join(bufferDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user_prompt', prompt: promptText, timestamp: '2026-05-18T17:42:49.644Z' }) + '\n',
    );

    reconciler.reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe(promptText);
  });

  it('a successful reconcile still marks the session — a second call is a no-op (existing per-lifetime guard preserved)', () => {
    const sessionId = 'cache-poison-003';
    seedSession({ id: sessionId, agent: 'claude-code' });

    const promptText = 'first prompt';
    fs.writeFileSync(path.join(bufferDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user_prompt', prompt: promptText, timestamp: '2026-05-18T17:37:20.907Z' }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: [bufferDir], logger: silentLogger, projectRoot: process.cwd() });

    reconciler.reconcileSession(sessionId);
    const batchesAfterFirst = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batchesAfterFirst).toHaveLength(1);

    // Append a second event to the buffer. The cache is now marked, so a
    // second reconcileSession must skip without re-replaying — this is
    // the existing once-per-lifetime guarantee. If it ever re-replayed,
    // we'd get duplicate batches.
    fs.appendFileSync(path.join(bufferDir, `${sessionId}.jsonl`),
      JSON.stringify({ type: 'user_prompt', prompt: 'second prompt', timestamp: '2026-05-18T17:42:00.000Z' }) + '\n',
    );
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(1);
  });
});
