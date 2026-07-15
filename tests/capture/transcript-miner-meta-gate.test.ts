/**
 * RC-E — transcript-level drop gate + transcript_meta rule parity.
 *
 * 1. A transcript whose session_meta matches a manifest drop rule (e.g.
 *    Codex sub-agent thread spawns: `source.subagent`) must skip the ENTIRE
 *    mining pass — no batches created, no responses attributed. This kills
 *    the child-into-parent class: Codex sub-agent tool events carry the
 *    PARENT session_id with the CHILD transcript_path, so mining the child
 *    rollout grafted foreign kickoffs onto the parent session.
 *
 * 2. Per-prompt `transcript_meta_*` rules must fire identically in hook
 *    context (evaluateUserPromptRules with meta) and walker context
 *    (extractUserPromptRecordsWithDrops with meta) — pre-fix the walker
 *    never received meta, so every such rule was structurally inert at
 *    mining time.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { TranscriptMiner, type MinerLogger } from '@myco/capture/transcript-miner.js';
import { extractUserPromptRecordsWithDrops } from '@myco/capture/prompt-kind.js';
import { evaluateUserPromptRules } from '@myco/hooks/capture-rules.js';
import { listBatchesBySession, listBatchesBySessionThread, PROMPT_PREFIX_MATCH_CHARS } from '@myco/db/queries/batches.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

interface LogCall { level: string; kind: string; message: string; data?: Record<string, unknown> }

function collectingLogger(): { logger: MinerLogger; calls: LogCall[] } {
  const calls: LogCall[] = [];
  return {
    calls,
    logger: {
      info: (kind, message, data) => calls.push({ level: 'info', kind, message, data }),
      warn: (kind, message, data) => calls.push({ level: 'warn', kind, message, data }),
    },
  };
}

function codexUserEntry(text: string, timestamp: string): Record<string, unknown> {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] },
  };
}

function codexAssistantEntry(text: string, timestamp: string): Record<string, unknown> {
  return {
    timestamp,
    type: 'response_item',
    payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] },
  };
}

function sessionMetaEntry(source: unknown): Record<string, unknown> {
  return { timestamp: '2026-06-12T10:00:00Z', type: 'session_meta', payload: { id: 'rollout-meta', source } };
}

function writeTranscript(filePath: string, entries: Record<string, unknown>[]): void {
  fs.writeFileSync(filePath, entries.map((e) => JSON.stringify(e)).join('\n') + '\n');
}

const SUBAGENT_META = { subagent: { thread_spawn: { parent: 'whatever' } } };

describe('TranscriptMiner — transcript-level drop gate (RC-E layer 1)', () => {
  let tmpDir: string;
  let transcriptPath: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'meta-gate-test-'));
    transcriptPath = path.join(tmpDir, 'rollout.jsonl');
    seedSession({ id: 's-meta-gate', agent: 'codex' });
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const conversation = [
    codexUserEntry('Kickoff: review the diff for correctness', '2026-06-12T10:00:01Z'),
    codexAssistantEntry('Reviewing now.', '2026-06-12T10:00:30Z'),
  ];

  it('skips the entire mining pass for a subagent-thread transcript, with an info log', () => {
    writeTranscript(transcriptPath, [sessionMetaEntry(SUBAGENT_META), ...conversation]);
    const { logger, calls } = collectingLogger();
    const miner = new TranscriptMiner({ logger });

    const result = miner.reconcileAndAttributeResponses('s-meta-gate', {
      agent: 'codex',
      transcriptPath,
    });

    expect(result.skippedReason).toBe('subagent-thread-spawn');
    expect(result.inserted).toBe(0);
    expect(result.reclassified).toBe(0);
    // No batches were created in the (parent) session.
    expect(listBatchesBySession('s-meta-gate', { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    // Info log carries session, path, and reason.
    const skip = calls.find((c) => c.message.startsWith('Mining skipped'));
    expect(skip).toBeDefined();
    expect(skip!.level).toBe('info');
    expect(skip!.data).toMatchObject({
      session_id: 's-meta-gate',
      transcript_path: transcriptPath,
      reason: 'subagent-thread-spawn',
    });
  });

  it('logs the skip once per transcript, not once per reconcile tick', () => {
    writeTranscript(transcriptPath, [sessionMetaEntry(SUBAGENT_META), ...conversation]);
    const { logger, calls } = collectingLogger();
    const miner = new TranscriptMiner({ logger });

    miner.reconcileAndAttributeResponses('s-meta-gate', { agent: 'codex', transcriptPath });
    miner.reconcileAndAttributeResponses('s-meta-gate', { agent: 'codex', transcriptPath });
    miner.reconcileAndAttributeResponses('s-meta-gate', { agent: 'codex', transcriptPath });

    expect(calls.filter((c) => c.message.startsWith('Mining skipped'))).toHaveLength(1);
  });

  it('mines normally when the same transcript lacks the subagent meta', () => {
    writeTranscript(transcriptPath, [sessionMetaEntry('vscode'), ...conversation]);
    const miner = new TranscriptMiner();

    const result = miner.reconcileAndAttributeResponses('s-meta-gate', {
      agent: 'codex',
      transcriptPath,
    });

    expect(result.skippedReason).toBeUndefined();
    expect(result.inserted).toBe(1);
    const batches = listBatchesBySession('s-meta-gate', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(1);
    expect(batches[0].user_prompt).toBe('Kickoff: review the diff for correctness');
    expect(batches[0].response_summary).toBe('Reviewing now.');
  });

  it('drops a `source: exec` transcript via the same gate (noninteractive-exec rule)', () => {
    writeTranscript(transcriptPath, [sessionMetaEntry('exec'), ...conversation]);
    const miner = new TranscriptMiner();

    const result = miner.reconcileBatchKinds('s-meta-gate', { agent: 'codex', transcriptPath });

    expect(result.skippedReason).toBe('noninteractive-exec');
    expect(listBatchesBySession('s-meta-gate', { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });
});

describe('transcript_meta rules — hook/walker parity (RC-E layer 2)', () => {
  const prompt = 'Kickoff prompt from a subagent thread';
  const events = [codexUserEntry(prompt, '2026-06-12T10:00:01Z')];
  const meta = { id: 'rollout-meta', source: SUBAGENT_META };

  it('a per-prompt transcript_meta rule fires identically in hook and walker contexts', () => {
    // Hook context — codex layer 4: user_prompt + transcript_meta_field_exists
    // source.subagent → drop.
    const hookDecision = evaluateUserPromptRules('codex', {
      prompt,
      transcriptPath: '/tmp/rollout.jsonl',
      transcriptMeta: meta,
    });
    expect(hookDecision.action).toBe('drop');

    // Walker context — same meta supplied, same outcome.
    const walked = extractUserPromptRecordsWithDrops('codex', events, '/tmp/rollout.jsonl', meta);
    expect(walked.records).toHaveLength(0);
    expect(walked.droppedText).toEqual([prompt]);
  });

  it('without meta, both contexts pass the prompt through (no false drops)', () => {
    const hookDecision = evaluateUserPromptRules('codex', {
      prompt,
      transcriptPath: '/tmp/rollout.jsonl',
    });
    expect(hookDecision.action).toBe('pass');

    const walked = extractUserPromptRecordsWithDrops('codex', events, '/tmp/rollout.jsonl');
    expect(walked.records.map((r) => r.text)).toEqual([prompt]);
    expect(walked.droppedText).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Sub-agent thread reattribution (Task 4).
// ---------------------------------------------------------------------------

/**
 * A child sub-agent rollout's session_meta, matching the real shape verified
 * against a live codex child rollout: payload.id is the child's OWN thread id
 * (== the rollout filename UUID), and
 * payload.source.subagent.thread_spawn.parent_thread_id is the parent thread.
 */
function subagentMetaEntry(opts: {
  childId: string;
  parentThreadId: string;
  agentPath?: string;
  agentNickname?: string;
}): Record<string, unknown> {
  const thread_spawn: Record<string, unknown> = { parent_thread_id: opts.parentThreadId };
  if (opts.agentPath !== undefined) thread_spawn.agent_path = opts.agentPath;
  if (opts.agentNickname !== undefined) thread_spawn.agent_nickname = opts.agentNickname;
  return {
    timestamp: '2026-07-12T14:51:20Z',
    type: 'session_meta',
    payload: { id: opts.childId, source: { subagent: { thread_spawn } } },
  };
}

/** Main-thread rows only (thread_id IS NULL) — the parent's human conversation. */
function mainThreadRows(sessionId: string) {
  return listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })
    .filter((b) => b.thread_id === null)
    .sort((a, b) => a.id - b.id);
}

describe('TranscriptMiner — sub-agent thread reattribution (Task 4)', () => {
  const PARENT = 'parent-thread-abc';
  const CHILD = '019f57ab-child-uuid';

  let tmpDir: string;
  let parentPath: string;
  let childPath: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'subagent-thread-test-'));
    parentPath = path.join(tmpDir, 'parent.jsonl');
    childPath = path.join(tmpDir, 'child.jsonl');
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  const childConversation = [
    codexUserEntry('Review task 6 for correctness', '2026-07-12T14:51:21Z'),
    codexAssistantEntry('Reviewed — found one issue.', '2026-07-12T14:51:40Z'),
    codexUserEntry('Now check the tests too', '2026-07-12T14:52:00Z'),
    codexAssistantEntry('Tests look complete.', '2026-07-12T14:52:20Z'),
  ];

  /** Seed the parent with a normal (main-thread) codex conversation + its rows. */
  function seedParentWithHumanBatches(): void {
    seedSession({ id: PARENT, agent: 'codex' });
    writeTranscript(parentPath, [
      sessionMetaEntry('vscode'),
      codexUserEntry('Kick off the parent task', '2026-07-12T14:00:01Z'),
      codexAssistantEntry('Working on it.', '2026-07-12T14:00:30Z'),
      codexUserEntry('Great, now do the second part', '2026-07-12T14:05:00Z'),
      codexAssistantEntry('Second part done.', '2026-07-12T14:05:30Z'),
    ]);
    new TranscriptMiner().reconcileAndAttributeResponses(PARENT, { agent: 'codex', transcriptPath: parentPath });
  }

  function writeChild(childId = CHILD, parentThreadId = PARENT): void {
    writeTranscript(childPath, [
      subagentMetaEntry({ childId, parentThreadId, agentPath: '/root/task_6_reviewer', agentNickname: 'Peirce' }),
      ...childConversation,
    ]);
  }

  it('mines the child thread INTO the parent as agent_dispatch rows with thread_id + thread_label', () => {
    seedParentWithHumanBatches();
    writeChild();

    const result = new TranscriptMiner().reconcileAndAttributeResponses(CHILD, {
      agent: 'codex',
      transcriptPath: childPath,
    });

    expect(result.skippedReason).toBeUndefined();

    const threadRows = listBatchesBySessionThread(PARENT, CHILD);
    expect(threadRows).toHaveLength(2);
    expect(threadRows.every((r) => r.origin === 'agent_dispatch')).toBe(true);
    expect(threadRows.every((r) => r.thread_id === CHILD)).toBe(true);
    // Label derives from agent_nickname ("Peirce"), not the agent_path segment.
    expect(threadRows.every((r) => r.thread_label === 'Peirce')).toBe(true);
    expect(threadRows.map((r) => r.user_prompt)).toEqual([
      'Review task 6 for correctness',
      'Now check the tests too',
    ]);
    // Sub-agent turns get their response summaries like any other batch.
    expect(threadRows.map((r) => r.response_summary)).toEqual([
      'Reviewed — found one issue.',
      'Tests look complete.',
    ]);

    // Zero rows under the CHILD id, and no child session was ever created.
    expect(listBatchesBySession(CHILD, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    expect(getSession(CHILD, ALL_PROJECTS_SCOPE)).toBeNull();
  });

  it('every thread batch is born-closed (ended_at set, status completed)', () => {
    seedParentWithHumanBatches();
    writeChild();
    new TranscriptMiner().reconcileAndAttributeResponses(CHILD, { agent: 'codex', transcriptPath: childPath });

    const threadRows = listBatchesBySessionThread(PARENT, CHILD);
    expect(threadRows).toHaveLength(2);
    expect(threadRows.every((r) => r.ended_at !== null)).toBe(true);
    expect(threadRows.every((r) => r.status === 'completed')).toBe(true);
  });

  it("leaves the parent's human batches BYTE-IDENTICAL and its prompt_number sequence unchanged", () => {
    seedParentWithHumanBatches();
    const before = mainThreadRows(PARENT);
    const beforePromptNumbers = before.map((r) => r.prompt_number);
    expect(before.length).toBeGreaterThan(0);

    writeChild();
    new TranscriptMiner().reconcileAndAttributeResponses(CHILD, { agent: 'codex', transcriptPath: childPath });

    const after = mainThreadRows(PARENT);
    // Full-row deep-equal: nothing about the parent's main-thread rows moved.
    expect(after).toEqual(before);
    expect(after.map((r) => r.prompt_number)).toEqual(beforePromptNumbers);
  });

  it('sibling threads with identical text at the same ordinal both persist', () => {
    seedParentWithHumanBatches();
    const siblingText = 'Do the shared review step';
    const sibling = [
      codexUserEntry(siblingText, '2026-07-12T14:51:21Z'),
      codexAssistantEntry('Sibling done.', '2026-07-12T14:51:40Z'),
    ];

    const childAId = '019f57ab-sibling-A';
    const childBId = '019f5781-sibling-B';
    const childAPath = path.join(tmpDir, 'sibA.jsonl');
    const childBPath = path.join(tmpDir, 'sibB.jsonl');
    writeTranscript(childAPath, [subagentMetaEntry({ childId: childAId, parentThreadId: PARENT, agentNickname: 'A' }), ...sibling]);
    writeTranscript(childBPath, [subagentMetaEntry({ childId: childBId, parentThreadId: PARENT, agentNickname: 'B' }), ...sibling]);

    new TranscriptMiner().reconcileAndAttributeResponses(childAId, { agent: 'codex', transcriptPath: childAPath });
    new TranscriptMiner().reconcileAndAttributeResponses(childBId, { agent: 'codex', transcriptPath: childBPath });

    const aRows = listBatchesBySessionThread(PARENT, childAId);
    const bRows = listBatchesBySessionThread(PARENT, childBId);
    expect(aRows).toHaveLength(1);
    expect(bRows).toHaveLength(1);
    expect(aRows[0].user_prompt).toBe(siblingText);
    expect(bRows[0].user_prompt).toBe(siblingText);
    // Distinct rows, distinct content hashes (thread id folds into the hash).
    expect(aRows[0].id).not.toBe(bRows[0].id);
    expect(aRows[0].content_hash).not.toBe(bRows[0].content_hash);
  });

  it('converges to the same rows from both caller shapes (child-id Stop + parent-id live-reconcile), idempotent', () => {
    seedParentWithHumanBatches();
    writeChild();

    // Caller shape 1: a Stop carrying the CHILD id as sessionId.
    new TranscriptMiner().reconcileAndAttributeResponses(CHILD, { agent: 'codex', transcriptPath: childPath });
    const afterFirst = listBatchesBySessionThread(PARENT, CHILD).length;

    // Caller shape 2: a live-reconcile carrying the PARENT id with the child
    // path. A fresh miner forces a full re-mine (no parse-cache short-circuit);
    // the thread-scoped content hash makes the re-mine a dedupe no-op.
    new TranscriptMiner().reconcileAndAttributeResponses(PARENT, { agent: 'codex', transcriptPath: childPath });
    const afterSecond = listBatchesBySessionThread(PARENT, CHILD).length;

    expect(afterFirst).toBe(2);
    expect(afterSecond).toBe(afterFirst);
    // Parent main thread still untouched by either caller shape.
    expect(mainThreadRows(PARENT)).toHaveLength(2);
  });

  it('skips with subagent-parent-missing when the parent session does not exist — nothing created', () => {
    // Parent NOT seeded.
    writeChild(CHILD, 'nonexistent-parent');

    const result = new TranscriptMiner().reconcileAndAttributeResponses(CHILD, {
      agent: 'codex',
      transcriptPath: childPath,
    });

    expect(result.skippedReason).toBe('subagent-parent-missing');
    expect(getSession('nonexistent-parent', ALL_PROJECTS_SCOPE)).toBeNull();
    expect(getSession(CHILD, ALL_PROJECTS_SCOPE)).toBeNull();
    expect(listBatchesBySession(CHILD, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
    expect(listBatchesBySessionThread('nonexistent-parent', CHILD)).toHaveLength(0);
  });

  it('other drop rules still apply inside the carve-out: the AGENTS.md first-prompt is dropped', () => {
    seedParentWithHumanBatches();
    writeTranscript(childPath, [
      subagentMetaEntry({ childId: CHILD, parentThreadId: PARENT, agentNickname: 'Peirce' }),
      codexUserEntry('# AGENTS.md instructions\n\nProject context injected by codex', '2026-07-12T14:51:21Z'),
      codexAssistantEntry('Acknowledged.', '2026-07-12T14:51:30Z'),
      codexUserEntry('Actual reviewer prompt', '2026-07-12T14:51:40Z'),
      codexAssistantEntry('Reviewing.', '2026-07-12T14:51:50Z'),
    ]);

    new TranscriptMiner().reconcileAndAttributeResponses(CHILD, { agent: 'codex', transcriptPath: childPath });

    const threadRows = listBatchesBySessionThread(PARENT, CHILD);
    // The AGENTS.md injection is dropped even in the reattribution walk; only
    // the real reviewer turn survives.
    expect(threadRows.map((r) => r.user_prompt)).toEqual(['Actual reviewer prompt']);
  });

  it('an exec transcript still drops via the gate (never reattributed)', () => {
    seedParentWithHumanBatches();
    writeTranscript(childPath, [sessionMetaEntry('exec'), ...childConversation]);

    const result = new TranscriptMiner().reconcileBatchKinds(CHILD, { agent: 'codex', transcriptPath: childPath });

    expect(result.skippedReason).toBe('noninteractive-exec');
    expect(listBatchesBySession(CHILD, { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });

  // Review finding: a resolvable parent with no thread id (agent-format
  // change or manifest misconfiguration) must still drop safely, but with a
  // distinct WARN — not the generic "Mining skipped" info log a real
  // sub-agent-thread drop gets, which would otherwise look identical.
  it('warns distinctly when the parent resolves but the thread id does not, and still drops', () => {
    seedParentWithHumanBatches();
    // Same shape as subagentMetaEntry, but with no top-level `id` — codex's
    // subagentThreadIdPath ("id") can't resolve, so threadId stays null even
    // though parentSessionId resolves.
    writeTranscript(childPath, [
      {
        timestamp: '2026-07-12T14:51:20Z',
        type: 'session_meta',
        payload: { source: { subagent: { thread_spawn: { parent_thread_id: PARENT } } } },
      },
      ...childConversation,
    ]);
    const { logger, calls } = collectingLogger();
    const miner = new TranscriptMiner({ logger });

    const result = miner.reconcileAndAttributeResponses(CHILD, { agent: 'codex', transcriptPath: childPath });

    // Still drops — behavior unchanged.
    expect(result.skippedReason).toBe('subagent-thread-spawn');
    expect(listBatchesBySessionThread(PARENT, CHILD)).toHaveLength(0);

    const warn = calls.find((c) => c.level === 'warn' && c.message.includes('resolvable parent but no thread id'));
    expect(warn).toBeDefined();
    expect(warn!.data).toMatchObject({
      session_id: CHILD,
      transcript_path: childPath,
      parent_session_id: PARENT,
    });
  });
});

describe('walker carve-out — sub-agent reattribution masks only the sub-agent drop (Task 4)', () => {
  const meta = { id: 'child-uuid', source: { subagent: { thread_spawn: { parent_thread_id: 'p1' } } } };

  it('without the option, the sub-agent meta drops every prompt (unchanged live-hook behavior)', () => {
    const events = [codexUserEntry('reviewer turn', '2026-07-12T14:51:21Z')];
    const walked = extractUserPromptRecordsWithDrops('codex', events, '/tmp/child.jsonl', meta);
    expect(walked.records).toHaveLength(0);
    expect(walked.droppedText).toEqual(['reviewer turn']);
  });

  it('with subagentReattribution, sub-agent turns survive as agent_dispatch but AGENTS.md still drops', () => {
    const events = [
      codexUserEntry('# AGENTS.md instructions\n\ncontext', '2026-07-12T14:51:21Z'),
      codexUserEntry('reviewer turn', '2026-07-12T14:51:40Z'),
    ];
    const walked = extractUserPromptRecordsWithDrops(
      'codex',
      events,
      '/tmp/child.jsonl',
      meta,
      { subagentReattribution: true },
    );
    expect(walked.records.map((r) => r.text)).toEqual(['reviewer turn']);
    expect(walked.records.every((r) => r.origin === 'agent_dispatch')).toBe(true);
    expect(walked.droppedText).toEqual(['# AGENTS.md instructions\n\ncontext']);
  });
});

// ---------------------------------------------------------------------------
// Final-review finding: main-thread mining must structurally exclude thread
// rows (symmetry with the reattribution branch, which is already
// thread-scoped via listBatchesBySessionThread).
// ---------------------------------------------------------------------------

describe('TranscriptMiner — main-thread mining structurally excludes thread rows (symmetry fix)', () => {
  const PARENT = 'parent-symmetry';
  const CHILD = 'child-symmetry-thread';

  let tmpDir: string;
  let parentPath: string;
  let childPath: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'main-thread-symmetry-test-'));
    parentPath = path.join(tmpDir, 'parent.jsonl');
    childPath = path.join(tmpDir, 'child.jsonl');
    seedSession({ id: PARENT, agent: 'codex' });
  });
  afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

  // A thread-row prompt and a later main-thread prompt share the exact
  // PROMPT_PREFIX_MATCH_CHARS-length prefix `buildPrefixBuckets` keys on,
  // but diverge after it — the collision shape the review finding describes.
  const SHARED_PREFIX = 'Q'.repeat(PROMPT_PREFIX_MATCH_CHARS);
  const threadPrompt = `${SHARED_PREFIX} — child thread turn`;
  const parentPrompt = `${SHARED_PREFIX} — parent human turn`;

  it('does not reclassify/re-parent a thread row when a later main-thread prompt collides on its 60-char prefix', () => {
    // 1. Mine a child sub-agent transcript into the parent as a thread batch.
    writeTranscript(childPath, [
      subagentMetaEntry({ childId: CHILD, parentThreadId: PARENT, agentNickname: 'Reviewer' }),
      codexUserEntry(threadPrompt, '2026-07-12T14:51:21Z'),
      codexAssistantEntry('Thread turn handled.', '2026-07-12T14:51:40Z'),
    ]);
    new TranscriptMiner().reconcileAndAttributeResponses(CHILD, { agent: 'codex', transcriptPath: childPath });

    const threadRowsBefore = listBatchesBySessionThread(PARENT, CHILD);
    expect(threadRowsBefore).toHaveLength(1);
    const before = threadRowsBefore[0];
    expect(before.user_prompt).toBe(threadPrompt);
    expect(before.origin).toBe('agent_dispatch');
    expect(before.kind).toBe('initial');

    // 2. A separate, LATER main-thread transcript introduces a brand-new
    // human prompt whose first 60 chars collide with the thread row's
    // prefix key. Before the fix, buildPrefixBuckets sourced from
    // listBatchesBySession (every thread's rows) could hand this record's
    // `buckets.consume` call the thread row instead of treating it as new —
    // updateBatchKind would then silently re-parent/reclassify the thread
    // row, and the parent's real prompt would never get its own batch.
    writeTranscript(parentPath, [
      sessionMetaEntry('vscode'),
      codexUserEntry(parentPrompt, '2026-07-12T15:00:00Z'),
      codexAssistantEntry('Parent turn handled.', '2026-07-12T15:00:30Z'),
    ]);
    const result = new TranscriptMiner().reconcileAndAttributeResponses(PARENT, {
      agent: 'codex',
      transcriptPath: parentPath,
    });
    expect(result.skippedReason).toBeUndefined();

    // The thread row is untouched — full-row equal to its pre-mine snapshot
    // (origin, kind, thread_id, parent_prompt_batch_id, everything).
    const threadRowsAfter = listBatchesBySessionThread(PARENT, CHILD);
    expect(threadRowsAfter).toHaveLength(1);
    expect(threadRowsAfter[0]).toEqual(before);

    // The parent's own prompt gets matched to its own bucket: a genuine new
    // main-thread batch, not a hijacked thread row.
    const mainRows = mainThreadRows(PARENT);
    const parentBatch = mainRows.find((r) => r.user_prompt === parentPrompt);
    expect(parentBatch).toBeDefined();
    expect(parentBatch!.thread_id).toBeNull();
    expect(parentBatch!.origin).toBe('human');
    expect(parentBatch!.kind).toBe('initial');
    expect(parentBatch!.response_summary).toBe('Parent turn handled.');
    expect(result.inserted).toBe(1);
  });
});
