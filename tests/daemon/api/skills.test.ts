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
import { insertSpore } from '@myco/db/queries/spores.js';
import type { CandidateInsert } from '@myco/db/queries/skill-candidates.js';
import type { SkillRecordInsert } from '@myco/db/queries/skill-records.js';
import type { RouteRequest } from '@myco/daemon/router';
import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
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
    requestContext: TEST_REQUEST_CONTEXT,
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

function qualityMetadata(): Partial<CandidateInsert> {
  return {
    evidence_bundle_id: 'bundle-api-test-001',
    quality_score: 0.86,
    quality_failures: '[]',
    coverage_matches: '[]',
    source_ids: JSON.stringify([
      { id: 'spore-api-source-001', type: 'spore' },
      { id: 'spore-api-source-002', type: 'spore' },
      { id: 'session-api-source-001', type: 'session' },
    ]),
  };
}

function seedQualitySources(): void {
  const now = epochNow();
  upsertSession({
    id: 'session-api-source-001',
    project_id: null,
    agent: 'claude-code',
    started_at: now - 100,
    ended_at: now - 50,
    status: 'completed',
    title: 'API source session',
    summary: 'Resolved source session for candidate approval.',
    created_at: now - 100,
  });
  for (const id of ['spore-api-source-001', 'spore-api-source-002']) {
    insertSpore({
      id,
      project_id: null,
      agent_id: 'agent-test',
      session_id: 'session-api-source-001',
      observation_type: 'decision',
      content: `Resolved source ${id} for approval quality checks.`,
      importance: 5,
      created_at: now - 90,
    });
  }
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
  it('treats a pre-v42 candidate (no quality metadata at all) as legacy and approves with a warning', async () => {
    // A pre-v42 candidate is one where none of the v42 evidence columns are
    // populated AND the patch doesn't supply any. The approval path must
    // still accept these — refusing them would strand candidates the user
    // already triaged before v42 shipped — but surfaces a warning so the
    // UI can flag the bypass.
    insertCandidate(makeCandidate({ id: 'cand-legacy', status: 'identified' }));

    const result = await handleUpdateCandidate(
      makeReq({ params: { id: 'cand-legacy' }, body: { status: 'approved' } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      candidate: { id: string; status: string };
      warnings?: string[];
    };
    expect(body.candidate.status).toBe('approved');
    expect(body.warnings).toEqual(['legacy-candidate-approved-without-v42-quality-gate']);
  });

  it('rejects approval when post-v42 evidence metadata is incomplete', async () => {
    // Any row the v42 pipeline has TOUCHED — evidence_bundle_id set, or any
    // other quality column moved off its default — must go through the full
    // gate. The candidate here has evidence_bundle_id but no resolvable
    // source refs and no quality score, so validation rejects.
    insertCandidate(makeCandidate({
      id: 'cand-partial',
      status: 'identified',
      evidence_bundle_id: 'bundle-partial-001',
    }));

    const result = await handleUpdateCandidate(
      makeReq({ params: { id: 'cand-partial' }, body: { status: 'approved' } }),
    );

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toMatch(/evidence metadata/i);
    const body = result.body as { details?: { issues?: string[] } };
    expect(Array.isArray(body.details?.issues), 'details.issues must be present on approval-gate rejection').toBe(true);
  });

  it('updates the candidate status and returns updated row', async () => {
    seedQualitySources();
    insertCandidate(makeCandidate({ id: 'cand-update', status: 'identified', ...qualityMetadata() }));

    const result = await handleUpdateCandidate(
      makeReq({ params: { id: 'cand-update' }, body: { status: 'approved' } }),
    );

    expect(result.status).toBe(200);
    const body = result.body as { candidate: { id: string; status: string } };
    expect(body.candidate.id).toBe('cand-update');
    expect(body.candidate.status).toBe('approved');
  });

  it('updates candidate quality metadata fields', async () => {
    insertCandidate(makeCandidate({
      id: 'cand-quality-update',
      evidence_bundle_id: 'bundle-before',
      quality_score: 0.1,
      quality_failures: '["before"]',
      coverage_matches: '["before.ts"]',
      last_reconciled_at: 1_700_000_000,
      reconciliation_reason: 'before',
    }));

    const result = await handleUpdateCandidate(
      makeReq({
        params: { id: 'cand-quality-update' },
        body: {
          evidence_bundle_id: null,
          quality_score: 0.88,
          quality_failures: '["missing-examples"]',
          coverage_matches: '["packages/myco/src/agent/tools/skill-tools.ts"]',
          last_reconciled_at: null,
          reconciliation_reason: 'manual review',
        },
      }),
    );

    expect(result.status).toBe(200);
    const body = result.body as {
      candidate: {
        evidence_bundle_id: string | null;
        quality_score: number | null;
        quality_failures: string;
        coverage_matches: string;
        last_reconciled_at: number | null;
        reconciliation_reason: string | null;
      };
    };
    expect(body.candidate.evidence_bundle_id).toBeNull();
    expect(body.candidate.quality_score).toBe(0.88);
    expect(body.candidate.quality_failures).toBe('["missing-examples"]');
    expect(body.candidate.coverage_matches).toBe('["packages/myco/src/agent/tools/skill-tools.ts"]');
    expect(body.candidate.last_reconciled_at).toBeNull();
    expect(body.candidate.reconciliation_reason).toBe('manual review');
  });

  it('rejects null quality_failures with 400 and leaves the candidate unchanged', async () => {
    insertCandidate(makeCandidate({
      id: 'cand-null-quality-failures',
      status: 'identified',
      quality_failures: '["before"]',
      coverage_matches: '["before.ts"]',
    }));

    const result = await handleUpdateCandidate(
      makeReq({
        params: { id: 'cand-null-quality-failures' },
        body: { status: 'approved', quality_failures: null },
      }),
    );

    expect(result.status).toBe(400);
    const errorBody = result.body as {
      error: string;
      details?: { issues?: Array<{ path?: (string | number)[] }> };
    };
    expect(errorBody.error).toBe('Invalid request body');
    expect(
      errorBody.details?.issues?.some((issue) => issue.path?.includes('quality_failures')),
      'details.issues must reference quality_failures',
    ).toBe(true);

    const getResult = await handleGetCandidate(
      makeReq({ params: { id: 'cand-null-quality-failures' } }),
    );
    expect(getResult.status).toBe(200);
    const body = getResult.body as {
      candidate: {
        status: string;
        quality_failures: string;
        coverage_matches: string;
      };
    };
    expect(body.candidate.status).toBe('identified');
    expect(body.candidate.quality_failures).toBe('["before"]');
    expect(body.candidate.coverage_matches).toBe('["before.ts"]');
  });

  it('rejects null coverage_matches with 400 and leaves the candidate unchanged', async () => {
    insertCandidate(makeCandidate({
      id: 'cand-null-coverage-matches',
      status: 'identified',
      quality_failures: '["before"]',
      coverage_matches: '["before.ts"]',
    }));

    const result = await handleUpdateCandidate(
      makeReq({
        params: { id: 'cand-null-coverage-matches' },
        body: { status: 'approved', coverage_matches: null },
      }),
    );

    expect(result.status).toBe(400);
    const errorBody = result.body as {
      error: string;
      details?: { issues?: Array<{ path?: (string | number)[] }> };
    };
    expect(errorBody.error).toBe('Invalid request body');
    expect(
      errorBody.details?.issues?.some((issue) => issue.path?.includes('coverage_matches')),
      'details.issues must reference coverage_matches',
    ).toBe(true);

    const getResult = await handleGetCandidate(
      makeReq({ params: { id: 'cand-null-coverage-matches' } }),
    );
    expect(getResult.status).toBe(200);
    const body = getResult.body as {
      candidate: {
        status: string;
        quality_failures: string;
        coverage_matches: string;
      };
    };
    expect(body.candidate.status).toBe('identified');
    expect(body.candidate.quality_failures).toBe('["before"]');
    expect(body.candidate.coverage_matches).toBe('["before.ts"]');
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

    it('accepts status=deferred', async () => {
      insertCandidate(makeCandidate({ id: 'cand-deferred', status: 'identified' }));

      const result = await handleUpdateCandidate(
        makeReq({ params: { id: 'cand-deferred' }, body: { status: 'deferred' } }),
      );

      expect(result.status).toBe(200);
      const body = result.body as { candidate: { status: string } };
      expect(body.candidate.status).toBe('deferred');
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
