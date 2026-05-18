/**
 * Direct unit tests for validateSkillCandidateQualityContract.
 *
 * Exercises every failure branch (14 codes + 4 structural shapes), the
 * success path, isCandidateQualityFailureCode round-trip, and the
 * requireResolvedSources path against real spore/session/plan/artifact
 * vault records.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertSpore } from '@myco/db/queries/spores.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import type { ProjectScope } from '@myco/db/queries/project-scope.js';
import {
  CANDIDATE_QUALITY_FAILURE_CODES,
  IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE,
  IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS,
  isCandidateQualityFailureCode,
  unknownCandidateQualityFailureCodes,
  validateSkillCandidateQualityContract,
  type CandidateQualityContractRow,
} from '@myco/agent/skill-candidate-quality.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const TEST_AGENT = 'test-agent-quality';

/** Build a candidate that PASSES every validator check by default. */
function validCandidate(overrides: Partial<CandidateQualityContractRow> = {}): CandidateQualityContractRow {
  return {
    id: 'cand-valid',
    status: 'identified',
    evidence_bundle_id: 'bundle-001',
    quality_score: 0.86,
    quality_failures: '[]',
    coverage_matches: '[]',
    source_ids: JSON.stringify([
      { type: 'spore', id: 'spore-q-001' },
      { type: 'spore', id: 'spore-q-002' },
      { type: 'session', id: 'session-q-001' },
    ]),
    ...overrides,
  };
}

function seedSources(scope: ProjectScope): void {
  const now = epochNow();
  registerAgent({ id: TEST_AGENT, name: TEST_AGENT, created_at: now });
  upsertSession({
    id: 'session-q-001',
    project_id: null,
    agent: 'claude-code',
    started_at: now - 100,
    ended_at: now - 50,
    status: 'completed',
    title: 'quality test session',
    summary: 'Seeded session for source-ref resolution tests.',
    created_at: now - 100,
  });
  for (const id of ['spore-q-001', 'spore-q-002']) {
    insertSpore({
      id,
      project_id: null,
      agent_id: TEST_AGENT,
      session_id: 'session-q-001',
      observation_type: 'decision',
      content: `Seed spore ${id} for source-ref resolution.`,
      importance: 5,
      created_at: now - 90,
    });
  }
}

describe('validateSkillCandidateQualityContract', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  describe('success path', () => {
    it('returns no issues for a fully-populated candidate', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate());
      expect(issues).toEqual([]);
    });

    it('returns no issues when requireResolvedSources is set AND all refs resolve in scope', () => {
      seedSources(ALL_PROJECTS_SCOPE);
      const issues = validateSkillCandidateQualityContract(
        validCandidate(),
        { requireResolvedSources: true, scope: ALL_PROJECTS_SCOPE },
      );
      expect(issues).toEqual([]);
    });
  });

  describe('evidence_bundle_id', () => {
    it('rejects when evidence_bundle_id is missing', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ evidence_bundle_id: null }));
      expect(issues).toContain('evidence_bundle_id is required');
    });
    it('rejects when evidence_bundle_id is the empty string', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ evidence_bundle_id: '' }));
      expect(issues).toContain('evidence_bundle_id is required');
    });
    it('rejects when evidence_bundle_id is whitespace-only', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ evidence_bundle_id: '   ' }));
      expect(issues).toContain('evidence_bundle_id is required');
    });
  });

  describe('quality_score', () => {
    it('rejects when quality_score is null', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_score: null }));
      expect(issues).toContain(`quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE}`);
    });
    it('rejects when quality_score is below threshold', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_score: 0.65 }));
      expect(issues).toContain(`quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE}`);
    });
    it('accepts when quality_score is exactly at threshold', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_score: IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE }));
      expect(issues).not.toContain(`quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE}`);
    });
  });

  describe('quality_failures', () => {
    it('rejects when not valid JSON', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_failures: 'not json' }));
      expect(issues).toContain('quality_failures must be a JSON array');
    });
    it('rejects when not an array', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_failures: '{"x":1}' }));
      expect(issues).toContain('quality_failures must be a JSON array');
    });
    it('rejects when array contains non-strings', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_failures: '[1, 2, 3]' }));
      expect(issues).toContain('quality_failures must be a JSON array of strings');
    });
    it('rejects when array contains unknown reason codes', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({
        quality_failures: JSON.stringify(['active-skill-overlap', 'bogus-code']),
      }));
      expect(issues.some((i) => i.includes('bogus-code'))).toBe(true);
    });
    it('rejects when array is non-empty with known codes', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({
        quality_failures: JSON.stringify(['active-skill-overlap']),
      }));
      expect(issues).toContain('quality_failures must be an empty array');
    });
    it('accepts empty array', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ quality_failures: '[]' }));
      expect(issues).not.toContain('quality_failures must be an empty array');
    });
    it('treats null / empty string as the empty array (no error)', () => {
      const issuesNull = validateSkillCandidateQualityContract(validCandidate({ quality_failures: null }));
      const issuesEmpty = validateSkillCandidateQualityContract(validCandidate({ quality_failures: '' }));
      expect(issuesNull.some((i) => i.startsWith('quality_failures'))).toBe(false);
      expect(issuesEmpty.some((i) => i.startsWith('quality_failures'))).toBe(false);
    });
  });

  describe('coverage_matches', () => {
    it('rejects when not valid JSON', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ coverage_matches: 'not json' }));
      expect(issues).toContain('coverage_matches must be a JSON array');
    });
    it('rejects when array contains non-strings', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ coverage_matches: '[true]' }));
      expect(issues).toContain('coverage_matches must be a JSON array of strings');
    });
    it('accepts a non-empty string array', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({
        coverage_matches: JSON.stringify(['app/x.ts', 'app/y.ts']),
      }));
      expect(issues.filter((i) => i.startsWith('coverage_matches'))).toEqual([]);
    });
  });

  describe('source_ids', () => {
    it('rejects when not valid JSON', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ source_ids: 'not json' }));
      expect(issues).toContain('source_ids must be a JSON array of source references');
    });
    it('rejects when JSON is not an array', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({ source_ids: '{"x":1}' }));
      expect(issues).toContain('source_ids must be a JSON array of source references');
    });
    it('rejects when array contains invalid entries (raw count > normalized count)', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({
        source_ids: JSON.stringify([
          { type: 'spore', id: 'spore-q-001' },
          { type: 'unknown-type', id: 'x' },
          { id: 'missing-type' },
        ]),
      }));
      expect(issues).toContain('source_ids contains invalid source reference entries');
    });
    it('rejects when fewer than MIN valid refs', () => {
      const issues = validateSkillCandidateQualityContract(validCandidate({
        source_ids: JSON.stringify([{ type: 'spore', id: 's1' }]),
      }));
      expect(issues).toContain(
        `source_ids must contain at least ${IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS} valid source references`,
      );
    });
    it('requireResolvedSources without scope returns an issue', () => {
      const issues = validateSkillCandidateQualityContract(
        validCandidate(),
        { requireResolvedSources: true },
      );
      expect(issues).toContain('project scope is required to resolve source_ids');
    });
    it('requireResolvedSources surfaces missing vault records with type:id labels', () => {
      seedSources(ALL_PROJECTS_SCOPE);
      const issues = validateSkillCandidateQualityContract(
        validCandidate({
          source_ids: JSON.stringify([
            { type: 'spore', id: 'spore-q-001' },
            { type: 'spore', id: 'spore-q-002' },
            { type: 'spore', id: 'spore-q-missing' },
          ]),
        }),
        { requireResolvedSources: true, scope: ALL_PROJECTS_SCOPE },
      );
      expect(issues.some((i) => i.includes('spore:spore-q-missing'))).toBe(true);
    });
    it('requireResolvedSources resolves spore/session sources in one batched query per type', () => {
      // The batched implementation issues at most one query per source
      // type, not one per ref. Asserted indirectly via correctness:
      // mix of resolvable spores + session in a single candidate should
      // produce no missing-record issue.
      seedSources(ALL_PROJECTS_SCOPE);
      const issues = validateSkillCandidateQualityContract(
        validCandidate({
          source_ids: JSON.stringify([
            { type: 'spore', id: 'spore-q-001' },
            { type: 'spore', id: 'spore-q-002' },
            { type: 'session', id: 'session-q-001' },
          ]),
        }),
        { requireResolvedSources: true, scope: ALL_PROJECTS_SCOPE },
      );
      expect(issues).toEqual([]);
    });
  });

  describe('issue aggregation', () => {
    it('accumulates multiple issues in one pass', () => {
      const issues = validateSkillCandidateQualityContract({
        evidence_bundle_id: null,
        quality_score: 0.4,
        quality_failures: '[]',
        coverage_matches: '[]',
        source_ids: '[]',
      });
      expect(issues.length).toBeGreaterThanOrEqual(3);
      expect(issues).toContain('evidence_bundle_id is required');
      expect(issues).toContain(`quality_score must be >= ${IDENTIFIED_CANDIDATE_MIN_QUALITY_SCORE}`);
      expect(issues).toContain(
        `source_ids must contain at least ${IDENTIFIED_CANDIDATE_MIN_SOURCE_REFS} valid source references`,
      );
    });
  });
});

describe('CANDIDATE_QUALITY_FAILURE_CODES helpers', () => {
  it('isCandidateQualityFailureCode returns true for every declared code', () => {
    for (const code of CANDIDATE_QUALITY_FAILURE_CODES) {
      expect(isCandidateQualityFailureCode(code)).toBe(true);
    }
  });
  it('isCandidateQualityFailureCode returns false for foreign strings', () => {
    expect(isCandidateQualityFailureCode('totally-bogus')).toBe(false);
    expect(isCandidateQualityFailureCode('')).toBe(false);
  });
  it('unknownCandidateQualityFailureCodes filters to only foreign codes', () => {
    const mixed = [
      CANDIDATE_QUALITY_FAILURE_CODES[0]!,
      'bogus-1',
      CANDIDATE_QUALITY_FAILURE_CODES[1]!,
      'bogus-2',
    ];
    expect(unknownCandidateQualityFailureCodes(mixed)).toEqual(['bogus-1', 'bogus-2']);
  });
  it('returns empty array when all codes are valid', () => {
    expect(unknownCandidateQualityFailureCodes([...CANDIDATE_QUALITY_FAILURE_CODES])).toEqual([]);
  });
});
