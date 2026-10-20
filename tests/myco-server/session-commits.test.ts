/**
 * A session's commit observations through the owner API: the start and end
 * commits its member observed, and the release check that classified one of
 * them. Containment belongs to the observation whose point, commit and
 * cleanliness give the source the check recorded, never to one that merely
 * shares its basis commit.
 */
import { describe, expect, it } from 'bun:test';
import { reconcileReleaseProvenance, releaseProvenance, type ReleaseProvenanceWrite } from '@myco-server-worker/core/release-provenance.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { GIT_STATUS_UNREADABLE } from '@myco-server-worker/ingest/projections.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { A, B, C, D, M, REPO, fakeGithub } from './helpers/github-fake.js';

const P = 'proj_1';
const MIN = 60_000;

const settings: ReleaseProvenanceWrite = {
  revision: null, enabled: true, githubRepo: 'o/r', productionRefs: ['refs/tags/a/v*'], integrationRefs: ['origin/main'],
  packageMap: [], includeUnknown: true, maxLookups: 50, credential: { token: 'fixture-release-token-with-no-real-permissions' },
};

function rig() {
  const r = sqliteEnv();
  r.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
  const store = releaseProvenance(r.db, deploymentSecretStore(r.db, r.serverEnv.wrappingKey));
  const session = (projectId: string, sessionId: string) => r.sqlite.query(`INSERT INTO sessions
      (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'machine_1', 'mt_1', 1, 1)`)
    .run(projectId, sessionId);
  /** One observation as `sessionCommit` writes it. */
  const observe = (projectId: string, sessionId: string, point: 'session_start' | 'session_end', headSha: string,
    o: { at?: number; dirty?: boolean; unreadable?: boolean; branch?: string } = {}) => r.sqlite.query(`INSERT INTO knowledge_git_provenance
      (project_id, identity_key, session_id, capture_point, captured_at, branch, head_sha, is_dirty, error, status_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 1)
      ON CONFLICT(project_id, identity_key) DO UPDATE SET head_sha = excluded.head_sha, is_dirty = excluded.is_dirty, error = excluded.error, captured_at = excluded.captured_at`)
    .run(projectId, `session:${sessionId}:${point}`, sessionId, point, o.at ?? (point === 'session_start' ? 10 : 20), o.branch ?? 'main', headSha,
      o.dirty === true ? 1 : 0, o.unreadable === true ? GIT_STATUS_UNREADABLE : null);
  const check = (at: number, outbound: typeof fetch = fakeGithub(REPO)) => reconcileReleaseProvenance({ ...r.serverEnv, outbound }, at);
  const commits = async (projectId: string, sessionId: string) => {
    const res = await worker.fetch(await asOwner(r.db, `/api/projects/${projectId}/sessions/${sessionId}/commits`), { ...r.env, ...OWNER_ENV });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };
  return { ...r, store, session, observe, check, commits };
}

const refused = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;

describe('a session\'s commit observations', () => {
  it('answers no observations and no release check for a session whose commits were never observed', async () => {
    const r = rig();
    r.session(P, 's_quiet');
    expect(await r.commits(P, 's_quiet')).toEqual({ status: 200, body: { observations: [], release: null } });
  });

  it('carries a squash release on the end commit it classified, though its basis is the merge commit', async () => {
    const r = rig();
    await r.store.save(P, settings, 'mem_1', 1);
    r.session(P, 's_1');
    r.observe(P, 's_1', 'session_start', A, { branch: 'feat' });
    r.observe(P, 's_1', 'session_end', C, { branch: 'feat' });
    await r.check(100 * MIN);
    expect(r.sqlite.query('SELECT basis_sha AS basisSha FROM knowledge_release_state WHERE record_id = ?').get('s_1')).toEqual({ basisSha: M });
    expect(await r.commits(P, 's_1')).toEqual({ status: 200, body: {
      observations: [
        { point: 'session_start', headSha: A, branch: 'feat', changes: 'none', capturedAt: 10 },
        { point: 'session_end', headSha: C, branch: 'feat', changes: 'none', capturedAt: 20 },
      ],
      release: { state: 'released', basisKind: 'github_pr_squash', basisRef: 'refs/tags/a/v1.2.0', releasePrNumber: 7, checkedAt: 100 * MIN,
        covers: { point: 'session_end', current: true } },
    } });
  });

  it('says the check covers an earlier end commit once the end commit changes, and keeps that state when the next check fails', async () => {
    const r = rig();
    await r.store.save(P, settings, 'mem_1', 1);
    r.session(P, 's_1');
    r.observe(P, 's_1', 'session_end', C);
    await r.check(100 * MIN);
    r.observe(P, 's_1', 'session_end', D, { at: 30 });
    const moved = (await r.commits(P, 's_1')).body;
    expect(moved.observations).toEqual([{ point: 'session_end', headSha: D, branch: 'main', changes: 'none', capturedAt: 30 }]);
    expect(moved.release).toMatchObject({ state: 'released', checkedAt: 100 * MIN, covers: { point: 'session_end', current: false } });

    await r.store.requestCheck(P, 150 * MIN);
    await r.check(150 * MIN, refused);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'unavailable', failure: 'credential_rejected' });
    expect((await r.commits(P, 's_1')).body.release).toEqual(moved.release);

    await r.store.requestCheck(P, 200 * MIN);
    await r.check(200 * MIN);
    expect((await r.commits(P, 's_1')).body.release).toMatchObject({ state: 'not_on_release_line', checkedAt: 200 * MIN, covers: { point: 'session_end', current: true } });
  });

  it('matches the end commit\'s cleanliness too: the same commit now dirty is not the observation the check classified', async () => {
    const r = rig();
    await r.store.save(P, settings, 'mem_1', 1);
    r.session(P, 's_1');
    r.observe(P, 's_1', 'session_end', B);
    await r.check(100 * MIN);
    expect((await r.commits(P, 's_1')).body.release).toMatchObject({ state: 'merged_unreleased', basisRef: 'main', covers: { point: 'session_end', current: true } });
    r.observe(P, 's_1', 'session_end', B, { at: 30, dirty: true });
    expect((await r.commits(P, 's_1')).body.release).toMatchObject({ state: 'merged_unreleased', covers: { point: 'session_end', current: false } });
  });

  it('answers a state recorded without a source as covering no observation', async () => {
    const r = rig();
    r.session(P, 's_legacy');
    r.observe(P, 's_legacy', 'session_end', A);
    r.sqlite.query(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, source_session_id, state, confidence,
        basis_kind, basis_ref, basis_sha, release_pr_number, reason, evidence_json, checked_at, created_at)
      VALUES (?, 'rs_legacy', ?, 'sessions', 's_legacy', 's_legacy', 'released', 'high', 'git_ancestry', 'refs/tags/a/v1.0.0', ?, NULL, 'r', '{}', 5, 5)`)
      .run(P, `${P}:sessions:s_legacy`, A);
    expect((await r.commits(P, 's_legacy')).body.release).toEqual({
      state: 'released', basisKind: 'git_ancestry', basisRef: 'refs/tags/a/v1.0.0', releasePrNumber: null, checkedAt: 5, covers: null,
    });
  });

  it('answers a dirty end, an end whose status could not be read, and equal start and end commits as observed', async () => {
    const r = rig();
    await r.store.save(P, settings, 'mem_1', 1);
    r.session(P, 's_dirty');
    r.observe(P, 's_dirty', 'session_end', A, { dirty: true });
    r.session(P, 's_unread');
    r.observe(P, 's_unread', 'session_end', A, { unreadable: true });
    r.session(P, 's_same');
    r.observe(P, 's_same', 'session_start', A);
    r.observe(P, 's_same', 'session_end', A);
    await r.check(100 * MIN);
    const dirty = (await r.commits(P, 's_dirty')).body;
    expect(dirty.observations).toMatchObject([{ point: 'session_end', headSha: A, changes: 'uncommitted' }]);
    expect(dirty.release).toMatchObject({ state: 'unknown', basisKind: 'dirty_worktree', covers: { point: 'session_end', current: true } });
    const unread = (await r.commits(P, 's_unread')).body;
    expect(unread.observations).toMatchObject([{ point: 'session_end', headSha: A, changes: 'unreadable' }]);
    expect(unread.release).toMatchObject({ state: 'unknown', basisKind: 'missing_git_evidence', covers: { point: 'session_end', current: true } });
    const same = (await r.commits(P, 's_same')).body;
    expect((same.observations as Array<{ point: string; headSha: string }>).map((o) => [o.point, o.headSha])).toEqual([['session_start', A], ['session_end', A]]);
    expect(same.release).toMatchObject({ state: 'released', covers: { point: 'session_end', current: true } });
  });

  it('never reads another project\'s observations, and answers 404 for a session the project does not hold', async () => {
    const r = rig();
    r.session(P, 's_shared');
    r.session('proj_2', 's_shared');
    r.observe('proj_2', 's_shared', 'session_end', A);
    r.session('proj_2', 's_theirs');
    r.observe('proj_2', 's_theirs', 'session_end', A);
    expect(await r.commits(P, 's_shared')).toEqual({ status: 200, body: { observations: [], release: null } });
    expect((await r.commits(P, 's_theirs')).status).toBe(404);
    expect((await r.commits(P, 's_absent')).status).toBe(404);
  });
});
