import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { createStopProcessor } from '@myco/daemon/stop-processing.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { getSession, upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch, listBatchesBySession } from '@myco/db/queries/batches.js';
import { listPlansBySession } from '@myco/db/queries/plans.js';

const epochNow = () => Math.floor(Date.now() / 1000);

function writeCodexSubagentTranscript(sessionId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codex-subagent-'));
  const transcriptPath = path.join(dir, `rollout-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        source: {
          subagent: {
            thread_spawn: {
              parent_thread_id: 'parent-session',
              depth: 1,
              agent_role: 'default',
            },
          },
        },
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Review this diff' }],
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  return transcriptPath;
}

function writeCodexExecTranscript(sessionId: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-codex-exec-'));
  const transcriptPath = path.join(dir, `rollout-${sessionId}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: {
        id: sessionId,
        source: 'exec',
        cwd: '/Users/chris/Repos/myco',
      },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'reply with exactly ok' }],
      },
    }),
  ];
  fs.writeFileSync(transcriptPath, `${lines.join('\n')}\n`);
  return transcriptPath;
}

function makeStopProcessor(vaultDir: string, options?: { planWatchConfig?: { watchDirs: string[]; projectRoot: string; extensions?: string[] } }) {
  return createStopProcessor({
    registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
    sessionBuffers: new Map(),
    transcriptMiner: {
      getAllTurnsWithSource: vi.fn(() => ({ turns: [], source: 'transcript' })),
    } as never,
    embeddingManager: { onRemoved: vi.fn() } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
    liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
    vaultDir,
    planTags: [],
    planWatchConfig: options?.planWatchConfig ?? { watchDirs: [], projectRoot: vaultDir },
  });
}

describe('createStopProcessor session capture rules', () => {
  let vaultDir: string;

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stop-processor-'));
  });

  afterAll(() => {
    teardownTestDb();
  });

  // Regression: when a steering child is the latest batch, the assistant
  // response belongs on the turn's parent so the UI's parent card renders
  // it. Previously setResponseSummary wrote to getLatestBatch, which was
  // the steering child — leaving the parent with NULL summary.
  it('routes response_summary to the parent batch when the latest batch is a steering child', async () => {
    const sessionId = 'steering-summary-001';
    const now = epochNow();
    upsertSession({
      id: sessionId,
      agent: 'opencode',
      status: 'active',
      started_at: now,
      created_at: now,
    });
    const parent = insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'parent prompt',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 2,
      user_prompt: 'mid-turn steering',
      started_at: now + 1,
      created_at: now + 1,
    });
    // Promote the second batch to steering + point it at the parent.
    // (Using raw SQL — insertBatch doesn't carry kind/parent fields yet.)
    const { getDatabase } = await import('@myco/db/client.js');
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET kind='steering', parent_prompt_batch_id=? WHERE session_id=? AND prompt_number=2`).run(parent.id, sessionId);

    const stopProcessor = makeStopProcessor(vaultDir);
    await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'opencode',
        last_assistant_message: 'combined turn reply',
      },
    } as never);

    const batches = listBatchesBySession(sessionId);
    const parentAfter = batches.find((b) => b.prompt_number === 1)!;
    const childAfter = batches.find((b) => b.prompt_number === 2)!;
    expect(parentAfter.response_summary).toBe('combined turn reply');
    expect(childAfter.response_summary).toBeNull();
  });

  // Regression: Cursor's stop payload doesn't carry `last_assistant_message`
  // and its transcript is rewritten per turn (always turn_count=1). The
  // primary capture path must fall back to the last parsed turn's aiResponse
  // so the current-turn batch gets its response_summary filled.
  it('falls back to the transcript\'s last turn when last_assistant_message is absent', async () => {
    const sessionId = 'cursor-fallback-001';
    const now = epochNow();
    upsertSession({
      id: sessionId,
      agent: 'cursor',
      status: 'active',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'hello',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 2,
      user_prompt: 'tell me about the changes',
      started_at: now + 1,
      created_at: now + 1,
    });
    const { getDatabase } = await import('@myco/db/client.js');
    const db = getDatabase();
    // Batch 1 already has a response from its own stop cycle.
    db.prepare(`UPDATE prompt_batches SET response_summary=? WHERE session_id=? AND prompt_number=1`)
      .run('Hi there.', sessionId);

    const stopProcessor = createStopProcessor({
      registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
      sessionBuffers: new Map(),
      transcriptMiner: {
        getAllTurnsWithSource: vi.fn(() => ({
          turns: [
            {
              // Transcript's turn 1 matches batch 2 by prompt text, not by
              // position. Verifies prefix-matching beats positional mapping.
              prompt: 'tell me about the changes',
              toolCount: 3,
              timestamp: '',
              aiResponse: 'Here is the branch summary.',
            },
          ],
          source: 'cursor:direct',
        })),
      } as never,
      embeddingManager: { onRemoved: vi.fn() } as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      vaultDir,
      planTags: [],
      planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
    });

    await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'cursor',
        transcript_path: '/tmp/cursor-fake-transcript.jsonl',
        // last_assistant_message deliberately omitted — Cursor never sends it.
      },
    } as never);

    const batches = listBatchesBySession(sessionId);
    const batch2 = batches.find((b) => b.prompt_number === 2)!;
    expect(batch2.response_summary).toBe('Here is the branch summary.');
    // Batch 1's prior response must NOT be overwritten.
    const batch1 = batches.find((b) => b.prompt_number === 1)!;
    expect(batch1.response_summary).toBe('Hi there.');
  });

  // Regression: populateBatchResponses used to map turn_index → batches[N-1]
  // by insertion order. For Cursor, transcript turn 1 is not necessarily
  // batch 1 (Cursor may start its per-conversation transcript mid-session),
  // which wrote turn N's response onto the wrong batch. Now matched by
  // prompt-text prefix, so each turn lands on the batch with the same prompt.
  it('matches transcript responses to batches by prompt prefix even when order diverges', async () => {
    const sessionId = 'cursor-prefix-match-001';
    const now = epochNow();
    upsertSession({
      id: sessionId,
      agent: 'cursor',
      status: 'active',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'hello',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 2,
      user_prompt: 'tell me about the changes in this branch',
      started_at: now + 1,
      created_at: now + 1,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 3,
      user_prompt: 'Without doing anything, how would you break this up?',
      started_at: now + 2,
      created_at: now + 2,
    });
    const { getDatabase } = await import('@myco/db/client.js');
    const db = getDatabase();
    db.prepare(`UPDATE prompt_batches SET response_summary=? WHERE session_id=? AND prompt_number=1`)
      .run('Hello.', sessionId);

    const stopProcessor = createStopProcessor({
      registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
      sessionBuffers: new Map(),
      transcriptMiner: {
        getAllTurnsWithSource: vi.fn(() => ({
          // Cursor's transcript contains only the prompts it has seen
          // locally. Turn 1 here is Myco's batch 2, turn 2 is batch 3.
          turns: [
            {
              prompt: 'tell me about the changes in this branch',
              toolCount: 3,
              timestamp: '',
              aiResponse: 'Concise branch summary.',
            },
            {
              prompt: 'Without doing anything, how would you break this up?',
              toolCount: 0,
              timestamp: '',
              aiResponse: 'Here is a practical slicing.',
            },
          ],
          source: 'cursor:direct',
        })),
      } as never,
      embeddingManager: { onRemoved: vi.fn() } as never,
      logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
      vaultDir,
      planTags: [],
      planWatchConfig: { watchDirs: [], projectRoot: vaultDir },
    });

    await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'cursor',
        transcript_path: '/tmp/cursor-fake-transcript.jsonl',
      },
    } as never);

    const batches = listBatchesBySession(sessionId);
    const b1 = batches.find((b) => b.prompt_number === 1)!;
    const b2 = batches.find((b) => b.prompt_number === 2)!;
    const b3 = batches.find((b) => b.prompt_number === 3)!;
    expect(b1.response_summary).toBe('Hello.');
    expect(b2.response_summary).toBe('Concise branch summary.');
    expect(b3.response_summary).toBe('Here is a practical slicing.');
  });

  it('ignores a sub-agent transcript before any session row exists', async () => {
    const sessionId = 'codex-subagent-stop-001';
    const transcriptPath = writeCodexSubagentTranscript(sessionId);
    const stopProcessor = makeStopProcessor(vaultDir);

    const res = await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'codex',
        transcript_path: transcriptPath,
        last_assistant_message: 'done',
      },
    } as never);

    expect(res.body).toEqual({ ok: true, ignored: 'subagent-thread-spawn' });
    expect(getSession(sessionId)).toBeNull();
  });

  it('deletes a leaked session row when stop re-evaluates the capture rules', async () => {
    const sessionId = 'codex-subagent-stop-002';
    const now = epochNow();
    const transcriptPath = writeCodexSubagentTranscript(sessionId);
    const stopProcessor = makeStopProcessor(vaultDir);

    upsertSession({
      id: sessionId,
      agent: 'codex',
      status: 'active',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'stale prompt',
      started_at: now,
      created_at: now,
    });

    expect(getSession(sessionId)).not.toBeNull();
    expect(listBatchesBySession(sessionId)).toHaveLength(1);

    const res = await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'codex',
        transcript_path: transcriptPath,
        last_assistant_message: 'done',
      },
    } as never);

    expect(res.body).toEqual({ ok: true, ignored: 'subagent-thread-spawn' });
    expect(getSession(sessionId)).toBeNull();
    expect(listBatchesBySession(sessionId)).toHaveLength(0);
  });

  it('ignores and deletes a leaked noninteractive exec session row', async () => {
    const sessionId = 'codex-exec-stop-001';
    const now = epochNow();
    const transcriptPath = writeCodexExecTranscript(sessionId);
    const stopProcessor = makeStopProcessor(vaultDir);

    upsertSession({
      id: sessionId,
      agent: 'codex',
      status: 'active',
      started_at: now,
      created_at: now,
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'reply with exactly ok',
      started_at: now,
      created_at: now,
    });

    const res = await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'codex',
        transcript_path: transcriptPath,
        last_assistant_message: 'ok',
      },
    } as never);

    expect(res.body).toEqual({ ok: true, ignored: 'noninteractive-exec' });
    expect(getSession(sessionId)).toBeNull();
    expect(listBatchesBySession(sessionId)).toHaveLength(0);
  });

  it('reconciles a plan-dir file written outside the fast-path tool gate', async () => {
    const sessionId = 'claude-plan-reconcile-001';
    const now = epochNow();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-reconcile-'));
    const transcriptPath = path.join(projectRoot, `${sessionId}.jsonl`);
    const specDir = path.join(projectRoot, 'docs/superpowers/specs');
    const specPath = path.join(specDir, 'reconciled.md');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(transcriptPath, '', 'utf-8');
    fs.writeFileSync(specPath, '# Reconciled Spec\n\nCaptured at stop.', 'utf-8');

    upsertSession({
      id: sessionId,
      agent: 'claude-code',
      status: 'active',
      started_at: now - 60,
      created_at: now - 60,
    });

    const stopProcessor = makeStopProcessor(vaultDir, {
      planWatchConfig: {
        watchDirs: ['docs/superpowers/specs'],
        projectRoot,
        extensions: ['.md'],
      },
    });

    const res = await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'claude-code',
        transcript_path: transcriptPath,
        last_assistant_message: 'done',
      },
    } as never);

    expect(res.body).toEqual({ ok: true });
    await stopProcessor.getActiveProcessing();

    const plans = listPlansBySession(sessionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Reconciled Spec');
    expect(plans[0].source_path).toBe('docs/superpowers/specs/reconciled.md');

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('reconciliation assigns the batch that matches the file mtime instead of the latest batch', async () => {
    const sessionId = 'claude-plan-reconcile-002';
    const now = epochNow();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-plan-batch-'));
    const transcriptPath = path.join(projectRoot, `${sessionId}.jsonl`);
    const specDir = path.join(projectRoot, 'docs/superpowers/specs');
    const specPath = path.join(specDir, 'batch-mapped.md');
    fs.mkdirSync(specDir, { recursive: true });
    fs.writeFileSync(transcriptPath, '', 'utf-8');
    fs.writeFileSync(specPath, '# Batch Mapped\n\nCaptured at stop.', 'utf-8');

    upsertSession({
      id: sessionId,
      agent: 'claude-code',
      status: 'active',
      started_at: now - 120,
      created_at: now - 120,
    });
    const firstBatch = insertBatch({
      session_id: sessionId,
      prompt_number: 1,
      user_prompt: 'Create the first plan',
      started_at: now - 90,
      created_at: now - 90,
      status: 'completed',
    });
    insertBatch({
      session_id: sessionId,
      prompt_number: 2,
      user_prompt: 'A later prompt',
      started_at: now - 10,
      created_at: now - 10,
      status: 'active',
    });
    fs.utimesSync(specPath, new Date((now - 60) * 1000), new Date((now - 60) * 1000));

    const stopProcessor = makeStopProcessor(vaultDir, {
      planWatchConfig: {
        watchDirs: ['docs/superpowers/specs'],
        projectRoot,
        extensions: ['.md'],
      },
    });

    const res = await stopProcessor.handleStopRoute({
      body: {
        session_id: sessionId,
        agent: 'claude-code',
        transcript_path: transcriptPath,
        last_assistant_message: 'done',
      },
    } as never);

    expect(res.body).toEqual({ ok: true });
    await stopProcessor.getActiveProcessing();

    const plans = listPlansBySession(sessionId);
    expect(plans).toHaveLength(1);
    expect(plans[0].prompt_batch_id).toBe(firstBatch.id);

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

});
