import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession, nowSec } from '../helpers/sessions.js';

import { reEnrichSessionFromTranscript } from '@myco/daemon/session-reenrich.js';
import {
  RECOVERED_BATCH_SENTINEL,
  insertBatch,
  listBatchesBySession,
  setResponseSummary,
} from '@myco/db/queries/batches.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import type { TranscriptTurn } from '@myco/symbionts/adapter.js';

// Minimal logger that records what the helper would have emitted; pulling
// the real DaemonLogger has too many transitive deps for a unit test.
function silentLogger() {
  const entries: Array<{ level: string; kind: string; message: string; meta?: Record<string, unknown> }> = [];
  return {
    info: (kind: string, message: string, meta?: Record<string, unknown>) => entries.push({ level: 'info', kind, message, meta }),
    warn: (kind: string, message: string, meta?: Record<string, unknown>) => entries.push({ level: 'warn', kind, message, meta }),
    debug: () => {},
    error: () => {},
    entries,
  } as unknown as Parameters<typeof reEnrichSessionFromTranscript>[1]['logger'] & { entries: Array<unknown> };
}

function mockMiner(turns: TranscriptTurn[] | null) {
  return {
    getAllTurnsWithSource: (_sessionId: string, _hookTranscriptPath?: string) =>
      turns === null ? null : { turns, source: 'test-fake' },
  } as unknown as Parameters<typeof reEnrichSessionFromTranscript>[1]['transcriptMiner'];
}

describe('reEnrichSessionFromTranscript', () => {
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => cleanTestDb());

  it('replaces the recovery-sentinel batch user_prompt with the transcript turn prompt', () => {
    const sessionId = seedSession({ id: 's-reenrich-1', agent: 'antigravity' });
    insertBatch({
      session_id: sessionId,
      kind: 'initial',
      prompt_number: 1,
      user_prompt: RECOVERED_BATCH_SENTINEL,
      started_at: nowSec(),
      created_at: nowSec(),
    });
    const turns: TranscriptTurn[] = [{ prompt: 'hello', toolCount: 11, timestamp: '2026-05-23T20:20:53Z', aiResponse: 'Hi there.' }];

    const result = reEnrichSessionFromTranscript(sessionId, {
      transcriptMiner: mockMiner(turns),
      logger: silentLogger(),
    });

    expect(result.changed).toBe(true);
    expect(result.promptsReplaced).toBe(1);
    expect(result.titleUpdated).toBe(true);
    expect(result.summarySet).toBe(true);
    // `prompt_count` is now atomically maintained at insert time via
    // `insertBatch` / `insertBatchStateless`. The reenrich path no
    // longer writes the cache, so this flag stays false even when
    // the rest of the reenrichment succeeds.
    expect(result.promptCountUpdated).toBe(false);

    const batches = listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE });
    expect(batches[0]!.user_prompt).toBe('hello');
    expect(batches[0]!.response_summary).toBe('Hi there.');
    const session = getSession(sessionId, ALL_PROJECTS_SCOPE)!;
    expect(session.title?.startsWith('hello')).toBe(true);
    expect(session.prompt_count).toBe(1);
  });

  it('is a no-op when the session has no transcript turns', () => {
    const sessionId = seedSession({ id: 's-reenrich-2', agent: 'antigravity' });
    insertBatch({
      session_id: sessionId, kind: 'initial', prompt_number: 1,
      user_prompt: RECOVERED_BATCH_SENTINEL,
      started_at: nowSec(), created_at: nowSec(),
    });
    const result = reEnrichSessionFromTranscript(sessionId, {
      transcriptMiner: mockMiner([]), logger: silentLogger(),
    });
    expect(result.changed).toBe(false);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })[0]!.user_prompt).toBe(RECOVERED_BATCH_SENTINEL);
  });

  it('leaves real user prompts captured by the live path untouched', () => {
    const sessionId = seedSession({ id: 's-reenrich-3', agent: 'claude-code' });
    insertBatch({
      session_id: sessionId, kind: 'initial', prompt_number: 1,
      user_prompt: 'real prompt from live capture',
      started_at: nowSec(), created_at: nowSec(),
    });
    const turns: TranscriptTurn[] = [{ prompt: 'different transcript prompt', toolCount: 0, timestamp: '2026-05-23T20:20:53Z' }];
    const result = reEnrichSessionFromTranscript(sessionId, {
      transcriptMiner: mockMiner(turns), logger: silentLogger(),
    });
    // No prompt replacement — the row isn't carrying the sentinel.
    expect(result.promptsReplaced).toBe(0);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })[0]!.user_prompt).toBe('real prompt from live capture');
  });

  it('does not overwrite an existing response_summary', () => {
    const sessionId = seedSession({ id: 's-reenrich-4', agent: 'antigravity' });
    const batch = insertBatch({
      session_id: sessionId, kind: 'initial', prompt_number: 1,
      user_prompt: RECOVERED_BATCH_SENTINEL,
      started_at: nowSec(), created_at: nowSec(),
    });
    setResponseSummary(batch.id, 'already there');
    const turns: TranscriptTurn[] = [{ prompt: 'hello', toolCount: 0, timestamp: 't', aiResponse: 'new reply' }];
    const result = reEnrichSessionFromTranscript(sessionId, {
      transcriptMiner: mockMiner(turns), logger: silentLogger(),
    });
    expect(result.summarySet).toBe(false);
    expect(listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE })[0]!.response_summary).toBe('already there');
  });

  it('returns empty when the session row is missing', () => {
    const result = reEnrichSessionFromTranscript('no-such-session', {
      transcriptMiner: mockMiner([{ prompt: 'x', toolCount: 0, timestamp: 't' }]),
      logger: silentLogger(),
    });
    expect(result.changed).toBe(false);
  });

  it('survives a transcript miner that throws (logs warning, no change)', () => {
    const sessionId = seedSession({ id: 's-reenrich-5', agent: 'antigravity' });
    insertBatch({
      session_id: sessionId, kind: 'initial', prompt_number: 1,
      user_prompt: RECOVERED_BATCH_SENTINEL,
      started_at: nowSec(), created_at: nowSec(),
    });
    const throwingMiner = {
      getAllTurnsWithSource: () => { throw new Error('boom'); },
    } as unknown as Parameters<typeof reEnrichSessionFromTranscript>[1]['transcriptMiner'];

    const result = reEnrichSessionFromTranscript(sessionId, {
      transcriptMiner: throwingMiner, logger: silentLogger(),
    });
    expect(result.changed).toBe(false);
  });
});
