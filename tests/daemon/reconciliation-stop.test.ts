import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { createReconciler } from '@myco/daemon/reconciliation.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession, setResponseSummary } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const silentLogger = {
  debug: () => {}, info: () => {}, warn: () => {}, error: () => {},
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
} as any;

/**
 * Backdate a batch so the stop-replay freshness guard sees it as STALE.
 * A missed-Stop batch stays open with no further activity — its created_at
 * (and absent activity rows) place its last sign of life in the past.
 */
function backdateBatch(batchId: number, ageSeconds: number): void {
  const past = nowSec() - ageSeconds;
  getDatabase().prepare(
    `UPDATE prompt_batches SET created_at = ?, started_at = ? WHERE id = ?`,
  ).run(past, past, batchId);
}

const STALE_AGE_SECONDS = 3600; // well past STOP_REPLAY_OPEN_BATCH_FRESHNESS_MS

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
    // Daemon captured the live prompt; the Stop never arrived, so the batch
    // is still OPEN — and stale, because nothing has touched it since. That
    // stale-open shape is exactly what the replayed stop must recover.
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    backdateBatch(batchId, STALE_AGE_SECONDS);

    // Buffer file carries the missing Stop.
    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'recovered summary', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].response_summary).toBe('recovered summary');
    // Recovery writes the summary only — it must not close the batch.
    expect(batches[0].ended_at).toBeNull();
  });

  it('does not overwrite an existing response_summary', () => {
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    backdateBatch(batchId, STALE_AGE_SECONDS);
    setResponseSummary(batchId, 'original summary');

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'buffered summary', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    expect(batches[0].response_summary).toBe('original summary');
  });

  it('skips stop events with empty last_assistant_message', () => {
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    backdateBatch(batchId, STALE_AGE_SECONDS);

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: '', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    expect(batches[0].response_summary).toBeNull();
  });

  it('recovers stops even when prompt counts already match (no divergence)', () => {
    // DB has exactly one batch matching the buffer's prompt — no new prompts
    // to replay. Before the stop-pass, no replay ran at all; now stops still
    // get applied idempotently.
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    backdateBatch(batchId, STALE_AGE_SECONDS);

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'late summary', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].id).toBe(batchId);
    expect(batches[0].response_summary).toBe('late summary');
  });

  // The freshness qualifier on the open-batch guard: a FRESH open batch may
  // be a live turn — the replayed stop must not stamp it. A STALE open batch
  // is the missed-Stop shape and is recoverable.
  it('skips a FRESH open batch — a possibly-live turn never takes a replayed summary', () => {
    handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    // No backdate: the batch was just created, well inside the freshness window.

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'should not land', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].ended_at).toBeNull();
    expect(batches[0].response_summary).toBeNull();
  });

  // Shared human-anchor resolution (resolveResponseSummaryTarget): a
  // trailing SYSTEM batch (a <task-notification> born after the human
  // prompt) wins getLatestBatch by prompt_number, but the replayed stop's
  // summary belongs to the human turn — same anchoring as the live path.
  it('replay stop lands on the latest HUMAN batch when a trailing system batch is the latest', () => {
    const { batchId: humanBatchId } = handleUserPrompt('s-stop', 'real question', { kind: 'initial' });
    backdateBatch(humanBatchId, STALE_AGE_SECONDS);
    const { batchId: systemBatchId } = handleUserPrompt('s-stop', '<task-notification>done</task-notification>', { origin: 'system' });
    backdateBatch(systemBatchId, STALE_AGE_SECONDS);

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'real question', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'anchored answer', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    const human = batches.find((b) => b.id === humanBatchId)!;
    const system = batches.find((b) => b.id === systemBatchId)!;
    expect(human.response_summary).toBe('anchored answer');
    expect(system.response_summary).toBeNull();
  });

  it('recovers onto a STALE open batch without closing it', () => {
    const { batchId } = handleUserPrompt('s-stop', 'hello', { kind: 'initial' });
    backdateBatch(batchId, STALE_AGE_SECONDS);

    const bufferPath = path.join(bufferDir, 's-stop.jsonl');
    fs.writeFileSync(bufferPath,
      JSON.stringify({ type: 'user_prompt', prompt: 'hello', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ type: 'stop', last_assistant_message: 'stale-open recovery', timestamp: new Date().toISOString() }) + '\n',
    );

    const reconciler = createReconciler({ bufferDirs: () => [bufferDir], logger: silentLogger, projectRoot: process.cwd() });
    reconciler.reconcileSession('s-stop');

    const batches = listBatchesBySession('s-stop', { scope: ALL_PROJECTS_SCOPE });
    expect(batches[0].response_summary).toBe('stale-open recovery');
    expect(batches[0].ended_at).toBeNull();
  });
});
