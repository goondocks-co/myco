/**
 * prompt_batches content_hash dedup guard.
 *
 * A re-inserted turn (same session, origin, ordinal, normalized text) dedups to
 * one row; a genuine repeat takes the next ordinal and is preserved. These tests
 * pin that the writer honors the caller-supplied ordinal and the partial UNIQUE
 * index fires. The miner's in-pass ordinal source and the live↔miner agreement
 * are covered in tests/capture/transcript-miner-reconcile.test.ts.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { nowSec, seedSession } from '../helpers/sessions.js';
import { getSession } from '@myco/db/queries/sessions.js';
import {
  insertBatchStateless,
  promptBatchContentHash,
  normalizePromptForHash,
  liveContentOrdinal,
  replaceRecoveredBatchUserPrompt,
  listBatchesBySession,
  PROMPT_BATCH_ORIGIN,
  RECOVERED_BATCH_SENTINEL,
} from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const batchCount = (sessionId: string): number =>
  listBatchesBySession(sessionId, { scope: ALL_PROJECTS_SCOPE }).length;

describe('promptBatchContentHash — positional, full-prompt, scoped', () => {
  it('is a pure function of (session, origin, ordinal, normalized prompt)', () => {
    const a = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'deploy' });
    const again = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'deploy' });
    expect(a).toBe(again);
  });

  it('the ordinal differentiates genuine repeats (the positional contract)', () => {
    const first = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'deploy' });
    const second = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 1, userPrompt: 'deploy' });
    expect(first).not.toBe(second);
  });

  it('normalizes the FULL prompt via trim — whitespace-only differences collapse', () => {
    const tight = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'deploy the app' });
    const padded = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: '  deploy the app\n' });
    expect(padded).toBe(tight);
    expect(normalizePromptForHash('  deploy the app\n')).toBe('deploy the app');
  });

  it('hashes the full prompt, not a prefix — divergence past any prefix window matters', () => {
    const long1 = `${'x'.repeat(500)}A`;
    const long2 = `${'x'.repeat(500)}B`;
    expect(promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: long1 }))
      .not.toBe(promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: long2 }));
  });

  it('origin and session id are part of the key', () => {
    const human = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'x' });
    const system = promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.SYSTEM, ordinal: 0, userPrompt: 'x' });
    const other = promptBatchContentHash({ sessionId: 's2', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'x' });
    expect(human).not.toBe(system);
    expect(human).not.toBe(other);
  });
});

describe('insertBatchStateless — content_hash dedup guard', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('two passes of the same positional turn insert ONE row', () => {
    // Both passes supply ordinal 0 for the same turn → same content_hash → the
    // unique index dedups the second insert.
    const first = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });
    const second = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    // The deduped insert returns the EXISTING row, never a stale lastInsertRowid.
    expect(second.row.id).toBe(first.row.id);
    expect(batchCount('s1')).toBe(1);
  });

  it('genuine repeats get distinct ordinals → both rows kept, stable across re-mine', () => {
    const t0 = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });
    const t1 = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 1, created_at: nowSec() });
    expect(t0.created).toBe(true);
    expect(t1.created).toBe(true);
    expect(batchCount('s1')).toBe(2);

    // Re-mine: a fresh pass replays the SAME positional ordinals (0, 1).
    const r0 = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });
    const r1 = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 1, created_at: nowSec() });
    expect(r0.created).toBe(false);
    expect(r1.created).toBe(false);
    expect(batchCount('s1')).toBe(2);
  });

  it('a deduped insert does not bump sessions.prompt_count a second time', () => {
    insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });
    const afterFirst = getSession('s1', ALL_PROJECTS_SCOPE)?.prompt_count;
    insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', ordinal: 0, created_at: nowSec() });
    const afterDup = getSession('s1', ALL_PROJECTS_SCOPE)?.prompt_count;
    expect(afterFirst).toBe(1);
    expect(afterDup).toBe(1);
  });

  it('an insert without an ordinal leaves content_hash NULL (no dedup, legacy behavior)', () => {
    const a = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', created_at: nowSec() });
    const b = insertBatchStateless({ session_id: 's1', user_prompt: 'deploy', created_at: nowSec() });
    expect(a.row.content_hash).toBeNull();
    expect(b.created).toBe(true);
    expect(batchCount('s1')).toBe(2);
  });
});

describe('liveContentOrdinal — the live path position', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('counts prior committed same-(origin, normalized text) batches in the session', () => {
    expect(liveContentOrdinal('s1', PROMPT_BATCH_ORIGIN.HUMAN, 'deploy')).toBe(0);
    insertBatchStateless({ session_id: 's1', user_prompt: '  deploy\n', ordinal: 0, created_at: nowSec() });
    // Whitespace-normalized match counts as a prior occurrence.
    expect(liveContentOrdinal('s1', PROMPT_BATCH_ORIGIN.HUMAN, 'deploy')).toBe(1);
    // A different origin with the same text is a separate sequence.
    expect(liveContentOrdinal('s1', PROMPT_BATCH_ORIGIN.SYSTEM, 'deploy')).toBe(0);
  });
});

describe('replaceRecoveredBatchUserPrompt — content_hash stamping', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(teardownTestDb);
  beforeEach(() => {
    cleanTestDb();
    seedSession({ id: 's1' });
  });

  it('stamps the ordinal-0 hash so a re-mine of the first turn dedups', () => {
    const sentinel = insertBatchStateless({
      session_id: 's1', user_prompt: RECOVERED_BATCH_SENTINEL, kind: 'recovered', created_at: nowSec(),
    });
    expect(sentinel.row.content_hash).toBeNull();

    expect(replaceRecoveredBatchUserPrompt(sentinel.row.id, 'first turn', PROMPT_BATCH_ORIGIN.HUMAN)).toBe(true);
    const stamped = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE })[0]!;
    expect(stamped.content_hash).toBe(
      promptBatchContentHash({ sessionId: 's1', origin: PROMPT_BATCH_ORIGIN.HUMAN, ordinal: 0, userPrompt: 'first turn' }),
    );

    // A subsequent re-mine of that same turn (ordinal 0) dedups against it.
    const remined = insertBatchStateless({ session_id: 's1', user_prompt: 'first turn', ordinal: 0, created_at: nowSec() });
    expect(remined.created).toBe(false);
    expect(batchCount('s1')).toBe(1);
  });

  it('does not throw when the ordinal-0 hash is already taken — leaves content_hash NULL', () => {
    // A pre-existing turn already owns the ordinal-0 hash for "dup text".
    insertBatchStateless({ session_id: 's1', user_prompt: 'dup text', ordinal: 0, created_at: nowSec() });
    const sentinel = insertBatchStateless({
      session_id: 's1', user_prompt: RECOVERED_BATCH_SENTINEL, kind: 'recovered', created_at: nowSec(),
    });

    expect(() => replaceRecoveredBatchUserPrompt(sentinel.row.id, 'dup text', PROMPT_BATCH_ORIGIN.HUMAN)).not.toThrow();
    const replaced = listBatchesBySession('s1', { scope: ALL_PROJECTS_SCOPE }).find((b) => b.id === sentinel.row.id)!;
    expect(replaced.user_prompt).toBe('dup text');
    expect(replaced.content_hash).toBeNull();
  });
});
