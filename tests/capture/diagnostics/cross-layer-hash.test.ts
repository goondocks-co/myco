import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatchStateless } from '@myco/db/queries/batches.js';
import { sha256Hex } from '@myco/capture/diagnostics/hash.js';
import { skeletonizeTranscript } from '@myco/capture/diagnostics/skeletonize.js';
import { collectSessionRows } from '@myco/capture/diagnostics/collect-vault.js';

beforeEach(() => {
  setupTestDb();
  cleanTestDb();
});
afterAll(() => teardownTestDb());

/**
 * The analyze-debug-bundle skill's entire Step-3 correlation mechanism rests
 * on `transcripts/<id>.skeleton.jsonl#text_sha256` (skeletonize.ts:66) and
 * `sessions.jsonl`'s `prompt_batches` rows' `user_prompt_sha256`
 * (collect-vault.ts:106) hashing to the same value for the same prompt --
 * both hash `text.trim()`. A prompt with leading/trailing whitespace is the
 * case that would catch either side drifting (untrimmed, JSON-stringified,
 * or renamed) since a naive implementation would hash the raw text and
 * silently break the join key.
 */
describe('cross-layer hash comparability', () => {
  test('skeletonizeTranscript text_sha256 equals collectSessionRows user_prompt_sha256 for the same prompt text', () => {
    const db = getDatabase();
    const prompt = '  what is going on with capture here?  \n';

    upsertSession({ id: 's1', agent: 'claude-code', started_at: 1000, created_at: 1000 });
    insertBatchStateless({ session_id: 's1', created_at: 1001, started_at: 1001, user_prompt: prompt });

    const transcriptLine = JSON.stringify({
      type: 'user',
      uuid: 'u1',
      parentUuid: null,
      timestamp: '2026-08-12T10:00:00Z',
      message: { role: 'user', content: prompt },
    });
    const [skeletonLineRaw] = skeletonizeTranscript(transcriptLine).trim().split('\n');
    const skeletonLine = JSON.parse(skeletonLineRaw!) as { text_sha256: string };

    const jsonl = collectSessionRows(db, { since: 0, until: 2000 }, false);
    const batchRow = jsonl
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .find((row) => row.table === 'prompt_batches').row as { user_prompt_sha256: string };

    const expected = sha256Hex(prompt.trim());
    expect(skeletonLine.text_sha256).toBe(expected);
    expect(batchRow.user_prompt_sha256).toBe(expected);
    expect(skeletonLine.text_sha256).toBe(batchRow.user_prompt_sha256);
  });
});
