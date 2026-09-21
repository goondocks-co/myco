/**
 * A Project's release provenance: the one writer of its settings and
 * purpose-labelled credential, and the scheduled check that classifies
 * captured session commits against a modelled GitHub — changed, unchanged,
 * unknown and unavailable outcomes, preserved history, and bounded reads.
 */
import { describe, expect, it } from 'bun:test';
import {
  checkProject, reconcileReleaseProvenance, releaseProvenance, ReleaseProvenanceConflictError, ReleaseProvenanceInputError,
  RELEASE_CREDENTIAL_PURPOSE, type ReleaseProvenanceWrite,
} from '@myco-server-worker/core/release-provenance.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { getReleaseState } from '@myco-server-worker/core/provenance.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';
import { A, B, C, D, MISSING, REPO, fakeGithub, type Repo } from './helpers/github-fake.js';

const TOKEN = 'fixture-release-token-with-no-real-permissions';
const P = 'proj_1';
const SCOPE = { projectId: P };
const MIN = 60_000;

function rig() {
  const r = sqliteEnv();
  r.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
  const secrets = deploymentSecretStore(r.db, r.serverEnv.wrappingKey);
  return { ...r, secrets, store: releaseProvenance(r.db, secrets) };
}

const settings = (over: Partial<ReleaseProvenanceWrite> = {}): ReleaseProvenanceWrite => ({
  revision: null, enabled: true, githubRepo: 'o/r',
  productionRefs: ['refs/tags/a/v*', 'refs/tags/b/v*'], integrationRefs: ['origin/main'],
  packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }, { pathGlob: 'packages/b/', tagPattern: 'refs/tags/b/v*' }],
  includeUnknown: true, maxLookups: 50, credential: { token: TOKEN }, ...over,
});

function seedSession(r: ReturnType<typeof rig>, sessionId: string, headSha: string, files: string[] = []) {
  r.sqlite.query(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES (?, ?, 'machine_1', 'mt_1', 1, 1)`).run(P, sessionId);
  r.sqlite.query(`INSERT INTO knowledge_git_provenance (project_id, identity_key, session_id, capture_point, captured_at, head_sha, status_hash, created_at)
    VALUES (?, ?, ?, 'session_end', 10, ?, '', 10)`).run(P, `session:${sessionId}:session_end`, sessionId, headSha);
  if (files.length > 0) {
    r.sqlite.query(`INSERT INTO tool_calls (project_id, tool_call_id, session_id, event_id, tool_name, success, created_at, token_id, received_at, files_affected)
      VALUES (?, ?, ?, ?, 'Edit', 1, 1, 'mt_1', 1, ?)`).run(P, `tc_${sessionId}`, sessionId, `ev_${sessionId}`, JSON.stringify(files));
  }
}

const rows = (r: ReturnType<typeof rig>) => r.sqlite.query(
  'SELECT namespace, record_id, state, basis_kind, checked_at, created_at, id FROM knowledge_release_state ORDER BY namespace, record_id',
).all() as Array<{ namespace: string; record_id: string; state: string; basis_kind: string; checked_at: number; created_at: number; id: string }>;

const byRecord = (r: ReturnType<typeof rig>) => Object.fromEntries(rows(r).filter((x) => x.namespace === 'sessions').map((x) => [x.record_id, x.state]));

describe('release provenance settings', () => {
  it('describes an unconfigured Project with its purpose and the connected repository as a suggestion only', async () => {
    const r = rig();
    r.sqlite.query(`INSERT INTO project_repositories (project_id, revision, url, branch, updated_at, updated_by)
      VALUES (?, 'rev', 'https://github.com/goondocks-co/myco.git', 'main', 1, 'mem_1')`).run(P);
    const view = await r.store.describe(P);
    expect(view).toMatchObject({ enabled: false, githubRepo: null, revision: null, suggestedRepo: 'goondocks-co/myco', check: null,
      credential: { configured: false, purpose: RELEASE_CREDENTIAL_PURPOSE } });
  });

  it('seals the credential in its own slot and never shows any of it', async () => {
    const r = rig();
    const view = await r.store.save(P, settings(), 'mem_1', 1);
    expect(view.credential).toEqual({ configured: true, purpose: RELEASE_CREDENTIAL_PURPOSE });
    expect(JSON.stringify(view)).not.toContain(TOKEN);
    expect(JSON.stringify(view)).not.toContain(TOKEN.slice(0, 4));
    const slot = (r.sqlite.query('SELECT secret_slot FROM project_release_provenance').get() as { secret_slot: string }).secret_slot;
    expect(slot).toBe(`release-provenance:${P}:${view.revision}`);
    expect(await r.secrets.get(slot)).toBe(TOKEN);
    expect(r.sqlite.query('SELECT COUNT(*) AS n FROM project_repositories').get()).toEqual({ n: 0 });
  });

  it('refuses a stale revision and changes nothing', async () => {
    const r = rig();
    const first = await r.store.save(P, settings(), 'mem_1', 1);
    await expect(r.store.save(P, settings({ revision: null }), 'mem_1', 2)).rejects.toBeInstanceOf(ReleaseProvenanceConflictError);
    expect((await r.store.describe(P)).revision).toBe(first.revision);
  });

  it('keeps the credential for the same repository and drops it for another', async () => {
    const r = rig();
    const first = await r.store.save(P, settings(), 'mem_1', 1);
    const same = await r.store.save(P, settings({ revision: first.revision, credential: undefined, maxLookups: 10 }), 'mem_1', 2);
    expect(same.credential.configured).toBe(true);
    const moved = await r.store.save(P, settings({ revision: same.revision, credential: undefined, githubRepo: 'o/other' }), 'mem_1', 3);
    expect(moved.credential.configured).toBe(false);
    expect((await r.secrets.list()).filter((s) => s.name.startsWith('release-provenance:'))).toEqual([]);
  });

  it('refuses settings that could not be checked', async () => {
    const r = rig();
    for (const bad of [
      settings({ githubRepo: 'not a repo' }), settings({ githubRepo: null }), settings({ productionRefs: [], integrationRefs: [] }),
      settings({ productionRefs: ['refs/tags/../x'] }), settings({ maxLookups: 0 }), settings({ maxLookups: 1001 }),
      settings({ packageMap: [{ pathGlob: '', tagPattern: 'v*' }] }),
    ]) await expect(r.store.save(P, bad, 'mem_1', 1)).rejects.toBeInstanceOf(ReleaseProvenanceInputError);
    expect(r.sqlite.query('SELECT COUNT(*) AS n FROM project_release_provenance').get()).toEqual({ n: 0 });
  });
});

describe('the scheduled release check', () => {
  const env = (r: ReturnType<typeof rig>, repo: Repo = REPO, seen: string[] = [], auth: Array<string | null> = []) => {
    const fetcher = fakeGithub(repo, seen);
    return { ...r.serverEnv, outbound: ((input: RequestInfo | URL, init?: RequestInit) => {
      auth.push(new Headers(init?.headers).get('authorization'));
      return fetcher(input, init);
    }) as typeof fetch };
  };

  async function configured(repo?: Repo) {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    seedSession(r, 's_released', A, ['/Users/dev/repo/packages/a/src/x.ts']);
    seedSession(r, 's_merged', B);
    seedSession(r, 's_squashed', C);
    seedSession(r, 's_nowhere', D);
    seedSession(r, 's_unpushed', MISSING);
    r.sqlite.query("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco', 'Myco', 'built-in', 1, 1)").run();
    r.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, observation_type, content, created_at, session_id)
      VALUES (?, 'sp_1', 'myco', 'decision', 'x', 1, 's_released')`).run(P);
    return { r, repo: repo ?? REPO };
  }

  it('classifies every captured commit, carries it to the session spores, and records a complete check', async () => {
    const { r } = await configured();
    const auth: Array<string | null> = [];
    const changed = await reconcileReleaseProvenance(env(r, REPO, [], auth), 100 * MIN);
    expect(changed).toBe(5);
    expect(byRecord(r)).toEqual({ s_merged: 'merged_unreleased', s_nowhere: 'not_on_release_line', s_released: 'released', s_squashed: 'released', s_unpushed: 'unknown' });
    expect(await getReleaseState(r.db, SCOPE, 'spores', 'sp_1')).toMatchObject({ state: 'released', basisRef: 'refs/tags/a/v1.2.0' });
    const view = await r.store.describe(P);
    expect(view.check).toMatchObject({ status: 'complete', failure: null, counts: { checked: 5, changed: 5, unknown: 1, unavailable: 0, deferred: 0 }, lastCompleteAt: 100 * MIN });
    expect(auth.every((a) => a === `Bearer ${TOKEN}`)).toBe(true);
    expect(JSON.stringify(rows(r))).not.toContain(TOKEN);
  });

  it('waits for the interval, runs on request, and skips commits already classified under unchanged refs', async () => {
    const { r } = await configured();
    await reconcileReleaseProvenance(env(r), 100 * MIN);
    const seen: string[] = [];
    expect(await reconcileReleaseProvenance(env(r, REPO, seen), 101 * MIN)).toBe(0);
    expect(seen).toEqual([]);
    expect(await r.store.requestCheck(P, 102 * MIN)).toBe(true);
    expect(await reconcileReleaseProvenance(env(r, REPO, seen), 102 * MIN)).toBe(0);
    expect(seen.filter((p) => p.startsWith('/compare'))).toEqual([]);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'complete', counts: { checked: 0 }, lookups: 4 });
  });

  it('moves merged work to released when a new tag contains it, and never rewrites a released state', async () => {
    const { r } = await configured();
    await reconcileReleaseProvenance(env(r), 100 * MIN);
    const releasedBefore = rows(r).find((x) => x.record_id === 's_released');
    const tagged: Repo = { ...REPO, tags: [...REPO.tags, 'refs/tags/a/v1.3.0'], contains: { ...REPO.contains, 'refs/tags/a/v1.3.0': [A, B] } };
    const changed = await reconcileReleaseProvenance(env(r, tagged), 200 * MIN);
    expect(changed).toBe(1);
    expect(byRecord(r).s_merged).toBe('released');
    expect(rows(r).find((x) => x.record_id === 's_released')).toEqual(releasedBefore!);
    const merged = rows(r).find((x) => x.record_id === 's_merged')!;
    expect(merged.created_at).toBe(100 * MIN);
  });

  it('keeps every state and records why when GitHub refuses the credential', async () => {
    const { r } = await configured();
    await reconcileReleaseProvenance(env(r), 100 * MIN);
    const before = rows(r);
    const refused = { ...r.serverEnv, outbound: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch };
    await r.store.requestCheck(P, 150 * MIN);
    expect(await reconcileReleaseProvenance(refused, 150 * MIN)).toBe(0);
    expect(rows(r)).toEqual(before);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'unavailable', failure: 'credential_rejected', finishedAt: 150 * MIN, lastCompleteAt: 100 * MIN });
  });

  it('stops at the lookup budget, defers the rest, and leaves unchecked sessions as they were', async () => {
    const { r } = await configured();
    const view = await r.store.describe(P);
    await r.store.save(P, settings({ revision: view.revision, credential: undefined, maxLookups: 12 }), 'mem_1', 2);
    await reconcileReleaseProvenance(env(r), 100 * MIN);
    const check = (await r.store.describe(P)).check!;
    expect(check).toMatchObject({ status: 'partial', failure: 'budget_exhausted', lookups: 12, counts: { checked: 1, unavailable: 1, deferred: 3 } });
    expect(check.counts!.checked + check.counts!.unavailable + check.counts!.deferred).toBe(5);
    expect(rows(r).filter((x) => x.namespace === 'sessions')).toHaveLength(check.counts!.checked);
  });

  it('checks nothing for a Project with tracking off, and one due Project once under racing wakes', async () => {
    const { r } = await configured();
    const view = await r.store.describe(P);
    await r.store.save(P, settings({ revision: view.revision, credential: undefined, enabled: false }), 'mem_1', 2);
    const seen: string[] = [];
    expect(await reconcileReleaseProvenance(env(r, REPO, seen), 100 * MIN)).toBe(0);
    expect(seen).toEqual([]);

    const again = await configured();
    const [first, second] = await Promise.all([
      checkProject(again.r.db, again.r.secrets, env(again.r).outbound, P, 100 * MIN),
      checkProject(again.r.db, again.r.secrets, env(again.r).outbound, P, 100 * MIN),
    ]);
    expect([first, second].sort()).toEqual([0, 5]);
  });
});

describe('release provenance routes', () => {
  it('saves, reads and requests a check over the owner API without returning the credential', async () => {
    const r = rig();
    const env = { ...r.env, ...OWNER_ENV };
    const path = `/api/projects/${P}/release-provenance`;
    const refusedCheck = await worker.fetch(await asOwnerPost(`${path}/check`, {}), env);
    expect(refusedCheck.status).toBe(409);
    const saved = await worker.fetch(new Request(await asOwnerPost(path, settings()), { method: 'PUT' }), env);
    expect(saved.status).toBe(200);
    const text = await saved.text();
    expect(text).not.toContain(TOKEN);
    const read = await (await worker.fetch(await asOwner(path), env)).json() as { releaseProvenance: { revision: string; credential: unknown } };
    expect(read.releaseProvenance.credential).toEqual({ configured: true, purpose: RELEASE_CREDENTIAL_PURPOSE });
    const stale = await worker.fetch(new Request(await asOwnerPost(path, settings()), { method: 'PUT' }), env);
    expect(stale.status).toBe(409);
    const invalid = await worker.fetch(new Request(await asOwnerPost(path, settings({ revision: read.releaseProvenance.revision, githubRepo: 'x' })), { method: 'PUT' }), env);
    expect(invalid.status).toBe(400);
    const check = await worker.fetch(await asOwnerPost(`${path}/check`, {}), env);
    expect(await check.json()).toMatchObject({ requested: true, releaseProvenance: { check: { requestedAt: expect.any(Number) } } });
    expect((await worker.fetch(new Request('https://s' + path, { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env)).status).toBe(401);
    expect((await worker.fetch(await asOwner('/api/projects/missing/release-provenance'), env)).status).toBe(404);
  });
});
