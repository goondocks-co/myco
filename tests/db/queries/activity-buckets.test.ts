/**
 * Tests for the v6-rail-card activity-bucket helpers.
 *
 * The helpers compute the per-row sparkline data (8 × 1-minute buckets,
 * newest last) used by `GET /api/sessions` and `GET /api/agent/runs`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { insertTurn } from '@myco/db/queries/turns.js';
import { registerAgent } from '@myco/db/queries/agents.js';
import { insertGitProvenance } from '@myco/db/queries/release-provenance.js';
import {
  BUCKET_COUNT,
  getSessionActivityBuckets,
  getRunActivityBuckets,
  getRunBranches,
} from '@myco/db/queries/activity-buckets.js';

const epochNow = () => Math.floor(Date.now() / 1000);

describe('activity-bucket helpers', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => { cleanTestDb(); });

  describe('getSessionActivityBuckets', () => {
    it('returns an empty map when given no ids', () => {
      const result = getSessionActivityBuckets([]);
      expect(result.size).toBe(0);
    });

    it('returns zero-filled buckets for sessions with no activity', () => {
      const now = epochNow();
      upsertSession({ id: 'sess-quiet', agent: 'claude-code', started_at: now, created_at: now });

      const result = getSessionActivityBuckets(['sess-quiet'], { nowSeconds: now });
      const buckets = result.get('sess-quiet');
      expect(buckets).toBeDefined();
      expect(buckets!).toHaveLength(BUCKET_COUNT);
      expect(buckets!.every((c) => c === 0)).toBe(true);
    });

    it('bucketizes prompt_batches into the correct 1-minute slot', () => {
      const now = epochNow();
      upsertSession({ id: 'sess-a', agent: 'claude-code', started_at: now - 600, created_at: now - 600 });

      // Two batches in the most-recent bucket (within last 60s).
      insertBatch({ session_id: 'sess-a', started_at: now - 10, created_at: now - 10 });
      insertBatch({ session_id: 'sess-a', started_at: now - 50, created_at: now - 50 });
      // One batch in the second-most-recent bucket (60–120s ago).
      insertBatch({ session_id: 'sess-a', started_at: now - 90, created_at: now - 90 });
      // Outside the 8-minute window — should not be counted.
      insertBatch({ session_id: 'sess-a', started_at: now - 600, created_at: now - 600 });

      const result = getSessionActivityBuckets(['sess-a'], { nowSeconds: now });
      const buckets = result.get('sess-a')!;
      expect(buckets).toHaveLength(BUCKET_COUNT);
      // Newest bucket (index BUCKET_COUNT-1) should hold the two recent batches.
      expect(buckets[BUCKET_COUNT - 1]).toBe(2);
      // Second-newest bucket should hold the one mid-window batch.
      expect(buckets[BUCKET_COUNT - 2]).toBe(1);
      // Sum equals captured-in-window batches (older one excluded).
      expect(buckets.reduce((a, b) => a + b, 0)).toBe(3);
    });

    it('isolates activity per session', () => {
      const now = epochNow();
      upsertSession({ id: 'sess-a', agent: 'claude-code', started_at: now - 200, created_at: now - 200 });
      upsertSession({ id: 'sess-b', agent: 'claude-code', started_at: now - 200, created_at: now - 200 });

      insertBatch({ session_id: 'sess-a', started_at: now - 5, created_at: now - 5 });
      insertBatch({ session_id: 'sess-b', started_at: now - 70, created_at: now - 70 });

      const result = getSessionActivityBuckets(['sess-a', 'sess-b'], { nowSeconds: now });
      expect(result.get('sess-a')![BUCKET_COUNT - 1]).toBe(1);
      expect(result.get('sess-b')![BUCKET_COUNT - 2]).toBe(1);
      // Cross-leakage check: each session sees only its own counts.
      expect(result.get('sess-a')!.reduce((a, b) => a + b, 0)).toBe(1);
      expect(result.get('sess-b')!.reduce((a, b) => a + b, 0)).toBe(1);
    });
  });

  describe('getRunActivityBuckets', () => {
    it('returns zero buckets for a run with no turns', () => {
      const now = epochNow();
      registerAgent({ id: 'agent-buckets', name: 'Bucket Test', created_at: now });
      const run = insertRun({ id: 'run-quiet', agent_id: 'agent-buckets' });

      const result = getRunActivityBuckets([run.id], { nowSeconds: now });
      const buckets = result.get(run.id)!;
      expect(buckets).toHaveLength(BUCKET_COUNT);
      expect(buckets.every((c) => c === 0)).toBe(true);
    });

    it('bucketizes agent_turns into 1-minute slots', () => {
      const now = epochNow();
      registerAgent({ id: 'agent-buckets', name: 'Bucket Test', created_at: now });
      const run = insertRun({ id: 'run-a', agent_id: 'agent-buckets' });

      insertTurn({
        run_id: run.id,
        agent_id: 'agent-buckets',
        turn_number: 1,
        tool_name: 'read',
        started_at: now - 5,
      });
      insertTurn({
        run_id: run.id,
        agent_id: 'agent-buckets',
        turn_number: 2,
        tool_name: 'edit',
        started_at: now - 30,
      });
      insertTurn({
        run_id: run.id,
        agent_id: 'agent-buckets',
        turn_number: 3,
        tool_name: 'bash',
        started_at: now - 130,
      });

      const result = getRunActivityBuckets([run.id], { nowSeconds: now });
      const buckets = result.get(run.id)!;
      expect(buckets[BUCKET_COUNT - 1]).toBe(2);
      expect(buckets[BUCKET_COUNT - 3]).toBe(1);
    });
  });

  describe('getRunBranches', () => {
    it('returns null branches when run has no session_ref', () => {
      const now = epochNow();
      registerAgent({ id: 'agent-branch', name: 'Branch Test', created_at: now });
      const run = insertRun({ id: 'run-no-session', agent_id: 'agent-branch' });

      const result = getRunBranches([run.id]);
      expect(result.get(run.id)).toBeNull();
    });

    it('resolves branch from the most-recent provenance row for the linked session', () => {
      const now = epochNow();
      registerAgent({ id: 'agent-branch', name: 'Branch Test', created_at: now });
      upsertSession({ id: 'sess-branch', agent: 'claude-code', started_at: now, created_at: now });
      const run = insertRun({ id: 'run-with-session', agent_id: 'agent-branch', session_ref: 'sess-branch' });

      insertGitProvenance({
        project_id: null,
        machine_id: 'local',
        session_id: 'sess-branch',
        prompt_batch_id: null,
        capture_point: 'session_start',
        captured_at: now - 100,
        project_root: '/p',
        branch: 'old-branch',
        head_sha: null,
        upstream_ref: null,
        upstream_sha: null,
        production_ref: null,
        production_sha: null,
        is_dirty: 0,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        changed_paths_json: '[]',
        tracked_blob_hashes_json: '[]',
        patch_ids_json: '[]',
        status_hash: 'h-old',
        evidence_json: '{}',
        error: null,
        created_at: now - 100,
      });
      insertGitProvenance({
        project_id: null,
        machine_id: 'local',
        session_id: 'sess-branch',
        prompt_batch_id: null,
        capture_point: 'prompt_batch_start',
        captured_at: now - 10,
        project_root: '/p',
        branch: 'feat/new-branch',
        head_sha: null,
        upstream_ref: null,
        upstream_sha: null,
        production_ref: null,
        production_sha: null,
        is_dirty: 0,
        staged_count: 0,
        unstaged_count: 0,
        untracked_count: 0,
        changed_paths_json: '[]',
        tracked_blob_hashes_json: '[]',
        patch_ids_json: '[]',
        status_hash: 'h-new',
        evidence_json: '{}',
        error: null,
        created_at: now - 10,
      });

      const result = getRunBranches([run.id]);
      expect(result.get(run.id)).toBe('feat/new-branch');
    });
  });
});
