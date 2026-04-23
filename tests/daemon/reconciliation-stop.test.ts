import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession, setResponseSummary } from '@myco/db/queries/batches.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

describe('Buffer reconciliation — stop events (opencode response_summary recovery)', () => {
  let tmpDir: string;
  let bufferDir: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-stop-'));
    bufferDir = path.join(tmpDir, 'buffer');
    fs.mkdirSync(bufferDir, { recursive: true });
    seedSession({ id: 's-stop', agent: 'opencode' });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Regression: mycoPostStop used plain postJson — a daemon restart during
  // session.idle would silently drop the Stop event. The fallback now writes
  // the stop to the session buffer, and startup reconciliation applies it.
  it('sets response_summary from a buffered stop when the daemon missed it live', () => {
    // Daemon captured the live prompt and closed the batch without a summary
    // (as if Stop had been dropped).
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });

    // Buffer file carries the missing Stop.
    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'recovered summary', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop');
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].response_summary).toBe('recovered summary');
  });

  it('does not overwrite an existing response_summary', () => {
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    setResponseSummary(batchId, 'original summary');

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'buffered summary', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop');
    expect(batches[0].response_summary).toBe('original summary');
  });

  it('skips stop events with empty last_assistant_message', () => {
    handleUserPrompt('s-stop', 'hello', { kind: 'initial' });

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: '', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop');
    expect(batches[0].response_summary).toBeNull();
  });

  it('recovers stops even when prompt counts already match (no divergence)', () => {
    // DB has exactly one batch matching the buffer's prompt — no new prompts
    // to replay. Before the stop-pass, no replay ran at all; now stops still
    // get applied idempotently.
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'late summary', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDir, logger: silentLogger });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop');
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].response_summary).toBe('late summary');
  });
});
