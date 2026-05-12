import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { listGitProvenance } from '@myco/db/queries/release-provenance.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { captureGitProvenance } from '@myco/release-provenance/capture.js';
import type { GitSnapshot } from '@myco/release-provenance/git-snapshot.js';

const NOW = 1_800_000_000;

function snapshot(overrides: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    is_git_repository: true,
    project_root: '/repo',
    branch: 'ck/feat/release-provenance',
    head_sha: 'a'.repeat(40),
    upstream_ref: 'origin/main',
    upstream_sha: 'b'.repeat(40),
    production_ref: null,
    production_sha: null,
    is_dirty: true,
    staged_count: 1,
    unstaged_count: 2,
    untracked_count: 3,
    changed_paths: ['a.ts'],
    tracked_blob_hashes: { 'a.ts': 'c'.repeat(40) },
    patch_ids: [{ kind: 'unstaged', patch_id: 'd'.repeat(40) }],
    status_hash: 'e'.repeat(64),
    evidence: { git_repository: true },
    error: null,
    ...overrides,
  };
}

describe('captureGitProvenance', () => {
  beforeAll(() => { setupTestDb(); });
  beforeEach(() => { cleanTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('persists a prompt-batch Git snapshot without throwing through daemon callers', () => {
    upsertSession({
      id: 'session-release-capture',
      agent: 'codex',
      status: 'active',
      started_at: NOW,
      created_at: NOW,
      machine_id: 'test-machine',
    });
    const batch = insertBatch({
      session_id: 'session-release-capture',
      prompt_number: 1,
      user_prompt: 'ship release provenance',
      started_at: NOW,
      created_at: NOW,
      machine_id: 'test-machine',
    });

    const row = captureGitProvenance({
      projectRoot: '/repo',
      machineId: 'test-machine',
      sessionId: 'session-release-capture',
      promptBatchId: batch.id,
      capturePoint: 'prompt_batch_start',
      capturedAt: NOW,
      snapshotProvider: () => snapshot(),
    });

    expect(row?.capture_point).toBe('prompt_batch_start');
    expect(row?.session_id).toBe('session-release-capture');
    expect(row?.prompt_batch_id).toBe(batch.id);
    expect(row?.is_dirty).toBe(1);
    expect(JSON.parse(row!.changed_paths_json!)).toEqual(['a.ts']);
    expect(JSON.parse(row!.tracked_blob_hashes_json!)).toEqual({ 'a.ts': 'c'.repeat(40) });

    const rows = listGitProvenance({ scope: ALL_PROJECTS_SCOPE, session_id: 'session-release-capture' });
    expect(rows).toHaveLength(1);
    expect(rows[0].status_hash).toBe('e'.repeat(64));
  });

  it('soft-fails when snapshot collection throws', () => {
    const row = captureGitProvenance({
      projectRoot: '/repo',
      sessionId: 'session-release-failure',
      capturePoint: 'session_start',
      capturedAt: NOW,
      snapshotProvider: () => {
        throw new Error('git unavailable');
      },
    });

    expect(row).toBeNull();
  });
});
