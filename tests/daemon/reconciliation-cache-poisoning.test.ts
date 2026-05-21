import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

// reconcileSession bails when the session row is absent (deleted, or
// not yet created). The bail must NOT mark the session reconciled — a
// later call after the row appears has to replay the buffer cleanly.

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

  it('a bailout for a missing session row does NOT mark the session reconciled — a later call after the row appears completes the replay', () => {
    const sessionId = 'cache-poison-001';
    const promptText = 'investigate the wedge';
    const bufferPath = path.join(bufferDir, `${sessionId}.jsonl`);
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: promptText, timestamp: '2026-05-18T17:37:20.907Z' }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: [bufferDir], logger: silentLogger, projectRoot: process.cwd() });

    // First call: session row not present yet. Reconciler must bail and
    // must NOT poison the cache.
    reconciler.reconcileSession(sessionId);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);

    // Simulate the /events auto-register path: the session row appears.
    seedSession({ id: sessionId, agent: 'claude-code' });

    // Second call: the row now exists, the buffer is still on disk. The
    // reconciler must replay and open the batch.
    reconciler.reconcileSession(sessionId);
    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe(promptText);
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
