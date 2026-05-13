import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, beforeEach, afterAll, describe, expect, it } from 'bun:test';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db.js';
import { insertGitProvenance, getReleaseState } from '@myco/db/queries/release-provenance.js';
import { reconcileReleaseProvenance } from '@myco/release-provenance/reconcile.js';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { insertBatch } from '@myco/db/queries/batches.js';

const NOW = 1_800_000_000;

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function gitWithInput(cwd: string, args: string[], input: string): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', input }).trim();
}

function patchIdForRange(cwd: string, base: string, head: string): string {
  const diff = git(cwd, ['diff', '--find-renames', base, head]);
  return gitWithInput(cwd, ['patch-id', '--stable'], `${diff}\n`).split(/\s+/)[0];
}

function makeRepo(): { repo: string; first: string; second: string } {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-reconcile-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Test User']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n', 'utf-8');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-qm', 'first']);
  const first = git(repo, ['rev-parse', 'HEAD']);
  git(repo, ['tag', 'prod']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'two\n', 'utf-8');
  git(repo, ['commit', '-am', 'second', '-q']);
  const second = git(repo, ['rev-parse', 'HEAD']);
  return { repo, first, second };
}

function insertPromptProvenance(headSha: string, overrides: Partial<Parameters<typeof insertGitProvenance>[0]> = {}): number {
  upsertSession({
    id: 'session-reconcile',
    agent: 'codex',
    status: 'active',
    started_at: NOW,
    created_at: NOW,
    machine_id: 'test-machine',
  });
  const batch = insertBatch({
    session_id: 'session-reconcile',
    prompt_number: 1,
    user_prompt: 'reconcile release provenance',
    started_at: NOW,
    created_at: NOW,
    machine_id: 'test-machine',
  });
  insertGitProvenance({
    session_id: 'session-reconcile',
    prompt_batch_id: batch.id,
    capture_point: 'prompt_batch_stop',
    captured_at: NOW,
    project_root: '/repo',
    head_sha: headSha,
    is_dirty: false,
    status_hash: `${headSha}:clean`,
    created_at: NOW,
    ...overrides,
  });
  return batch.id;
}

describe('reconcileReleaseProvenance', () => {
  beforeAll(() => { setupTestDb(); });
  beforeEach(() => { cleanTestDb(); });
  afterAll(() => { teardownTestDb(); });

  it('marks a clean captured head as released when it is contained in a production ref', async () => {
    const { repo, first } = makeRepo();
    try {
      const batchId = insertPromptProvenance(first);

      const result = await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: ['prod'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 1,
      });

      expect(result.reconciled).toBe(1);
      const state = getReleaseState('prompt_batches', String(batchId), ALL_PROJECTS_SCOPE);
      expect(state?.state).toBe('released');
      expect(state?.confidence).toBe('high');
      expect(state?.basis_ref).toBe('prod');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('expands production ref globs so new release tags reconcile without config edits', async () => {
    const { repo, first } = makeRepo();
    try {
      const batchId = insertPromptProvenance(first);

      await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: ['refs/tags/pro*'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 1,
      });

      const state = getReleaseState('prompt_batches', String(batchId), ALL_PROJECTS_SCOPE);
      expect(state?.state).toBe('released');
      expect(state?.confidence).toBe('high');
      expect(state?.basis_ref).toBe('refs/tags/prod');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('keeps missing release configuration as unreconciled instead of guessing', async () => {
    const { repo, first } = makeRepo();
    try {
      const batchId = insertPromptProvenance(first);

      await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: [],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 1,
      });

      const state = getReleaseState('prompt_batches', String(batchId), ALL_PROJECTS_SCOPE);
      expect(state?.state).toBe('unreconciled');
      expect(state?.reason).toBe('No release provenance refs configured');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('does not claim dirty working-tree evidence is on a release line', async () => {
    const { repo, first } = makeRepo();
    try {
      const batchId = insertPromptProvenance(first, { is_dirty: true, staged_count: 1 });

      await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: ['prod'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 1,
      });

      const state = getReleaseState('prompt_batches', String(batchId), ALL_PROJECTS_SCOPE);
      expect(state?.state).toBe('unknown');
      expect(state?.basis_kind).toBe('dirty_worktree');
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });

  it('marks squash-merged feature work as released through stable range patch identity', async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-release-squash-'));
    try {
      git(repo, ['init', '-q']);
      git(repo, ['config', 'user.email', 'test@example.com']);
      git(repo, ['config', 'user.name', 'Test User']);
      fs.writeFileSync(path.join(repo, 'file.txt'), 'one\n', 'utf-8');
      git(repo, ['add', 'file.txt']);
      git(repo, ['commit', '-qm', 'initial']);
      git(repo, ['branch', '-m', 'main']);
      const base = git(repo, ['rev-parse', 'HEAD']);

      git(repo, ['checkout', '-qb', 'feature']);
      fs.writeFileSync(path.join(repo, 'file.txt'), 'one\ntwo\n', 'utf-8');
      git(repo, ['commit', '-am', 'feature part one', '-q']);
      fs.writeFileSync(path.join(repo, 'file.txt'), 'one\ntwo\nthree\n', 'utf-8');
      git(repo, ['commit', '-am', 'feature part two', '-q']);
      const featureHead = git(repo, ['rev-parse', 'HEAD']);
      const rangePatchId = patchIdForRange(repo, base, featureHead);

      git(repo, ['checkout', '-q', 'main']);
      git(repo, ['merge', '--squash', 'feature', '-q']);
      git(repo, ['commit', '-qm', 'feat: squash feature']);
      const squashCommit = git(repo, ['rev-parse', 'HEAD']);
      git(repo, ['tag', 'prod-squash']);

      const batchId = insertPromptProvenance(featureHead, {
        patch_ids_json: JSON.stringify([{
          kind: 'upstream_range',
          patch_id: rangePatchId,
          base_ref: 'main',
          base_sha: base,
          head_sha: featureHead,
        }]),
      });

      await reconcileReleaseProvenance({
        projectRoot: repo,
        scope: ALL_PROJECTS_SCOPE,
        config: {
          enabled: true,
          production_refs: ['prod-squash'],
          integration_refs: [],
          reconcile_interval_minutes: 15,
        },
        now: NOW + 1,
      });

      const state = getReleaseState('prompt_batches', String(batchId), ALL_PROJECTS_SCOPE);
      expect(state?.state).toBe('released');
      expect(state?.confidence).toBe('medium');
      expect(state?.basis_kind).toBe('git_patch_id');
      expect(state?.basis_ref).toBe('prod-squash');
      expect(state?.basis_sha).toBe(squashCommit);
    } finally {
      fs.rmSync(repo, { recursive: true, force: true });
    }
  });
});
