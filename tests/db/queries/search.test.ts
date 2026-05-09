/**
 * Tests for full-text search query helpers.
 *
 * Covers:
 * - fullTextSearch: FTS5 matching, empty results, type filter, limit
 *
 * Semantic search (vector similarity) is handled by the external VectorStore —
 * not tested here.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { insertActivity } from '@myco/db/queries/activities.js';
import { fullTextSearch, hydrateSearchResults } from '@myco/db/queries/search.js';
import { getDatabase } from '@myco/db/client.js';
import type { SessionInsert } from '@myco/db/queries/sessions.js';
import type { BatchInsert } from '@myco/db/queries/batches.js';
import type { ActivityInsert } from '@myco/db/queries/activities.js';
import type { VectorSearchResult } from '@myco/daemon/embedding/types.js';
import { ALL_PROJECTS_SCOPE, GLOBAL_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

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

    const results = fullTextSearch('pgvector', { scope: ALL_PROJECTS_SCOPE });

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

    const results = fullTextSearch('zzznomatchzzzxxx', { scope: ALL_PROJECTS_SCOPE });

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

    const results = fullTextSearch('WebSearch', { scope: ALL_PROJECTS_SCOPE });

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

    const results = fullTextSearch('vitest', { scope: ALL_PROJECTS_SCOPE });

    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].type).toBe('activity');
  });

  it('finds activities by keyword in file_path', () => {
    insertActivity(makeActivity(sessionId, {
      tool_name: 'Read',
      file_path: 'searchbar',
    }));

    const results = fullTextSearch('searchbar', { scope: ALL_PROJECTS_SCOPE });

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

    const results = fullTextSearch('refactor', { limit: 2, scope: ALL_PROJECTS_SCOPE });

    expect(results.length).toBeLessThanOrEqual(2);
  });

  it('filters FTS results by project_id across batches and activities', () => {
    const sessionA = makeSession({ id: 'sess-project-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const sessionB = makeSession({ id: 'sess-project-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
    upsertSession(sessionA);
    upsertSession(sessionB);
    insertBatch(makeBatch(sessionA.id, { user_prompt: 'shared needle from batch a' }));
    insertBatch(makeBatch(sessionB.id, { user_prompt: 'shared needle from batch b' }));
    insertActivity(makeActivity(sessionA.id, { tool_name: 'Read', tool_input: 'shared needle from activity a' }));
    insertActivity(makeActivity(sessionB.id, { tool_name: 'Read', tool_input: 'shared needle from activity b' }));

    const results = fullTextSearch('needle',{ scope: projectScope('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId)});

    expect(results).toHaveLength(2);
    expect(results.every((result) => result.preview.includes('activity a') || result.preview.includes('batch a'))).toBe(true);
  });

  it('returns empty array when tables have no FTS data', () => {
    // Insert session but no batches or activities
    const results = fullTextSearch('anything', { scope: ALL_PROJECTS_SCOPE });
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// hydrateSearchResults — vector → SearchResult hydration
// ---------------------------------------------------------------------------

/** Insert a canopy_entries row directly. The dedicated public helper lives
 *  inside the scanner module and pulls in pieces we don't need here. */
function insertCanopyEntry(row: {
  project_id: string;
  path: string;
  llm_description?: string | null;
  language?: string | null;
}): void {
  const now = epochNow();
  getDatabase().prepare(
    `INSERT INTO canopy_entries (
       project_id, machine_id, path, content_hash, size_bytes, token_estimate,
       line_count, language, mechanical_updated_at, llm_description, llm_updated_at
     ) VALUES (?, 'local', ?, 'h', 0, 0, 0, ?, ?, ?, ?)`,
  ).run(
    row.project_id,
    row.path,
    row.language ?? null,
    now,
    row.llm_description ?? null,
    row.llm_description ? now : null,
  );
}

describe('hydrateSearchResults', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('hydrates canopy_entries vector hits using the synthesized id', () => {
    insertCanopyEntry({
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'packages/myco/src/canopy/scanner/index.ts',
      llm_description: 'Walks the project tree to harvest canopy entries.',
      language: 'typescript',
    });

    const vectorResults: VectorSearchResult[] = [
      {
        id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:packages/myco/src/canopy/scanner/index.ts',
        namespace: 'canopy_entries',
        similarity: 0.91,
        metadata: {},
      },
    ];

    const hydrated = hydrateSearchResults(vectorResults, { scope: ALL_PROJECTS_SCOPE });

    expect(hydrated).toHaveLength(1);
    const hit = hydrated[0];
    expect(hit.type).toBe('canopy');
    expect(hit.id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:packages/myco/src/canopy/scanner/index.ts');
    expect(hit.title).toBe('packages/myco/src/canopy/scanner/index.ts');
    expect(hit.preview).toBe('Walks the project tree to harvest canopy entries.');
    expect(hit.score).toBeCloseTo(0.91, 5);
    expect(hit.path).toBe('packages/myco/src/canopy/scanner/index.ts');
    expect(hit.project_id).toBe('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    expect(hit.language).toBe('typescript');
    expect(hit.llm_description).toBe('Walks the project tree to harvest canopy entries.');
  });

  it('hydrates a mixed batch of session and canopy hits in one call', () => {
    const session = makeSession({ title: 'How embeddings reconcile' });
    upsertSession(session);

    insertCanopyEntry({
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'src/foo.ts',
      llm_description: 'Foo module description.',
      language: 'typescript',
    });

    const vectorResults: VectorSearchResult[] = [
      {
        id: session.id,
        namespace: 'sessions',
        similarity: 0.85,
        metadata: {},
      },
      {
        id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:src/foo.ts',
        namespace: 'canopy_entries',
        similarity: 0.72,
        metadata: {},
      },
    ];

    const hydrated = hydrateSearchResults(vectorResults, { scope: ALL_PROJECTS_SCOPE });

    expect(hydrated).toHaveLength(2);
    const types = hydrated.map((r) => r.type).sort();
    expect(types).toEqual(['canopy', 'session']);
    // Order is by score DESC; session 0.85 > canopy 0.72
    expect(hydrated[0].type).toBe('session');
    expect(hydrated[1].type).toBe('canopy');
    expect(hydrated[1].path).toBe('src/foo.ts');
  });

  it('drops malformed canopy ids without throwing', () => {
    insertCanopyEntry({
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'src/foo.ts',
      llm_description: 'Real row.',
      language: 'typescript',
    });

    const vectorResults: VectorSearchResult[] = [
      // Missing colon — malformed
      { id: 'no-colon-here', namespace: 'canopy_entries', similarity: 0.9, metadata: {} },
      // Real id
      { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:src/foo.ts', namespace: 'canopy_entries', similarity: 0.8, metadata: {} },
    ];

    const hydrated = hydrateSearchResults(vectorResults, { scope: ALL_PROJECTS_SCOPE });
    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].path).toBe('src/foo.ts');
  });

  it('filters hydrated vector hits by project_id', () => {
    const sessionA = makeSession({ id: 'sess-vector-a', project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', title: 'A session' });
    const sessionB = makeSession({ id: 'sess-vector-b', project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', title: 'B session' });
    upsertSession(sessionA);
    upsertSession(sessionB);
    insertCanopyEntry({
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: 'src/a.ts',
      llm_description: 'Project A file.',
    });
    insertCanopyEntry({
      project_id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      path: 'src/b.ts',
      llm_description: 'Project B file.',
    });

    const hydrated = hydrateSearchResults([
      { id: sessionA.id, namespace: 'sessions', similarity: 0.9, metadata: {} },
      { id: sessionB.id, namespace: 'sessions', similarity: 0.8, metadata: {} },
      { id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:src/a.ts', namespace: 'canopy_entries', similarity: 0.7, metadata: {} },
      { id: 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb:src/b.ts', namespace: 'canopy_entries', similarity: 0.6, metadata: {} },
    ],{ scope: projectScope('proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId)});

    expect(hydrated.map((result) => result.id)).toEqual([sessionA.id, 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:src/a.ts']);
  });

  it('keeps canopy vector hits broad for legacy null project scope', () => {
    insertCanopyEntry({
      project_id: 'legacy-canopy-project',
      path: 'src/legacy.ts',
      llm_description: 'Legacy-context canopy file.',
    });

    const hydrated = hydrateSearchResults([
      {
        id: 'legacy-canopy-project:src/legacy.ts',
        namespace: 'canopy_entries',
        similarity: 0.9,
        metadata: {},
      },
    ],{ scope: ALL_PROJECTS_SCOPE});

    expect(hydrated.map((result) => result.id)).toEqual(['legacy-canopy-project:src/legacy.ts']);
  });
});
