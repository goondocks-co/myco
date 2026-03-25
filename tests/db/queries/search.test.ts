/**
 * Tests for full-text search query helpers.
 *
 * Covers:
 * - fullTextSearch: FTS5 matching, empty results, type filter, limit
 *
 * Semantic search (vector similarity) is handled by the external VectorStore —
 * not tested here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { insertActivity } from '@myco/db/queries/activities.js';
import { fullTextSearch } from '@myco/db/queries/search.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';
import type { ActivityInsert } from '@myco/db/queries/activities.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Epoch seconds helper. */
const epochNow = () => Math.floor(Date.now() / 1000);

/** Factory for minimal valid session data. */
function makeSession(overrides: Partial<SessionInsert> = {}): SessionInsert {
  const now = epochNow();
  return {
    id: `sess-${Math.random().toString(36).slice(2, 8)}`,
    agent: 'claude-code',
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid batch data (requires a session_id). */
function makeBatch(sessionId: string, overrides: Partial<BatchInsert> = {}): BatchInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    started_at: now,
    created_at: now,
    ...overrides,
  };
}

/** Factory for minimal valid activity data (requires a session_id). */
function makeActivity(sessionId: string, overrides: Partial<ActivityInsert> = {}): ActivityInsert {
  const now = epochNow();
  return {
    session_id: sessionId,
    tool_name: 'Bash',
    timestamp: now,
    created_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fullTextSearch', () => {
  let sessionId: string;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();

    const session = makeSession();
    upsertSession(session);
    sessionId = session.id;
  });

  it('finds matching prompt batches by keyword in user_prompt', () => {
    insertBatch(makeBatch(sessionId, {
      user_prompt: 'How does pgvector cosine similarity work?',
      prompt_number: 1,
    }));
    insertBatch(makeBatch(sessionId, {
      user_prompt: 'Tell me about TypeScript generics',
      prompt_number: 2,
    }));

    const results = fullTextSearch('pgvector');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const batchResult = results.find((r) => r.type === 'prompt_batch');
    expect(batchResult).toBeDefined();
    expect(batchResult!.preview).toContain('pgvector');
  });

  it('returns empty array for non-matching query', () => {
    insertBatch(makeBatch(sessionId, {
      user_prompt: 'How does TypeScript work?',
      prompt_number: 1,
    }));

    const results = fullTextSearch('zzznomatchzzzxxx');

    expect(results).toEqual([]);
  });

  it('finds matching activities by tool_name', () => {
    insertActivity(makeActivity(sessionId, {
      tool_name: 'WebSearch',
      tool_input: 'latest Postgres changelog',
    }));
    insertActivity(makeActivity(sessionId, {
      tool_name: 'Read',
      tool_input: 'some file content',
    }));

    const results = fullTextSearch('WebSearch');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const activityResult = results.find((r) => r.type === 'activity');
    expect(activityResult).toBeDefined();
    expect(activityResult!.title).toBe('WebSearch');
  });

  it('finds activities by keyword in tool_input', () => {
    insertActivity(makeActivity(sessionId, {
      tool_name: 'Bash',
      tool_input: 'npx vitest run tests/search',
    }));

    const results = fullTextSearch('vitest');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('activity');
  });

  it('finds activities by keyword in file_path', () => {
    insertActivity(makeActivity(sessionId, {
      tool_name: 'Read',
      file_path: 'searchbar',
    }));

    const results = fullTextSearch('searchbar');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('activity');
  });

  it('respects the limit option', () => {
    // Insert 5 batches all matching 'refactor'
    for (let i = 0; i < 5; i++) {
      insertBatch(makeBatch(sessionId, {
        user_prompt: `How do I refactor module ${i}?`,
        prompt_number: i + 1,
      }));
    }

    const results = fullTextSearch('refactor', { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array when tables have no FTS data', () => {
    // Insert session but no batches or activities
    const results = fullTextSearch('anything');
    expect(results).toEqual([]);
  });
});
