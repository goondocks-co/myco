import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { createStopProcessor } from '@myco/daemon/stop-processing.js';
import { SessionRegistry } from '@myco/daemon/lifecycle.js';
import { getSession, upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch, listBatchesBySession } from '@myco/db/queries/batches.js';

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

function makeStopProcessor(vaultDir: string) {
  return createStopProcessor({
    registry: new SessionRegistry({ gracePeriod: 1, onEmpty: () => {} }),
    sessionBuffers: new Map(),
    transcriptMiner: { getAllTurnsWithSource: vi.fn() } as never,
    embeddingManager: { onRemoved: vi.fn() } as never,
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as never,
    config: { agent: { event_tasks_enabled: false } } as never,
    vaultDir,
    planTags: [],
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
});
