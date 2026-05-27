import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { seedSession } from '../helpers/sessions.js';
import { syncTranscriptPromptBatches } from '@myco/daemon/event-handlers.js';
import { listBatchesBySession } from '@myco/db/queries/batches.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

describe('syncTranscriptPromptBatches', () => {
  beforeAll(() => setupTestDb());
  afterAll(() => teardownTestDb());
  beforeEach(() => cleanTestDb());

  it('creates one batch per new prompt on first sync', () => {
    seedSession({ id: 's-sync-1', agent: 'antigravity' });
    const result = syncTranscriptPromptBatches('s-sync-1', ['first prompt', 'second prompt']);
    expect(result).toEqual({ createdBatchCount: 2, existingBatchCount: 0 });
    const batches = listBatchesBySession('s-sync-1', { scope: ALL_PROJECTS_SCOPE });
    expect(batches).toHaveLength(2);
    expect(batches[0]!.user_prompt).toBe('first prompt');
    expect(batches[1]!.user_prompt).toBe('second prompt');
  });

  it('is idempotent — second sync with the same prompts creates no new batches', () => {
    seedSession({ id: 's-sync-idem', agent: 'antigravity' });
    syncTranscriptPromptBatches('s-sync-idem', ['p1', 'p2']);
    const second = syncTranscriptPromptBatches('s-sync-idem', ['p1', 'p2']);
    expect(second).toEqual({ createdBatchCount: 0, existingBatchCount: 2 });
    expect(listBatchesBySession('s-sync-idem', { scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
  });

  it('only creates batches for the new tail when prompts grow', () => {
    seedSession({ id: 's-sync-tail', agent: 'antigravity' });
    syncTranscriptPromptBatches('s-sync-tail', ['p1']);
    const result = syncTranscriptPromptBatches('s-sync-tail', ['p1', 'p2', 'p3']);
    expect(result).toEqual({ createdBatchCount: 2, existingBatchCount: 1 });
    const batches = listBatchesBySession('s-sync-tail', { scope: ALL_PROJECTS_SCOPE });
    expect(batches.map((b) => b.user_prompt)).toEqual(['p1', 'p2', 'p3']);
  });

  it('skips empty / whitespace-only prompts in the new tail', () => {
    seedSession({ id: 's-sync-blank', agent: 'antigravity' });
    const result = syncTranscriptPromptBatches('s-sync-blank', ['real', '', '   ', 'also real']);
    expect(result.createdBatchCount).toBe(2);
    const batches = listBatchesBySession('s-sync-blank', { scope: ALL_PROJECTS_SCOPE });
    expect(batches.map((b) => b.user_prompt)).toEqual(['real', 'also real']);
  });

  it('returns zero counts when called with an empty prompt list and no prior batches', () => {
    seedSession({ id: 's-sync-empty', agent: 'antigravity' });
    const result = syncTranscriptPromptBatches('s-sync-empty', []);
    expect(result).toEqual({ createdBatchCount: 0, existingBatchCount: 0 });
    expect(listBatchesBySession('s-sync-empty', { scope: ALL_PROJECTS_SCOPE })).toHaveLength(0);
  });
});
