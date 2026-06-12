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
import { listBatchesBySession } from '@myco/db/queries/batches.js';
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
