import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import {
  getReleaseState,
  insertGitProvenance,
  listGitProvenance,
  listReleaseStates,
  upsertReleaseState,
} from '@myco/db/queries/release-provenance.js';
import { ALL_PROJECTS_SCOPE, GLOBAL_SCOPE, projectScope, type GroveProjectId } from '@myco/grove/ids.js';

const PROJECT_A = 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as GroveProjectId;
const PROJECT_B = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as GroveProjectId;

function seedSession(id: string, project_id: string | null = null): void {
  upsertSession({
    id,
    project_id,
    agent: 'codex',
    started_at: 100,
    created_at: 100,
  });
}

describe('release provenance query helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  it('inserts and scopes raw Git provenance by project', () => {
    seedSession('session-a', PROJECT_A);
    seedSession('session-b', PROJECT_B);

    const row = insertGitProvenance({
      project_id: PROJECT_A,
      session_id: 'session-a',
      capture_point: 'session_start',
      captured_at: 110,
      branch: 'feat/release-provenance',
      head_sha: 'abc123',
      status_hash: 'hash-a',
      changed_paths_json: JSON.stringify(['packages/myco/src/db/schema.ts']),
      created_at: 110,
    });
    insertGitProvenance({
      project_id: PROJECT_B,
      session_id: 'session-b',
      capture_point: 'session_start',
      captured_at: 111,
      head_sha: 'def456',
      status_hash: 'hash-b',
      created_at: 111,
    });

    expect(row.project_id).toBe(PROJECT_A);
    expect(row.branch).toBe('feat/release-provenance');
    expect(listGitProvenance({ scope: projectScope(PROJECT_A) }).map((r) => r.session_id)).toEqual(['session-a']);
    expect(listGitProvenance({ scope: projectScope(PROJECT_B) }).map((r) => r.session_id)).toEqual(['session-b']);
    expect(listGitProvenance({ scope: GLOBAL_SCOPE })).toHaveLength(0);
    expect(listGitProvenance({ scope: ALL_PROJECTS_SCOPE })).toHaveLength(2);
  });

  it('upserts raw Git provenance idempotently by deterministic identity', () => {
    seedSession('session-a', PROJECT_A);

    const first = insertGitProvenance({
      project_id: PROJECT_A,
      session_id: 'session-a',
      capture_point: 'session_end',
      captured_at: 120,
      head_sha: 'abc123',
      status_hash: 'same-status',
      created_at: 120,
    });
    const second = insertGitProvenance({
      project_id: PROJECT_A,
      session_id: 'session-a',
      capture_point: 'session_end',
      captured_at: 130,
      head_sha: 'abc123',
      status_hash: 'same-status',
      evidence_json: JSON.stringify({ rerun: true }),
      created_at: 130,
    });

    expect(second.id).toBe(first.id);
    expect(second.captured_at).toBe(130);
    expect(second.evidence_json).toBe(JSON.stringify({ rerun: true }));
    expect(listGitProvenance({ scope: projectScope(PROJECT_A) })).toHaveLength(1);
  });

  it('upserts release state by project, namespace, and record id', () => {
    seedSession('session-a', PROJECT_A);
    const batch = insertBatch({
      project_id: PROJECT_A,
      session_id: 'session-a',
      created_at: 100,
      user_prompt: 'ship it',
    });

    const first = upsertReleaseState({
      project_id: PROJECT_A,
      namespace: 'spores',
      record_id: 'spore-a',
      source_session_id: 'session-a',
      source_prompt_batch_id: batch.id,
      state: 'unknown',
      confidence: 'low',
      reason: 'No release refs checked yet',
      checked_at: 200,
      created_at: 200,
    });
    const second = upsertReleaseState({
      project_id: PROJECT_A,
      namespace: 'spores',
      record_id: 'spore-a',
      source_session_id: 'session-a',
      source_prompt_batch_id: batch.id,
      state: 'released',
      confidence: 'high',
      basis_ref: 'refs/tags/v1.2.3',
      basis_sha: 'abc123',
      checked_at: 300,
      created_at: 200,
    });

    expect(second.id).toBe(first.id);
    expect(second.state).toBe('released');
    expect(second.confidence).toBe('high');
    expect(getReleaseState('spores', 'spore-a', projectScope(PROJECT_A))?.basis_ref).toBe('refs/tags/v1.2.3');
    expect(getReleaseState('spores', 'spore-a', projectScope(PROJECT_B))).toBeNull();
  });

  it('allows the same record id in different projects', () => {
    upsertReleaseState({
      project_id: PROJECT_A,
      namespace: 'plans',
      record_id: 'plan-shared',
      state: 'released',
      confidence: 'high',
      checked_at: 100,
      created_at: 100,
    });
    upsertReleaseState({
      project_id: PROJECT_B,
      namespace: 'plans',
      record_id: 'plan-shared',
      state: 'not_on_release_line',
      confidence: 'medium',
      checked_at: 101,
      created_at: 101,
    });

    expect(getReleaseState('plans', 'plan-shared', projectScope(PROJECT_A))?.state).toBe('released');
    expect(getReleaseState('plans', 'plan-shared', projectScope(PROJECT_B))?.state).toBe('not_on_release_line');
    expect(listReleaseStates({ scope: ALL_PROJECTS_SCOPE, namespace: 'plans' })).toHaveLength(2);
  });

  it('rejects invalid vocab before writing', () => {
    expect(() => insertGitProvenance({
      capture_point: 'bad' as never,
      captured_at: 1,
      status_hash: 'hash',
      created_at: 1,
    })).toThrow(/capture_point/);

    expect(() => upsertReleaseState({
      namespace: 'spores',
      record_id: 'spore-a',
      state: 'maybe' as never,
      confidence: 'low',
      checked_at: 1,
      created_at: 1,
    })).toThrow(/release state/);
  });
});
