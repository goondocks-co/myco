/**
 * Tests for skill lifecycle API route handlers.
 *
 * Handlers are tested directly (no HTTP) against an in-memory SQLite database.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertCandidate } from '@myco/db/queries/skill-candidates.js';
import { insertSkillRecord } from '@myco/db/queries/skill-records.js';
import { insertLineage } from '@myco/db/queries/skill-lineage.js';
import { insertSkillUsage } from '@myco/db/queries/skill-usage.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import type { CandidateInsert } from '@myco/db/queries/skill-candidates.js';
import type { SkillRecordInsert } from '@myco/db/queries/skill-records.js';
import type { RouteRequest } from '@myco/daemon/router';
import {
  handleListCandidates,
  handleGetCandidate,
  handleUpdateCandidate,
  handleListSkillRecords,
  handleGetSkillRecord,
} from '@myco/daemon/api/skills';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const epochNow = () => Math.floor(Date.now() / 1000);

/** Build a minimal RouteRequest. */
function makeReq(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    params: {},
    query: {},
    body: undefined,
    pathname: '/api/skill-candidates',
    ...overrides,
  };
}

/** Build a minimal valid CandidateInsert. */
function makeCandidate(overrides: Partial<CandidateInsert> = {}): CandidateInsert {
  const now = epochNow();
  const suffix = Math.random().toString(36).slice(2, 8);
  return {
    id: `cand-${suffix}`,
    agent_id: 'agent-test',
    topic: 'Use Vitest for all tests',
    rationale: 'Vitest is the preferred test runner in this codebase',
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

/** Build a minimal valid SkillRecordInsert. */
function makeSkillRecord(overrides: Partial<SkillRecordInsert> = {}): SkillRecordInsert {
  const now = epochNow();
  const suffix = Math.random().toString(36).slice(2, 8);
  const name = `skill-api-test-${suffix}`;
  return {
    id: `skill-${suffix}`,
    agent_id: 'agent-test',
    name,
    display_name: 'Test Skill',
    description: 'A skill for API tests',
    path: `.myco/skills/${name}.md`,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => { setupTestDb(); });
afterAll(() => { teardownTestDb(); });
beforeEach(() => {
  cleanTestDb();
  registerAgent({
    id: 'agent-test',
    name: 'Test Agent',
    created_at: epochNow(),
  });
});

// ---------------------------------------------------------------------------
// handleListCandidates
// ---------------------------------------------------------------------------

describe('handleListCandidates', () => {
  it('returns empty list when no candidates exist', async () => {
    const result = await handleListCandidates(makeReq());

    expect(result.status).toBe(200);
    const body = result.body as { candidates: unknown[]; total: number };
    expect(body.candidates).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns all candidates with correct total', async () => {
    insertCandidate(makeCandidate({ id: 'cand-1' }));
    insertCandidate(makeCandidate({ id: 'cand-2' }));

    const result = await handleListCandidates(makeReq());

    expect(result.status).toBe(200);
    const body = result.body as { candidates: unknown[]; total: number };
    expect(body.candidates).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('filters by status query param', async () => {
    insertCandidate(makeCandidate({ id: 'cand-identified', status: 'identified' }));
    insertCandidate(makeCandidate({ id: 'cand-promoted', status: 'promoted' }));

    const result = await handleListCandidates(makeReq({ query: { status: 'identified' } }));

    expect(result.status).toBe(200);
    const body = result.body as { candidates: Array<{ id: string }>; total: number };
    expect(body.candidates).toHaveLength(1);
    expect(body.candidates[0].id).toBe('cand-identified');
    expect(body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleGetCandidate
// ---------------------------------------------------------------------------

describe('handleGetCandidate', () => {
  it('returns candidate when found', async () => {
    insertCandidate(makeCandidate({ id: 'cand-abc', topic: 'Use typed errors' }));

    const result = await handleGetCandidate(makeReq({ params: { id: 'cand-abc' } }));

    expect(result.status).toBe(200);
    const body = result.body as { candidate: { id: string; topic: string } };
    expect(body.candidate.id).toBe('cand-abc');
    expect(body.candidate.topic).toBe('Use typed errors');
  });

  it('returns 404 for unknown id', async () => {
    const result = await handleGetCandidate(makeReq({ params: { id: 'does-not-exist' } }));

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch('does-not-exist');
  });
});

// ---------------------------------------------------------------------------
// handleUpdateCandidate
// ---------------------------------------------------------------------------

describe('handleListCandidates multi-status filter', () => {
  it('returns candidates matching any of the comma-separated statuses', async () => {
    insertCandidate(makeCandidate({ id: 'ml-id', status: 'identified' }));
    insertCandidate(makeCandidate({ id: 'ml-ap', status: 'approved' }));
    insertCandidate(makeCandidate({ id: 'ml-gn', status: 'generated' }));
    insertCandidate(makeCandidate({ id: 'ml-dm', status: 'dismissed' }));

    const result = await handleListCandidates(
      makeReq({ query: { status: 'approved,generated' } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      candidates: Array<{ id: string; status: string }>;
      total: number;
    };
    const ids = body.candidates.map((c) => c.id).sort();
    expect(ids).toEqual(['ml-ap', 'ml-gn']);
    expect(body.total).toBe(2);
  });

  it('trims whitespace between values', async () => {
    insertCandidate(makeCandidate({ id: 'ws-ap', status: 'approved' }));
    insertCandidate(makeCandidate({ id: 'ws-gn', status: 'generated' }));

    const result = await handleListCandidates(
      makeReq({ query: { status: ' approved , generated ' } }),
    );
    const body = result.body as { total: number };
    expect(body.total).toBe(2);
  });

  it('still supports single-status filter (no comma)', async () => {
    insertCandidate(makeCandidate({ id: 'sg-ap', status: 'approved' }));
    insertCandidate(makeCandidate({ id: 'sg-dm', status: 'dismissed' }));

    const result = await handleListCandidates(
      makeReq({ query: { status: 'approved' } }),
    );
    const body = result.body as { total: number };
    expect(body.total).toBe(1);
  });
});

describe('handleUpdateCandidate', () => {
  it('updates the candidate status and returns updated row', async () => {
    insertCandidate(makeCandidate({ id: 'cand-update', status: 'identified' }));

    const result = await handleUpdateCandidate(
      makeReq({ params: { id: 'cand-update' }, body: { status: 'approved' } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as { candidate: { id: string; status: string } };
    expect(body.candidate.id).toBe('cand-update');
    expect(body.candidate.status).toBe('approved');
  });

  it('returns 400 when body is missing', async () => {
    insertCandidate(makeCandidate({ id: 'cand-nobody' }));

    const result = await handleUpdateCandidate(
      makeReq({ params: { id: 'cand-nobody' }, body: undefined }),
    );

    expect(result.status).toBe(400);
  });

  it('returns 404 for unknown candidate', async () => {
    const result = await handleUpdateCandidate(
      makeReq({ params: { id: 'ghost' }, body: { status: 'approved' } }),
    );

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch('ghost');
  });

  // Privilege separation: REST is the human-driven surface (UI + MCP). It
  // accepts 'identified', 'approved', and 'dismissed' but rejects
  // 'generated' — the only legitimate writer of that status is the internal
  // vault_finalize_skill tool which calls updateCandidate directly.
  describe('status value guard', () => {
    it('rejects status=generated with 400', async () => {
      insertCandidate(makeCandidate({ id: 'cand-gen-guard', status: 'approved' }));

      const result = await handleUpdateCandidate(
        makeReq({ params: { id: 'cand-gen-guard' }, body: { status: 'generated' } }),
      );

      expect(result.status).toBe(400);
      expect((result.body as { error: string }).error).toMatch(/generated/i);
    });

    it('rejects an arbitrary unknown status value with 400', async () => {
      insertCandidate(makeCandidate({ id: 'cand-unknown-guard' }));

      const result = await handleUpdateCandidate(
        makeReq({ params: { id: 'cand-unknown-guard' }, body: { status: 'promoted' } }),
      );

      expect(result.status).toBe(400);
    });

    it('accepts status=identified', async () => {
      insertCandidate(makeCandidate({ id: 'cand-ident', status: 'approved' }));

      const result = await handleUpdateCandidate(
        makeReq({ params: { id: 'cand-ident' }, body: { status: 'identified' } }),
      );

      expect(result.status).toBe(200);
    });

    it('accepts status=dismissed', async () => {
      insertCandidate(makeCandidate({ id: 'cand-dism', status: 'identified' }));

      const result = await handleUpdateCandidate(
        makeReq({ params: { id: 'cand-dism' }, body: { status: 'dismissed' } }),
      );

      expect(result.status).toBe(200);
    });
  });
});

// ---------------------------------------------------------------------------
// handleListSkillRecords
// ---------------------------------------------------------------------------

describe('handleListSkillRecords', () => {
  it('returns empty list when no records exist', async () => {
    const result = await handleListSkillRecords(makeReq({ pathname: '/api/skill-records' }));

    expect(result.status).toBe(200);
    const body = result.body as { records: unknown[]; total: number };
    expect(body.records).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns all skill records with correct total', async () => {
    insertSkillRecord(makeSkillRecord());
    insertSkillRecord(makeSkillRecord());

    const result = await handleListSkillRecords(makeReq({ pathname: '/api/skill-records' }));

    expect(result.status).toBe(200);
    const body = result.body as { records: unknown[]; total: number };
    expect(body.records).toHaveLength(2);
    expect(body.total).toBe(2);
  });

  it('filters by status query param', async () => {
    insertSkillRecord(makeSkillRecord({ id: 'skill-active', name: 'skill-a', status: 'active' }));
    insertSkillRecord(makeSkillRecord({ id: 'skill-archived', name: 'skill-b', status: 'archived' }));

    const result = await handleListSkillRecords(
      makeReq({ pathname: '/api/skill-records', query: { status: 'active' } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as { records: Array<{ id: string }>; total: number };
    expect(body.records).toHaveLength(1);
    expect(body.records[0].id).toBe('skill-active');
    expect(body.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// handleGetSkillRecord
// ---------------------------------------------------------------------------

describe('handleGetSkillRecord', () => {
  it('returns skill record with lineage and usage_total by id', async () => {
    const record = insertSkillRecord(makeSkillRecord({ id: 'skill-get', name: 'skill-get-test' }));
    const now = epochNow();

    upsertSession({
      id: 'fake-session',
      agent: 'claude-code',
      started_at: now,
      created_at: now,
    });
    insertLineage({
      id: 'lin-1',
      skill_id: record.id,
      generation: 1,
      action: 'created',
      rationale: 'Initial',
      content_snapshot: '# Skill',
      created_at: now,
    });
    insertSkillUsage({
      id: 'usage-1',
      skill_id: record.id,
      session_id: 'fake-session',
      detected_at: now,
    });

    const result = await handleGetSkillRecord(
      makeReq({ params: { id: 'skill-get' }, pathname: '/api/skill-records/skill-get' }),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      id: string;
      name: string;
      lineage: unknown[];
      usage_total: number;
    };
    expect(body.id).toBe('skill-get');
    expect(body.name).toBe('skill-get-test');
    expect(body.lineage).toHaveLength(1);
    expect(body.usage_total).toBe(1);
  });

  it('falls back to name lookup when id does not match', async () => {
    insertSkillRecord(makeSkillRecord({ id: 'skill-byname', name: 'lookup-by-name' }));

    const result = await handleGetSkillRecord(
      makeReq({ params: { id: 'lookup-by-name' }, pathname: '/api/skill-records/lookup-by-name' }),
    );

    expect(result.status).toBe(200);
    const body = result.body as { id: string; name: string };
    expect(body.id).toBe('skill-byname');
    expect(body.name).toBe('lookup-by-name');
  });

  it('returns 404 for unknown id or name', async () => {
    const result = await handleGetSkillRecord(
      makeReq({ params: { id: 'totally-unknown' } }),
    );

    expect(result.status).toBe(404);
    expect((result.body as { error: string }).error).toMatch('totally-unknown');
  });

  it('returns empty lineage and zero usage for a new skill', async () => {
    insertSkillRecord(makeSkillRecord({ id: 'skill-fresh', name: 'fresh-skill' }));

    const result = await handleGetSkillRecord(
      makeReq({ params: { id: 'skill-fresh' } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as { lineage: unknown[]; usage_total: number };
    expect(body.lineage).toEqual([]);
    expect(body.usage_total).toBe(0);
  });
});
