import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { TranscriptMiner } from '@myco/capture/transcript-miner.js';
import { handleUserPrompt } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { getDatabase } from '@myco/db/client.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

describe('TranscriptMiner.reconcileBatchKinds', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);

  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-test-'));
    transcriptPath = path.join(tmpDir, 'transcript.jsonl');
    seedSession({ id: 's-reconcile', agent: 'claude-code' });
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
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(nowSec(), firstId);

    const { batchId: secondId } = handleUserPrompt('s-reconcile', 'steering nudge', { kind: 'initial' });

    // Verify the starting state: both batches are kind='initial'
    const before = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
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

    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
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
    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
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

    // No events parsed → no reclassifications, no insertions
    expect(result.reclassified).toBe(0);
    expect(result.inserted).toBe(0);
  });

  // Regression: Claude Code's internal queue delivers mid-turn prompts to the
  // model without firing UserPromptSubmit, so the hook never sees them. The
  // Stop-time reconciler must recover those prompts from the transcript and
  // insert the missing batches.
  it('inserts missing batches for transcript prompts the hook dropped', () => {
    // Hook only captured the first prompt. The user queued a steering prompt
    // mid-turn plus sent two more regular prompts that Claude Code internally
    // queued without firing UserPromptSubmit.
    handleUserPrompt('s-reconcile', 'captured prompt', { kind: 'initial' });

    // Transcript contains all four prompts the model actually saw.
    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: 'captured prompt' } },
      // Mid-turn steering — no end_turn yet.
      { type: 'user', promptId: 'p2', message: { role: 'user', content: 'mid-turn steering' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
      { type: 'user', promptId: 'p3', message: { role: 'user', content: 'dropped regular prompt' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
      { type: 'user', promptId: 'p4', message: { role: 'user', content: 'another dropped one' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    const result = miner.reconcileBatchKinds('s-reconcile', {
      agent: 'claude-code',
      transcriptPath,
    });

    expect(result.inserted).toBe(3);
    expect(result.errors).toEqual([]);

    // listBatchesBySession orders by prompt_number; reconciliation must
    // renumber so recovered prompts land in transcript order, not MAX+1.
    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    expect(after).toHaveLength(4);
    expect(after.map((b) => b.user_prompt)).toEqual([
      'captured prompt',
      'mid-turn steering',
      'dropped regular prompt',
      'another dropped one',
    ]);
    expect(after.map((b) => b.prompt_number)).toEqual([1, 2, 3, 4]);
    // Steering child of first batch
    expect(after[0].kind).toBe('initial');
    expect(after[1].kind).toBe('steering');
    expect(after[1].parent_prompt_batch_id).toBe(after[0].id);
    expect(after[2].kind).toBe('initial');
    expect(after[2].parent_prompt_batch_id).toBeNull();
    expect(after[3].kind).toBe('initial');
  });

  // Reconciliation runs at every Stop, so it must be idempotent. Earlier
  // the matching strategy compared only `remaining[0]` by id — once a pass
  // inserted recovery rows with new high ids but early prompt_numbers, a
  // subsequent pass saw "no id-order match" and duplicated every recovered
  // prompt. The prefix-bucket strategy prevents that.
  it('is idempotent across repeated runs', () => {
    handleUserPrompt('s-reconcile', 'captured', { kind: 'initial' });
    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: 'captured' } },
      { type: 'user', promptId: 'p2', message: { role: 'user', content: 'missed steering' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    const first = miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });
    expect(first.inserted).toBe(1);

    const second = miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });
    expect(second.inserted).toBe(0);
    expect(second.reclassified).toBe(0);

    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    expect(after).toHaveLength(2);
    expect(after.map((b) => b.user_prompt)).toEqual(['captured', 'missed steering']);
  });

  // Reconcile runs once per Stop and the transcript grows monotonically.
  // The miner caches parsed events by path; appending turns to the transcript
  // must produce correct results without re-reading the bytes it already
  // parsed — this protects against an O(N²) regression on long sessions.
  it('uses cached events incrementally across repeat reconciles', () => {
    const miner = new TranscriptMiner();

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user', promptId: 'p1', message: { role: 'user', content: 'first' },
    }) + '\n' + JSON.stringify({
      type: 'assistant', message: { stop_reason: 'end_turn' },
    }) + '\n');

    const first = miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });
    expect(first.inserted).toBe(1);

    // Append a second turn. On the second reconcile only the appended bytes
    // should be parsed — but the result must still reflect the full session.
    fs.appendFileSync(transcriptPath, JSON.stringify({
      type: 'user', promptId: 'p2', message: { role: 'user', content: 'second' },
    }) + '\n' + JSON.stringify({
      type: 'assistant', message: { stop_reason: 'end_turn' },
    }) + '\n');

    const second = miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });
    expect(second.inserted).toBe(1);
    const batches = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    expect(batches.map((b) => b.user_prompt)).toEqual(['first', 'second']);
  });

  it('re-parses from scratch when the transcript shrinks (rotation)', () => {
    const miner = new TranscriptMiner();

    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user', promptId: 'p1', message: { role: 'user', content: 'pre-rotation' },
    }) + '\n');
    miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });

    // Simulate rotation — file replaced with a shorter, unrelated transcript.
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'user', promptId: 'q1', message: { role: 'user', content: 'post-rotation' },
    }) + '\n');

    const result = miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });
    // The walker saw exactly one prompt ("post-rotation"); the original
    // "pre-rotation" batch becomes a stranded DB row (reported in errors).
    const batches = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    const prompts = batches.map((b) => b.user_prompt);
    expect(prompts).toContain('pre-rotation');
    expect(prompts).toContain('post-rotation');
    expect(result.errors.some((e) => /stranded|no matching transcript prompt/.test(e))).toBe(true);
  });

  // Regression: Claude Code's slash-command dispatch writes a pair of user
  // entries sharing one promptId — the <command-message> XML envelope and the
  // expanded command body. UserPromptSubmit already captured `/<name> <args>`
  // via the hook path, so both transcript entries are redundant. Before the
  // claude-code.yaml drop rule, the walker emitted the XML-wrapped text as a
  // record, reconcile couldn't match its prefix to the hook-stored batch, and
  // a phantom second batch was inserted (bug showed two side-by-side prompts
  // in the UI — the raw `/simplify …` form and the XML form).
  it('does not duplicate a slash-command batch captured via the hook', () => {
    handleUserPrompt(
      's-reconcile',
      '/simplify Okay. We have a lot of releases on Main which were designed to test the new beta on the bun binary',
      { kind: 'initial' },
    );

    const events = [
      // Dispatch envelope — dropped by the manifest rule.
      {
        type: 'user',
        promptId: 'slash-1',
        message: {
          role: 'user',
          content:
            '<command-message>simplify</command-message>\n'
            + '<command-name>/simplify</command-name>\n'
            + '<command-args>Okay. We have a lot of releases on Main which were designed to test the new beta on the bun binary</command-args>',
        },
      },
      // Expanded command body — suppressed via shape-level promptId dedupe.
      {
        type: 'user',
        promptId: 'slash-1',
        message: { role: 'user', content: [{ type: 'text', text: '# Simplify: Code Review and Cleanup\n...' }] },
      },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    const result = miner.reconcileBatchKinds('s-reconcile', {
      agent: 'claude-code',
      transcriptPath,
    });

    expect(result.inserted).toBe(0);
    expect(result.errors).toEqual([]);

    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    expect(after).toHaveLength(1);
    expect(after[0].user_prompt).toContain('/simplify Okay.');
    expect(after[0].user_prompt).not.toContain('<command-message>');
  });

  it('inserts batches when the transcript has prompts and the DB has none', () => {
    // Cold reconcile — daemon missed every hook, the transcript is all we have.
    const events = [
      { type: 'user', promptId: 'p1', message: { role: 'user', content: 'first' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
      { type: 'user', promptId: 'p2', message: { role: 'user', content: 'second' } },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    const result = miner.reconcileBatchKinds('s-reconcile', {
      agent: 'claude-code',
      transcriptPath,
    });

    expect(result.inserted).toBe(2);
    expect(result.reclassified).toBe(0);
    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    expect(after.map((b) => b.user_prompt)).toEqual(['first', 'second']);
  });

  // K6 — renumber must preserve prompt_numbers of stranded batches.
  // A "stranded" batch is one whose transcript peer was suppressed by a
  // capture.rules `drop` decision (e.g. Claude Code <command-message>
  // slash-command dispatch envelope, where the live UserPromptSubmit hook
  // captured the raw `/name args` text upstream). The reconciler walks
  // post-drop transcript records, which DON'T include the dropped peer,
  // so the stranded batch must keep its existing prompt_number and the
  // walker must skip that slot when assigning new numbers.
  it('renumber: stranded batch retains its prompt_number; walker skips that slot', () => {
    // Live hook captures the slash-command BEFORE Claude Code wraps it.
    // This batch will be "stranded" because its transcript peer (the
    // <command-message> envelope) is dropped by the manifest rule.
    const { batchId: strandedId } = handleUserPrompt(
      's-reconcile',
      '/compound-engineering:ce-review review the diff',
      { kind: 'initial' },
    );
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET ended_at = ? WHERE id = ?`).run(nowSec(), strandedId);

    // Transcript contains the dispatch envelope (will be dropped) and a
    // following <task-notification> (passes through, classified system).
    const events = [
      // The dispatch envelope: user-role with content as a STRING starting
      // with <command-message> — dropped by manifest rule.
      {
        type: 'user',
        promptId: 'dispatch',
        message: {
          role: 'user',
          content:
            '<command-message>compound-engineering:ce-review</command-message>\n'
            + '<command-name>/compound-engineering:ce-review</command-name>\n'
            + '<command-args>review the diff</command-args>',
        },
      },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
      // System-injected <task-notification> — passes through, gets origin=system.
      {
        type: 'user',
        promptId: 'tn1',
        message: {
          role: 'user',
          content: [{ type: 'text', text: '<task-notification>\n<task-id>abc123</task-id>\n<status>completed</status>\n</task-notification>' }],
        },
      },
      { type: 'assistant', message: { stop_reason: 'end_turn' } },
    ];
    fs.writeFileSync(transcriptPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');

    const miner = new TranscriptMiner();
    miner.reconcileBatchKinds('s-reconcile', { agent: 'claude-code', transcriptPath });

    const after = listBatchesBySession('s-reconcile', { scope: ALL_PROJECTS_SCOPE });
    expect(after).toHaveLength(2);
    const stranded = after.find((b) => b.id === strandedId)!;
    const taskNotif = after.find((b) => b.id !== strandedId)!;

    // Stranded batch keeps its original prompt_number=1.
    expect(stranded.prompt_number).toBe(1);
    expect(stranded.user_prompt).toContain('/compound-engineering:ce-review');
    // Task-notification batch must NOT collide with prompt_number=1; it
    // gets the next available slot.
    expect(taskNotif.prompt_number).toBe(2);
    expect(taskNotif.user_prompt).toContain('<task-notification>');
    // Sanity: no two batches share a prompt_number.
    const numbers = after.map((b) => b.prompt_number).sort();
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});
