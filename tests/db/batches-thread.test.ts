/**
 * Sub-agent thread batch identity: thread-scoped insert, dedupe, queries,
 * and latest-batch guard.
 *
 * A "thread batch" is a `prompt_batches` row with a non-null `thread_id`,
 * mined by the transcript miner (Task 4) from a sub-agent's own turn
 * sequence. These tests pin that thread rows never leak into main-thread
 * consumers (getLatestBatch, populateBatchResponses default scope) and that
 * sibling threads with identical (origin, ordinal, text) each get their own
 * row instead of deduping against each other or the main thread.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import {
  insertBatchStateless,
  listBatchesBySession,
  listBatchesBySessionThread,
  getLatestBatch,
  populateBatchResponses,
  PROMPT_BATCH_ORIGIN,
} from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

describe('insertBatchStateless — thread_id / thread_label columns', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('writes thread_id and thread_label onto the row', () => {
    const { row } = insertBatchStateless({
      session_id: 's1',
      user_prompt: 'reviewer task',
      ordinal: 0,
      created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH,
      thread_id: 'task_6_reviewer',
      thread_label: 'reviewer',
    });
    expect(row.thread_id).toBe('task_6_reviewer');
    expect(row.thread_label).toBe('reviewer');
  });

  it('omitting thread_id / thread_label leaves both columns null (default, main-thread behavior)', () => {
    const { row } = insertBatchStateless({
      session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec(),
    });
    expect(row.thread_id).toBeNull();
    expect(row.thread_label).toBeNull();
  });

  it('two sibling-thread inserts with identical (origin, ordinal, text) BOTH persist', () => {
    const a = insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer task', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    const b = insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer task', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_7_reviewer',
    });
    expect(a.created).toBe(true);
    expect(b.created).toBe(true);
    expect(a.row.id).not.toBe(b.row.id);
    expect(a.row.content_hash).not.toBe(b.row.content_hash);
  });

  it('re-insert of the same thread row dedupes (created: false)', () => {
    const first = insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer task', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    const second = insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer task', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
  });

  it('a thread row never collides with an identical main-thread row', () => {
    const main = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });
    const thread = insertBatchStateless({
      session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    expect(main.created).toBe(true);
    expect(thread.created).toBe(true);
    expect(main.row.content_hash).not.toBe(thread.row.content_hash);
  });
});

describe('listBatchesBySessionThread', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('returns only rows for the given (session, thread) pair', () => {
    insertBatchStateless({ session_id: 's1', user_prompt: 'main turn', ordinal: 0, created_at: nowSec() });
    insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer turn 1', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer turn 2', ordinal: 1, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    insertBatchStateless({
      session_id: 's1', user_prompt: 'planner turn', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_7_planner',
    });

    const reviewerRows = listBatchesBySessionThread('s1', 'task_6_reviewer');
    expect(reviewerRows.map((r) => r.user_prompt)).toEqual(['reviewer turn 1', 'reviewer turn 2']);
    expect(reviewerRows.every((r) => r.thread_id === 'task_6_reviewer')).toBe(true);

    const plannerRows = listBatchesBySessionThread('s1', 'task_7_planner');
    expect(plannerRows.map((r) => r.user_prompt)).toEqual(['planner turn']);
  });

  it('does not affect listBatchesBySession, which still returns every row regardless of thread', () => {
    insertBatchStateless({ session_id: 's1', user_prompt: 'main turn', ordinal: 0, created_at: nowSec() });
    insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer turn', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    const all = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(all.map((r) => r.user_prompt).sort()).toEqual(['main turn', 'reviewer turn']);
  });
});

describe('getLatestBatch — thread_id IS NULL guard', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('still returns the main-thread batch even when a thread batch has the highest prompt_number', () => {
    const mainBatch = insertBatchStateless({ session_id: 's1', user_prompt: 'main turn', ordinal: 0, created_at: nowSec() });
    // The thread insert bumps prompt_number past the main batch's.
    insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer turn', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });

    const latest = getLatestBatch('s1');
    expect(latest?.id).toBe(mainBatch.row.id);
    expect(latest?.thread_id).toBeNull();
  });

  it('returns null when the session only has thread batches (no main-thread row)', () => {
    insertBatchStateless({
      session_id: 's1', user_prompt: 'reviewer turn', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    expect(getLatestBatch('s1')).toBeNull();
  });
});

describe('populateBatchResponses — threadId scoping', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('default (no threadId) call populates only main-thread rows, exactly like today', () => {
    const main = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy the app', ordinal: 0, created_at: nowSec() });
    const thread = insertBatchStateless({
      session_id: 's1', user_prompt: 'deploy the app', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });

    populateBatchResponses('s1', [{ prompt: 'deploy the app', response: 'done' }]);

    const rows = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    const mainRow = rows.find((r) => r.id === main.row.id)!;
    const threadRow = rows.find((r) => r.id === thread.row.id)!;
    expect(mainRow.response_summary).toBe('done');
    expect(threadRow.response_summary).toBeNull();
  });

  it('a threadId-scoped call populates only that thread\'s rows, never the main thread or a sibling thread', () => {
    const main = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy the app', ordinal: 0, created_at: nowSec() });
    const thread = insertBatchStateless({
      session_id: 's1', user_prompt: 'deploy the app', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_6_reviewer',
    });
    const sibling = insertBatchStateless({
      session_id: 's1', user_prompt: 'deploy the app', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.AGENT_DISPATCH, thread_id: 'task_7_planner',
    });

    populateBatchResponses('s1', [{ prompt: 'deploy the app', response: 'thread response' }], 'task_6_reviewer');

    const rows = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    expect(rows.find((r) => r.id === thread.row.id)!.response_summary).toBe('thread response');
    expect(rows.find((r) => r.id === main.row.id)!.response_summary).toBeNull();
    expect(rows.find((r) => r.id === sibling.row.id)!.response_summary).toBeNull();
  });

  it('Phase-2 human-anchoring inside a thread never rolls a response onto a main-thread human batch', () => {
    // Main-thread human batch that must stay untouched by the thread pass.
    const mainHuman = insertBatchStateless({ session_id: 's1', user_prompt: 'main human prompt', ordinal: 0, created_at: nowSec() });
    // Thread's own human-origin anchor plus a system batch nested under it.
    const threadHuman = insertBatchStateless({
      session_id: 's1', user_prompt: 'thread human prompt', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.HUMAN, thread_id: 'task_6_reviewer',
    });
    const threadSystem = insertBatchStateless({
      session_id: 's1', user_prompt: 'thread system prompt', ordinal: 0, created_at: nowSec(),
      origin: PROMPT_BATCH_ORIGIN.SYSTEM, thread_id: 'task_6_reviewer',
    });

    populateBatchResponses(
      's1',
      [
        { prompt: 'thread human prompt', response: 'human-anchored answer part 1' },
        { prompt: 'thread system prompt', response: 'system interleaved answer' },
      ],
      'task_6_reviewer',
    );

    const rows = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE });
    const mainHumanRow = rows.find((r) => r.id === mainHuman.row.id)!;
    const threadHumanRow = rows.find((r) => r.id === threadHuman.row.id)!;
    const threadSystemRow = rows.find((r) => r.id === threadSystem.row.id)!;

    expect(mainHumanRow.response_summary).toBeNull();
    expect(threadHumanRow.response_summary).toBe(
      'human-anchored answer part 1\n\nsystem interleaved answer',
    );
    expect(threadSystemRow.response_summary).toBeNull();
  });
});
