import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { TranscriptMiner } from '@myco/capture/transcript-miner.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const now = () => Math.floor(Date.now() / 1000);

describe('TranscriptMiner.reconcileBatchKinds', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');

    upsertSession({
      id: 's-reconcile',
      agent: 'claude-code',
      started_at: now(),
      created_at: now(),
      status: 'active',
    });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reclassifies second batch from initial to steering, sets parent_prompt_batch_id', () => {
    // Simulate hook race: both prompts arrive before the transcript is read,
    // so both are classified as kind='initial' by handleUserPrompt.
    const { batchId: firstId } = handleUserPrompt('s-reconcile', 'first prompt', { kind: 'initial' });

    // Force-close the first batch so the second initial doesn't reopen it
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(now(), firstId);

    const { batchId: secondId } = handleUserPrompt('s-reconcile', 'steering nudge', { kind: 'initial' });

    // Verify the starting state: both batches are kind='initial'
    const before = listBatchesBySession('s-reconcile');
    expect(before).toHaveLength(2);
    expect(before[0].kind).toBe('initial');
    expect(before[1].kind).toBe('initial');

    // Write a JSONL transcript with:
    //   user turn 1 → assistant stop_reason='tool_use' (turn NOT ended)
    //   user turn 2 → assistant stop_reason='end_turn' (turn ended)
    // This means turn 2 is a steering message (priorTurnEnded was false after p1)
    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } },
      { type: 'assistant', message: { stop_reason: 'tool_use' } },
      { type: 'user', promptId: 'p2', message: { role: 'user', content: [{ type: 'text', text: 'steering nudge' }] } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    const result = miner.reconcileBatchKinds('s-reconcile', {
      agent: 'claude-code',
      transcriptPath,
    });

    expect(result.reclassified).toBeGreaterThanOrEqual(1);

    const after = listBatchesBySession('s-reconcile');
    const first = after.find((b) => b.id === firstId)!;
    const second = after.find((b) => b.id === secondId)!;

    expect(first.kind).toBe('initial');
    expect(first.parent_prompt_batch_id).toBeNull();

    expect(second.kind).toBe('steering');
    expect(second.parent_prompt_batch_id).toBe(firstId);
  });

  it('reports no reclassifications when kinds already match transcript', () => {
    // First batch: initial (no parent)
    const { batchId: parentId } = handleUserPrompt('s-reconcile', 'first prompt', { kind: 'initial' });
    // Second batch: steering, correctly pointing at parent
    handleUserPrompt('s-reconcile', 'steering nudge', { kind: 'steering' });

    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: [{ type: 'text', text: 'first prompt' }] } },
      { type: 'assistant', message: { stop_reason: 'tool_use' } },
      { type: 'user', promptId: 'p2', message: { role: 'user', content: [{ type: 'text', text: 'steering nudge' }] } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    const result = miner.reconcileBatchKinds('s-reconcile', {
      agent: 'claude-code',
      transcriptPath,
    });

    expect(result.reclassified).toBe(0);
    const after = listBatchesBySession('s-reconcile');
    // The steering batch should still have the correct parent
    const steering = after.find((b) => b.kind === 'steering')!;
    expect(steering.parent_prompt_batch_id).toBe(parentId);
  });

  it('returns empty result for missing transcript path', () => {
    handleUserPrompt('s-reconcile', 'only prompt', { kind: 'initial' });

    const miner = new TranscriptMiner();
    const result = miner.reconcileBatchKinds('s-reconcile', {
      agent: 'claude-code',
      transcriptPath: '/nonexistent/path.jsonl',
    });

    // No events parsed → no reclassifications (length mismatch logged as error)
    expect(result.reclassified).toBe(0);
  });
});
