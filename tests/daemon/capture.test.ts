/**
 * Tests for the daemon capture flow — PGlite batch tracking.
 *
 * Simulates: register session → UserPromptSubmit → PostToolUse × 3 →
 * UserPromptSubmit → PostToolUse → Stop
 *
 * Verifies: 1 session row, 2 batch rows, 4 activity rows, session is completed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase } from '@myco/db/client.js';
import { createSchema } from '@myco/db/schema.js';
import { upsertSession, getSession } from '@myco/db/queries/sessions.js';
import { getUnprocessedBatches } from '@myco/db/queries/batches.js';
import { listActivities, countActivities } from '@myco/db/queries/activities.js';
import {
  handleUserPrompt,
  handleToolUse,
  handleSessionStop,
  type BatchStateMap,
} from '@myco/daemon/main.js';

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

describe('daemon capture flow', () => {
  let batchState: BatchStateMap;

  beforeEach(async () => {
    const db = await initDatabase(); // in-memory
    await createSchema(db);
    batchState = new Map();
  });

  afterEach(async () => {
    await closeDatabase();
  });

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
    const batch1Id = await handleUserPrompt(sessionId, 'Write a hello world program', batchState);
    expect(batch1Id).toBeGreaterThan(0);

    // --- PostToolUse × 3 ---
    await handleToolUse(sessionId, 'Write', { file_path: '/tmp/hello.ts' }, 'File written', batchState);
    await handleToolUse(sessionId, 'Bash', { command: 'npm run build' }, 'Build succeeded', batchState);
    await handleToolUse(sessionId, 'Read', { file_path: '/tmp/hello.ts' }, 'export function...', batchState);

    // --- UserPromptSubmit #2 (closes batch 1, opens batch 2) ---
    const batch2Id = await handleUserPrompt(sessionId, 'Now add tests', batchState);
    expect(batch2Id).toBeGreaterThan(batch1Id);

    // --- PostToolUse × 1 ---
    await handleToolUse(sessionId, 'Write', { file_path: '/tmp/hello.test.ts' }, 'Test file written', batchState);

    // --- Stop ---
    await handleSessionStop(sessionId, batchState);

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

    const b1 = batches.find((b) => b.id === batch1Id);
    const b2 = batches.find((b) => b.id === batch2Id);

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
    expect(activities[0].prompt_batch_id).toBe(batch1Id);
    expect(activities[0].tool_name).toBe('Write');
    expect(activities[0].file_path).toBe('/tmp/hello.ts');

    expect(activities[1].prompt_batch_id).toBe(batch1Id);
    expect(activities[1].tool_name).toBe('Bash');

    expect(activities[2].prompt_batch_id).toBe(batch1Id);
    expect(activities[2].tool_name).toBe('Read');

    // Last activity belongs to batch 2
    expect(activities[3].prompt_batch_id).toBe(batch2Id);
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
    await handleToolUse(sessionId, 'Read', { file_path: '/tmp/file.ts' }, 'contents', batchState);

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
    await handleSessionStop(sessionId, batchState);

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
    await handleToolUse(sessionId, 'Write', largeInput, undefined, batchState);

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

    await handleUserPrompt(sessionId, 'first', batchState);
    await handleUserPrompt(sessionId, 'second', batchState);
    await handleUserPrompt(sessionId, 'third', batchState);

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
