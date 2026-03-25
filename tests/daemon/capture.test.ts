/**
 * Tests for the daemon capture flow — PGlite batch tracking.
 *
 * Covers:
 * - Handler-level integration (full session lifecycle)
 * - Stateless DB functions (closeOpenBatches, insertBatchStateless, insertActivityWithBatch)
 * - Daemon-restart resilience (sequential prompt numbers across restarts)
 * - New event type handlers (tool failure, subagent, stop failure, task, compact)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import {
  insertBatch,
  insertBatchStateless,
  closeOpenBatches,
  getUnprocessedBatches,
  listBatchesBySession,
} from '@myco/db/queries/batches.js';
import {
  insertActivityWithBatch,
  listActivities,
  countActivities,
} from '@myco/db/queries/activities.js';
import {
  handleUserPrompt,
  handleToolUse,
  handleSessionStop,
  handleToolFailure,
  handleSubagentStart,
  handleSubagentStop,
  handleStopFailure,
  handleTaskCompleted,
  handleCompact,
} from '@myco/daemon/main.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

describe('daemon capture flow', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  it('tracks batches and activities through a full session lifecycle', async () => {
    const sessionId = 'test-session-capture-001';
    const now = epochNow();

    // --- Register session ---
    await upsertSession({
      id: sessionId,
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });

    // --- UserPromptSubmit #1 ---
    const result1 = await handleUserPrompt(sessionId, 'Write a hello world program');
    expect(result1.batchId).toBeGreaterThan(0);
    expect(result1.promptNumber).toBe(1);

    // --- PostToolUse × 3 ---
    await handleToolUse(sessionId, 'Write', { file_path: '/tmp/hello.ts' }, 'File written');
    await handleToolUse(sessionId, 'Bash', { command: 'npm run build' }, 'Build succeeded');
    await handleToolUse(sessionId, 'Read', { file_path: '/tmp/hello.ts' }, 'export function...');

    // --- UserPromptSubmit #2 (closes batch 1, opens batch 2) ---
    const result2 = await handleUserPrompt(sessionId, 'Now add tests');
    expect(result2.batchId).toBeGreaterThan(result1.batchId);
    expect(result2.promptNumber).toBe(2);

    // --- PostToolUse × 1 ---
    await handleToolUse(sessionId, 'Write', { file_path: '/tmp/hello.test.ts' }, 'Test file written');

    // --- Stop ---
    await handleSessionStop(sessionId);

    // --- Verify session ---
    const session = await getSession(sessionId);
    expect(session).not.toBeNull();
    expect(session!.status).toBe('completed');
    expect(session!.ended_at).toBeGreaterThan(0);

    // --- Verify batches ---
    // Both batches should be closed (status = 'completed')
    // getUnprocessedBatches returns processed=0 items — both are unprocessed (no Phase 2 yet)
    const batches = await getUnprocessedBatches();
    expect(batches.length).toBe(2);

    const b1 = batches.find((b) => b.id === result1.batchId);
    const b2 = batches.find((b) => b.id === result2.batchId);

    expect(b1).toBeDefined();
    expect(b1!.status).toBe('completed');
    expect(b1!.activity_count).toBe(3);
    expect(b1!.user_prompt).toBe('Write a hello world program');
    expect(b1!.prompt_number).toBe(1);

    expect(b2).toBeDefined();
    expect(b2!.status).toBe('completed');
    expect(b2!.activity_count).toBe(1);
    expect(b2!.user_prompt).toBe('Now add tests');
    expect(b2!.prompt_number).toBe(2);

    // --- Verify activities ---
    const activities = await listActivities({ session_id: sessionId });
    expect(activities.length).toBe(4);

    // First 3 activities belong to batch 1
    expect(activities[0].prompt_batch_id).toBe(result1.batchId);
    expect(activities[0].tool_name).toBe('Write');
    expect(activities[0].file_path).toBe('/tmp/hello.ts');

    expect(activities[1].prompt_batch_id).toBe(result1.batchId);
    expect(activities[1].tool_name).toBe('Bash');

    expect(activities[2].prompt_batch_id).toBe(result1.batchId);
    expect(activities[2].tool_name).toBe('Read');

    // Last activity belongs to batch 2
    expect(activities[3].prompt_batch_id).toBe(result2.batchId);
    expect(activities[3].tool_name).toBe('Write');
    expect(activities[3].file_path).toBe('/tmp/hello.test.ts');

    // --- Verify activity count ---
    const totalActivities = await countActivities(sessionId);
    expect(totalActivities).toBe(4);
  });

  it('handles tool use before any prompt (no batch)', async () => {
    const sessionId = 'test-session-no-batch';
    const now = epochNow();

    await upsertSession({
      id: sessionId,
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });

    // Tool use without a prior user prompt — should still record activity
    await handleToolUse(sessionId, 'Read', { file_path: '/tmp/file.ts' }, 'contents');

    const activities = await listActivities({ session_id: sessionId });
    expect(activities.length).toBe(1);
    expect(activities[0].prompt_batch_id).toBeNull();
    expect(activities[0].tool_name).toBe('Read');
  });

  it('handles session stop with no open batch', async () => {
    const sessionId = 'test-session-empty';
    const now = epochNow();

    await upsertSession({
      id: sessionId,
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });

    // Stop with no events — should close session cleanly
    await handleSessionStop(sessionId);

    const session = await getSession(sessionId);
    expect(session!.status).toBe('completed');
  });

  it('truncates tool input to limit', async () => {
    const sessionId = 'test-session-truncate';
    const now = epochNow();

    await upsertSession({
      id: sessionId,
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });

    // Send a very large tool input
    const largeInput = { file_path: '/tmp/file.ts', content: 'x'.repeat(10000) };
    await handleToolUse(sessionId, 'Write', largeInput, undefined);

    const activities = await listActivities({ session_id: sessionId });
    expect(activities.length).toBe(1);
    // tool_input should be truncated
    expect(activities[0].tool_input!.length).toBeLessThanOrEqual(4000);
  });

  it('increments prompt number across multiple batches', async () => {
    const sessionId = 'test-session-prompts';
    const now = epochNow();

    await upsertSession({
      id: sessionId,
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });

    await handleUserPrompt(sessionId, 'first');
    await handleUserPrompt(sessionId, 'second');
    await handleUserPrompt(sessionId, 'third');

    const batches = await getUnprocessedBatches();
    const sessionBatches = batches
      .filter((b) => b.session_id === sessionId)
      .sort((a, b) => a.id - b.id);

    expect(sessionBatches.length).toBe(3);
    expect(sessionBatches[0].prompt_number).toBe(1);
    expect(sessionBatches[1].prompt_number).toBe(2);
    expect(sessionBatches[2].prompt_number).toBe(3);

    // First two batches should be closed (by the subsequent user_prompt)
    expect(sessionBatches[0].status).toBe('completed');
    expect(sessionBatches[1].status).toBe('completed');
    // Third batch is still active (no subsequent prompt or stop)
    expect(sessionBatches[2].status).toBe('active');
  });
});

// ---------------------------------------------------------------------------
// QA-2: Stateless DB function tests
// ---------------------------------------------------------------------------

describe('stateless DB functions', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  // --- closeOpenBatches ---

  describe('closeOpenBatches', () => {
    it('closes all open batches for a session', async () => {
      const sessionId = 'test-close-open-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // Insert 3 batches — 2 open (no ended_at), 1 already closed
      await insertBatch({ session_id: sessionId, prompt_number: 1, user_prompt: 'first', started_at: now, created_at: now });
      await insertBatch({ session_id: sessionId, prompt_number: 2, user_prompt: 'second', started_at: now, created_at: now });
      await insertBatch({ session_id: sessionId, prompt_number: 3, user_prompt: 'third', started_at: now, ended_at: now, status: 'completed', created_at: now });

      const closed = await closeOpenBatches(sessionId, now + 1);
      expect(closed).toBe(2);

      // All batches should now be completed
      const batches = await listBatchesBySession(sessionId);
      expect(batches.length).toBe(3);
      for (const b of batches) {
        expect(b.status).toBe('completed');
        expect(b.ended_at).not.toBeNull();
      }
    });

    it('returns 0 when no open batches exist', async () => {
      const sessionId = 'test-close-open-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // Insert a batch that's already closed
      await insertBatch({ session_id: sessionId, prompt_number: 1, user_prompt: 'done', started_at: now, ended_at: now, status: 'completed', created_at: now });

      const closed = await closeOpenBatches(sessionId, now + 1);
      expect(closed).toBe(0);
    });

    it('does not affect batches from other sessions', async () => {
      const session1 = 'test-close-open-s1';
      const session2 = 'test-close-open-s2';
      const now = epochNow();

      await upsertSession({ id: session1, agent: 'claude-code', started_at: now, created_at: now });
      await upsertSession({ id: session2, agent: 'claude-code', started_at: now, created_at: now });

      await insertBatch({ session_id: session1, prompt_number: 1, user_prompt: 's1', started_at: now, created_at: now });
      await insertBatch({ session_id: session2, prompt_number: 1, user_prompt: 's2', started_at: now, created_at: now });

      // Close only session1's batches
      await closeOpenBatches(session1, now + 1);

      const s1Batches = await listBatchesBySession(session1);
      expect(s1Batches[0].status).toBe('completed');

      const s2Batches = await listBatchesBySession(session2);
      expect(s2Batches[0].status).toBe('active');
    });
  });

  // --- insertBatchStateless ---

  describe('insertBatchStateless', () => {
    it('auto-increments prompt_number from 1', async () => {
      const sessionId = 'test-stateless-batch-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      const b1 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'first', created_at: now });
      const b2 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'second', created_at: now });
      const b3 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'third', created_at: now });

      expect(b1.prompt_number).toBe(1);
      expect(b2.prompt_number).toBe(2);
      expect(b3.prompt_number).toBe(3);
    });

    it('continues numbering after existing batches', async () => {
      const sessionId = 'test-stateless-batch-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // Insert two batches with explicit prompt_numbers (simulating pre-restart state)
      await insertBatch({ session_id: sessionId, prompt_number: 1, user_prompt: 'old-1', started_at: now, ended_at: now, status: 'completed', created_at: now });
      await insertBatch({ session_id: sessionId, prompt_number: 2, user_prompt: 'old-2', started_at: now, ended_at: now, status: 'completed', created_at: now });

      // Stateless insert should pick up prompt_number = 3
      const b3 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'new-after-restart', created_at: now });
      expect(b3.prompt_number).toBe(3);
    });

    it('isolates prompt_numbers across sessions', async () => {
      const session1 = 'test-stateless-batch-s1';
      const session2 = 'test-stateless-batch-s2';
      const now = epochNow();

      await upsertSession({ id: session1, agent: 'claude-code', started_at: now, created_at: now });
      await upsertSession({ id: session2, agent: 'claude-code', started_at: now, created_at: now });

      await insertBatchStateless({ session_id: session1, user_prompt: 's1-first', created_at: now });
      await insertBatchStateless({ session_id: session1, user_prompt: 's1-second', created_at: now });
      const s2b1 = await insertBatchStateless({ session_id: session2, user_prompt: 's2-first', created_at: now });

      // Session 2 should start at 1, not 3
      expect(s2b1.prompt_number).toBe(1);
    });

    it('sets default status to active', async () => {
      const sessionId = 'test-stateless-batch-003';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      const batch = await insertBatchStateless({ session_id: sessionId, user_prompt: 'test', created_at: now });
      expect(batch.status).toBe('active');
      expect(batch.ended_at).toBeNull();
      expect(batch.activity_count).toBe(0);
    });
  });

  // --- insertActivityWithBatch ---

  describe('insertActivityWithBatch', () => {
    it('links activity to the open batch automatically', async () => {
      const sessionId = 'test-activity-batch-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // Create an open batch
      const batch = await insertBatchStateless({ session_id: sessionId, user_prompt: 'do something', created_at: now });

      // Insert activity — should auto-link to the open batch
      const activity = await insertActivityWithBatch({
        session_id: sessionId,
        tool_name: 'Write',
        tool_input: '{"file_path":"/tmp/test.ts"}',
        file_path: '/tmp/test.ts',
        timestamp: now,
        created_at: now,
      });

      expect(activity.prompt_batch_id).toBe(batch.id);
      expect(activity.tool_name).toBe('Write');
      expect(activity.file_path).toBe('/tmp/test.ts');
    });

    it('sets prompt_batch_id to NULL when no open batch exists', async () => {
      const sessionId = 'test-activity-batch-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // No batch created — activity should have NULL batch
      const activity = await insertActivityWithBatch({
        session_id: sessionId,
        tool_name: 'Read',
        timestamp: now,
        created_at: now,
      });

      expect(activity.prompt_batch_id).toBeNull();
    });

    it('links to the most recent open batch when multiple exist', async () => {
      const sessionId = 'test-activity-batch-003';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // Create two open batches
      await insertBatchStateless({ session_id: sessionId, user_prompt: 'first', created_at: now });
      const batch2 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'second', created_at: now });

      // Activity should link to the most recent (highest id) open batch
      const activity = await insertActivityWithBatch({
        session_id: sessionId,
        tool_name: 'Bash',
        timestamp: now,
        created_at: now,
      });

      expect(activity.prompt_batch_id).toBe(batch2.id);
    });

    it('does not link to closed batches', async () => {
      const sessionId = 'test-activity-batch-004';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      // Create a batch and close it
      await insertBatchStateless({ session_id: sessionId, user_prompt: 'closed', created_at: now });
      await closeOpenBatches(sessionId, now + 1);

      // Activity should have NULL batch since only closed batches exist
      const activity = await insertActivityWithBatch({
        session_id: sessionId,
        tool_name: 'Read',
        timestamp: now + 2,
        created_at: now + 2,
      });

      expect(activity.prompt_batch_id).toBeNull();
    });

    it('records failure fields correctly', async () => {
      const sessionId = 'test-activity-batch-005';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });
      await insertBatchStateless({ session_id: sessionId, user_prompt: 'test', created_at: now });

      const activity = await insertActivityWithBatch({
        session_id: sessionId,
        tool_name: 'Bash',
        tool_input: '{"command":"rm -rf /"}',
        tool_output_summary: 'Permission denied',
        success: 0,
        error_message: 'EPERM: operation not permitted',
        timestamp: now,
        created_at: now,
      });

      expect(activity.success).toBe(0);
      expect(activity.error_message).toBe('EPERM: operation not permitted');
      expect(activity.tool_output_summary).toBe('Permission denied');
    });
  });
});

// ---------------------------------------------------------------------------
// QA-3: Daemon-restart resilience tests
// ---------------------------------------------------------------------------

describe('daemon-restart resilience', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  it('prompt numbers stay sequential across simulated restart', async () => {
    const sessionId = 'test-restart-prompts-001';
    const now = epochNow();

    await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    // Pre-restart: 2 batches
    const b1 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'pre-1', created_at: now });
    const b2 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'pre-2', created_at: now });
    expect(b1.prompt_number).toBe(1);
    expect(b2.prompt_number).toBe(2);

    // Simulate daemon stop — close all open batches
    await closeOpenBatches(sessionId, now + 1);

    // ---- SIMULATED DAEMON RESTART ----
    // No in-memory state carried over. The DB is the only source of truth.

    // Post-restart: new batches should continue from 3
    const b3 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'post-1', created_at: now + 2 });
    const b4 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'post-2', created_at: now + 3 });
    expect(b3.prompt_number).toBe(3);
    expect(b4.prompt_number).toBe(4);

    // Verify all 4 batches exist with correct sequential numbering
    const batches = await listBatchesBySession(sessionId);
    expect(batches.length).toBe(4);
    expect(batches.map((b) => b.prompt_number)).toEqual([1, 2, 3, 4]);
  });

  it('activities link to correct batch after restart', async () => {
    const sessionId = 'test-restart-activities-001';
    const now = epochNow();

    await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    // Pre-restart: open a batch, add an activity
    const preBatch = await insertBatchStateless({ session_id: sessionId, user_prompt: 'pre', created_at: now });
    const preActivity = await insertActivityWithBatch({
      session_id: sessionId,
      tool_name: 'Write',
      file_path: '/tmp/pre.ts',
      timestamp: now,
      created_at: now,
    });
    expect(preActivity.prompt_batch_id).toBe(preBatch.id);

    // Simulate stop + restart
    await closeOpenBatches(sessionId, now + 1);

    // Post-restart: new batch, new activity
    const postBatch = await insertBatchStateless({ session_id: sessionId, user_prompt: 'post', created_at: now + 2 });
    const postActivity = await insertActivityWithBatch({
      session_id: sessionId,
      tool_name: 'Bash',
      timestamp: now + 3,
      created_at: now + 3,
    });
    expect(postActivity.prompt_batch_id).toBe(postBatch.id);

    // Verify all activities have correct batch linkage
    const activities = await listActivities({ session_id: sessionId });
    expect(activities.length).toBe(2);
    expect(activities[0].prompt_batch_id).toBe(preBatch.id);
    expect(activities[1].prompt_batch_id).toBe(postBatch.id);
  });

  it('activity before any post-restart batch gets NULL batch', async () => {
    const sessionId = 'test-restart-orphan-001';
    const now = epochNow();

    await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    // Pre-restart: open batch, close it
    await insertBatchStateless({ session_id: sessionId, user_prompt: 'pre', created_at: now });
    await closeOpenBatches(sessionId, now + 1);

    // ---- RESTART ----

    // Tool use before the first post-restart prompt — no open batch
    const orphanActivity = await insertActivityWithBatch({
      session_id: sessionId,
      tool_name: 'Read',
      file_path: '/tmp/context.ts',
      timestamp: now + 2,
      created_at: now + 2,
    });
    expect(orphanActivity.prompt_batch_id).toBeNull();

    // Now open a new batch — subsequent activities link correctly
    const postBatch = await insertBatchStateless({ session_id: sessionId, user_prompt: 'post', created_at: now + 3 });
    const linkedActivity = await insertActivityWithBatch({
      session_id: sessionId,
      tool_name: 'Write',
      timestamp: now + 4,
      created_at: now + 4,
    });
    expect(linkedActivity.prompt_batch_id).toBe(postBatch.id);
  });

  it('multiple restarts maintain correct numbering', async () => {
    const sessionId = 'test-multi-restart-001';
    const now = epochNow();

    await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

    // Restart 1: 2 batches
    const r1b1 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'r1-1', created_at: now });
    const r1b2 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'r1-2', created_at: now + 1 });
    await closeOpenBatches(sessionId, now + 2);

    // Restart 2: 1 batch
    const r2b1 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'r2-1', created_at: now + 3 });
    await closeOpenBatches(sessionId, now + 4);

    // Restart 3: 2 batches
    const r3b1 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'r3-1', created_at: now + 5 });
    const r3b2 = await insertBatchStateless({ session_id: sessionId, user_prompt: 'r3-2', created_at: now + 6 });

    expect(r1b1.prompt_number).toBe(1);
    expect(r1b2.prompt_number).toBe(2);
    expect(r2b1.prompt_number).toBe(3);
    expect(r3b1.prompt_number).toBe(4);
    expect(r3b2.prompt_number).toBe(5);

    // All 5 batches, sequential
    const batches = await listBatchesBySession(sessionId);
    expect(batches.length).toBe(5);
    expect(batches.map((b) => b.prompt_number)).toEqual([1, 2, 3, 4, 5]);
  });
});

// ---------------------------------------------------------------------------
// QA-4: New event type handler tests
// ---------------------------------------------------------------------------

describe('new event type handlers', () => {
  beforeAll(async () => { await setupTestDb(); });
  afterAll(async () => { await teardownTestDb(); });
  beforeEach(async () => { await cleanTestDb(); });

  // --- handleToolFailure ---

  describe('handleToolFailure', () => {
    it('records a failed tool use with success=0 and error_message', async () => {
      const sessionId = 'test-tool-failure-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleToolFailure(
        sessionId,
        'Bash',
        { command: 'rm -rf /' },
        'Permission denied',
        false,
      );

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('Bash');
      expect(activities[0].success).toBe(0);
      expect(activities[0].error_message).toBe('Permission denied');
      expect(activities[0].tool_output_summary).toBe('Permission denied');
    });

    it('records interrupted tool with "interrupted" error_message', async () => {
      const sessionId = 'test-tool-failure-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleToolFailure(sessionId, 'Bash', { command: 'sleep 999' }, undefined, true);

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].success).toBe(0);
      expect(activities[0].error_message).toBe('interrupted');
    });

    it('extracts file_path from tool input', async () => {
      const sessionId = 'test-tool-failure-003';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleToolFailure(sessionId, 'Write', { file_path: '/tmp/readonly.ts' }, 'EACCES', false);

      const activities = await listActivities({ session_id: sessionId });
      expect(activities[0].file_path).toBe('/tmp/readonly.ts');
    });
  });

  // --- handleSubagentStart / handleSubagentStop ---

  describe('handleSubagentStart', () => {
    it('records subagent spawn as activity', async () => {
      const sessionId = 'test-subagent-start-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleSubagentStart(sessionId, 'agent-123', 'researcher');

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('subagent_start');
      expect(activities[0].tool_input).toContain('agent-123');
      expect(activities[0].tool_input).toContain('researcher');
      expect(activities[0].prompt_batch_id).toBeNull();
    });
  });

  describe('handleSubagentStop', () => {
    it('records subagent completion with last message', async () => {
      const sessionId = 'test-subagent-stop-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleSubagentStop(sessionId, 'agent-123', 'researcher', 'Found 3 relevant files');

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('subagent_stop');
      expect(activities[0].tool_output_summary).toBe('Found 3 relevant files');
    });

    it('handles missing last assistant message', async () => {
      const sessionId = 'test-subagent-stop-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleSubagentStop(sessionId, 'agent-456', undefined, undefined);

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_output_summary).toBeNull();
    });
  });

  // --- handleStopFailure ---

  describe('handleStopFailure', () => {
    it('records stop failure with error and details', async () => {
      const sessionId = 'test-stop-failure-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleStopFailure(sessionId, 'Transcript parse failed', 'JSONL line 42 invalid');

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('stop_failure');
      expect(activities[0].success).toBe(0);
      expect(activities[0].error_message).toBe('Transcript parse failed');
      expect(activities[0].tool_output_summary).toBe('JSONL line 42 invalid');
    });

    it('handles missing error details', async () => {
      const sessionId = 'test-stop-failure-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleStopFailure(sessionId, 'Unknown error', undefined);

      const activities = await listActivities({ session_id: sessionId });
      expect(activities[0].error_message).toBe('Unknown error');
      expect(activities[0].tool_output_summary).toBeNull();
    });
  });

  // --- handleTaskCompleted ---

  describe('handleTaskCompleted', () => {
    it('records task completion as activity', async () => {
      const sessionId = 'test-task-completed-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleTaskCompleted(sessionId, 'task-42', 'Fix login bug', 'Users cannot log in with SSO');

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('task_completed');
      expect(activities[0].tool_input).toContain('task-42');
      expect(activities[0].tool_input).toContain('Fix login bug');
      expect(activities[0].tool_output_summary).toBe('Fix login bug');
    });
  });

  // --- handleCompact ---

  describe('handleCompact', () => {
    it('records pre-compact event', async () => {
      const sessionId = 'test-compact-001';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleCompact(sessionId, 'pre', 'auto', undefined);

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('pre_compact');
      expect(activities[0].tool_input).toContain('auto');
      expect(activities[0].tool_output_summary).toBeNull();
    });

    it('records post-compact event with summary', async () => {
      const sessionId = 'test-compact-002';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleCompact(sessionId, 'post', 'manual', 'Compacted 15 turns to 3');

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(1);
      expect(activities[0].tool_name).toBe('post_compact');
      expect(activities[0].tool_output_summary).toBe('Compacted 15 turns to 3');
    });

    it('handles pre and post compact in sequence', async () => {
      const sessionId = 'test-compact-003';
      const now = epochNow();

      await upsertSession({ id: sessionId, agent: 'claude-code', started_at: now, created_at: now });

      await handleCompact(sessionId, 'pre', 'auto', undefined);
      await handleCompact(sessionId, 'post', 'auto', 'Reduced context by 60%');

      const activities = await listActivities({ session_id: sessionId });
      expect(activities.length).toBe(2);
      expect(activities[0].tool_name).toBe('pre_compact');
      expect(activities[1].tool_name).toBe('post_compact');
      expect(activities[1].tool_output_summary).toBe('Reduced context by 60%');
    });
  });
});
