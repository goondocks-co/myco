/**
 * Tests for dual-mode search query helpers.
 *
 * Covers:
 * - fullTextSearch: FTS matching, empty results, type filter, limit
 * - semanticSearch: vector similarity, empty results, type filter, limit
 *
 * Each test initializes an in-memory PGlite instance, creates the schema,
 * exercises the search function, and tears down the database.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initDatabase, closeDatabase, getDatabase } from '@myco/db/client.js';
import { createSchema, EMBEDDING_DIMENSIONS } from '@myco/db/schema.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { insertActivity } from '@myco/db/queries/activities.js';
import { setEmbedding } from '@myco/db/queries/embeddings.js';
import { semanticSearch, fullTextSearch } from '@myco/db/queries/search.js';
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

/**
 * Create a synthetic unit vector of EMBEDDING_DIMENSIONS length.
 *
 * Places a 1.0 at `hotIndex` and 0.0 everywhere else.
 * Identical hot indices yield cosine similarity = 1.0;
 * orthogonal indices yield cosine similarity = 0.0.
 */
function makeUnitVector(hotIndex: number): number[] {
  const vec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vec[hotIndex] = 1.0;
  return vec;
}

/** Insert a curator directly and return its id. */
async function createCurator(id: string): Promise<string> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO curators (id, name, created_at) VALUES ($1, $2, $3)`,
    [id, `curator-${id}`, now],
  );
  return id;
}

/** Insert a spore with an embedding vector. */
async function insertSporeWithEmbedding(
  curatorId: string,
  id: string,
  content: string,
  hotIndex: number,
): Promise<void> {
  const db = getDatabase();
  const now = epochNow();
  await db.query(
    `INSERT INTO spores (id, curator_id, observation_type, content, created_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, curatorId, 'gotcha', content, now],
  );
  await setEmbedding('spores', id, makeUnitVector(hotIndex));
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('fullTextSearch', () => {
  let sessionId: string;

  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const session = makeSession();
    await upsertSession(session);
    sessionId = session.id;
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('finds matching prompt batches by keyword in user_prompt', async () => {
    await insertBatch(makeBatch(sessionId, {
      user_prompt: 'How does pgvector cosine similarity work?',
      prompt_number: 1,
    }));
    await insertBatch(makeBatch(sessionId, {
      user_prompt: 'Tell me about TypeScript generics',
      prompt_number: 2,
    }));

    const results = await fullTextSearch('pgvector');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const batchResult = results.find((r) => r.type === 'prompt_batch');
    expect(batchResult).toBeDefined();
    expect(batchResult!.preview).toContain('pgvector');
  });

  it('returns empty array for non-matching query', async () => {
    await insertBatch(makeBatch(sessionId, {
      user_prompt: 'How does TypeScript work?',
      prompt_number: 1,
    }));

    const results = await fullTextSearch('zzznomatchzzzxxx');

    expect(results).toEqual([]);
  });

  it('finds matching activities by tool_name', async () => {
    await insertActivity(makeActivity(sessionId, {
      tool_name: 'WebSearch',
      tool_input: 'latest Postgres changelog',
    }));
    await insertActivity(makeActivity(sessionId, {
      tool_name: 'Read',
      tool_input: 'some file content',
    }));

    const results = await fullTextSearch('WebSearch');

    expect(results.length).toBeGreaterThanOrEqual(1);
    const activityResult = results.find((r) => r.type === 'activity');
    expect(activityResult).toBeDefined();
    expect(activityResult!.title).toBe('WebSearch');
  });

  it('finds activities by keyword in tool_input', async () => {
    await insertActivity(makeActivity(sessionId, {
      tool_name: 'Bash',
      tool_input: 'npx vitest run tests/search',
    }));

    const results = await fullTextSearch('vitest');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('activity');
  });

  it('finds activities by keyword in file_path', async () => {
    // Use a single-word file name — path separators cause tsvector to treat
    // the full path as one token, so we test with a whole-token match.
    await insertActivity(makeActivity(sessionId, {
      tool_name: 'Read',
      file_path: 'searchbar',
    }));

    const results = await fullTextSearch('searchbar');

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('activity');
  });

  it('respects the limit option', async () => {
    // Insert 5 batches all matching 'refactor'
    for (let i = 0; i < 5; i++) {
      await insertBatch(makeBatch(sessionId, {
        user_prompt: `How do I refactor module ${i}?`,
        prompt_number: i + 1,
      }));
    }

    const results = await fullTextSearch('refactor', { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns empty array when tables have no search_vector data', async () => {
    // Insert session but no batches or activities
    const results = await fullTextSearch('anything');
    expect(results).toEqual([]);
  });
});

describe('semanticSearch', () => {
  let sessionId: string;
  let curatorId: string;

  beforeEach(async () => {
    const db = await initDatabase();
    await createSchema(db);

    const session = makeSession();
    await upsertSession(session);
    sessionId = session.id;

    curatorId = await createCurator('curator-search-test');
  });

  afterEach(async () => {
    await closeDatabase();
  });

  it('returns session with identical embedding first', async () => {
    const now = epochNow();
    const s1 = makeSession({ id: 'sess-close', created_at: now, started_at: now });
    const s2 = makeSession({ id: 'sess-far', created_at: now + 1, started_at: now + 1 });
    await upsertSession(s1);
    await upsertSession(s2);

    // s1: identical to query vector (hotIndex 0)
    await setEmbedding('sessions', 'sess-close', makeUnitVector(0));
    // s2: orthogonal to query vector
    await setEmbedding('sessions', 'sess-far', makeUnitVector(1));

    const results = await semanticSearch(makeUnitVector(0));

    // sess-close should appear; sess-far may be filtered out by threshold
    const closeResult = results.find((r) => r.id === 'sess-close');
    expect(closeResult).toBeDefined();
    expect(closeResult!.type).toBe('session');
    expect(closeResult!.score).toBeGreaterThan(0.9);
  });

  it('returns empty array when no embeddings exist', async () => {
    // Session exists but has no embedding
    await upsertSession(makeSession());

    const results = await semanticSearch(makeUnitVector(0));

    expect(results).toEqual([]);
  });

  it('filters out results below similarity threshold', async () => {
    const now = epochNow();
    const s1 = makeSession({ id: 'sess-thresh', created_at: now, started_at: now });
    await upsertSession(s1);

    // Orthogonal vector — similarity will be 0, below any positive threshold
    await setEmbedding('sessions', 'sess-thresh', makeUnitVector(1));

    // Query with a completely different direction (hotIndex 0 vs embedding hotIndex 1)
    const results = await semanticSearch(makeUnitVector(0));

    // Orthogonal vectors have similarity = 0 — should be filtered by threshold
    const threshResult = results.find((r) => r.id === 'sess-thresh');
    expect(threshResult).toBeUndefined();
  });

  it('searches across multiple table types (sessions and spores)', async () => {
    const now = epochNow();
    const session = makeSession({ id: 'sess-multi', created_at: now, started_at: now });
    await upsertSession(session);

    // Both use hotIndex 0 — both should match a query with hotIndex 0
    await setEmbedding('sessions', 'sess-multi', makeUnitVector(0));
    await insertSporeWithEmbedding(curatorId, 'spore-multi', 'A relevant gotcha', 0);

    const results = await semanticSearch(makeUnitVector(0));

    const types = new Set(results.map((r) => r.type));
    expect(types.has('session')).toBe(true);
    expect(types.has('spore')).toBe(true);
  });

  it('respects the limit option', async () => {
    const now = epochNow();

    // Insert 5 sessions all with hotIndex 0 (identical to query)
    for (let i = 0; i < 5; i++) {
      const s = makeSession({ id: `sess-lim-${i}`, created_at: now + i, started_at: now + i });
      await upsertSession(s);
      await setEmbedding('sessions', `sess-lim-${i}`, makeUnitVector(0));
    }

    const results = await semanticSearch(makeUnitVector(0), { limit: 2 });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('returns results ordered by score descending', async () => {
    const now = epochNow();
    const s1 = makeSession({ id: 'sess-high', created_at: now, started_at: now });
    const s2 = makeSession({ id: 'sess-low', created_at: now + 1, started_at: now + 1 });
    await upsertSession(s1);
    await upsertSession(s2);

    // s1: identical to query (similarity ~ 1.0)
    await setEmbedding('sessions', 'sess-high', makeUnitVector(0));

    // s2: partial match — mix of hotIndex 0 and 1
    const mixVec = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
    mixVec[0] = 0.7;
    mixVec[1] = 0.7;
    await setEmbedding('sessions', 'sess-low', mixVec);

    const results = await semanticSearch(makeUnitVector(0));

    expect(results.length).toBeGreaterThanOrEqual(2);
    // Both should appear; sess-high must rank before sess-low
    const highIdx = results.findIndex((r) => r.id === 'sess-high');
    const lowIdx = results.findIndex((r) => r.id === 'sess-low');
    expect(highIdx).toBeLessThan(lowIdx);
  });

  it('includes session_id for spore results', async () => {
    const now = epochNow();
    const session = makeSession({ id: 'sess-spore-sid', created_at: now, started_at: now });
    await upsertSession(session);

    const db = getDatabase();
    await db.query(
      `INSERT INTO spores (id, curator_id, session_id, observation_type, content, created_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['spore-with-sid', curatorId, 'sess-spore-sid', 'decision', 'Use PGlite for embedded Postgres', now],
    );
    await setEmbedding('spores', 'spore-with-sid', makeUnitVector(0));

    const results = await semanticSearch(makeUnitVector(0));

    const sporeResult = results.find((r) => r.id === 'spore-with-sid');
    expect(sporeResult).toBeDefined();
    expect(sporeResult!.session_id).toBe('sess-spore-sid');
  });
});
