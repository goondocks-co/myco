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
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { memberHeaders } from './helpers/fixtures.js';
import { A, B, C, D, MISSING, REPO, X, fakeGithub, type Repo } from './helpers/github-fake.js';
import { GIT_STATUS_UNREADABLE } from '@myco-server-worker/ingest/projections.js';

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

  it('records whether a rate-limited check ran with a token, so the remedy follows the check and not a later setting', async () => {
    const outbound = (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch;
    const withToken = rig();
    await withToken.store.save(P, settings(), 'mem_1', 1);
    await reconcileReleaseProvenance({ ...withToken.serverEnv, outbound }, 100 * MIN);
    expect((await withToken.store.describe(P)).check).toMatchObject({ status: 'unavailable', failure: 'rate_limited' });

    const without = rig();
    await without.store.save(P, settings({ credential: undefined }), 'mem_1', 1);
    await reconcileReleaseProvenance({ ...without.serverEnv, outbound }, 100 * MIN);
    const view = await without.store.describe(P);
    expect(view.check).toMatchObject({ status: 'unavailable', failure: 'rate_limited_without_credential', lookups: 1 });
    // Adding a token afterwards leaves the recorded check as it ran.
    await without.store.save(P, settings({ revision: view.revision }), 'mem_1', 2);
    expect((await without.store.describe(P)).check).toMatchObject({ failure: 'rate_limited_without_credential' });
  });

  it('records a refusal without a token as a rate limit when GitHub signals one, and never as a rejected credential', async () => {
    const answering = (status: number, headers: Record<string, string> = {}, body = '{}') =>
      (async () => new Response(body, { status, headers })) as unknown as typeof fetch;
    const secondary = JSON.stringify({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' });
    const cases: Array<[string, typeof fetch, boolean, string]> = [
      ['secondary limit message', answering(403, {}, secondary), false, 'rate_limited_without_credential'],
      ['retry-after', answering(403, { 'retry-after': '60' }), false, 'rate_limited_without_credential'],
      ['bare 403', answering(403), false, 'forbidden_without_credential'],
      ['bare 403 with a token', answering(403), true, 'credential_rejected'],
      ['secondary limit message with a token', answering(403, {}, secondary), true, 'rate_limited'],
    ];
    for (const [name, outbound, withToken, failure] of cases) {
      const r = rig();
      await r.store.save(P, settings(withToken ? {} : { credential: undefined }), 'mem_1', 1);
      await reconcileReleaseProvenance({ ...r.serverEnv, outbound }, 100 * MIN);
      expect({ name, check: (await r.store.describe(P)).check }).toMatchObject({ name, check: { status: 'unavailable', failure, lookups: 1 } });
    }
  });

  it('stops a check without a token at the first refused comparison and records it as refused', async () => {
    const { r } = await configured();
    await r.store.save(P, settings({ revision: (await r.store.describe(P)).revision, credential: null }), 'mem_1', 2);
    const github = fakeGithub(REPO, []);
    const outbound = ((input: RequestInfo | URL, init?: RequestInit) => (String(input).includes('/compare/')
      ? Promise.resolve(new Response('{}', { status: 403 })) : github(input, init))) as typeof fetch;
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound }, 100 * MIN);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'unavailable', failure: 'forbidden_without_credential',
      counts: { checked: 0, unavailable: 1, deferred: 4 } });
  });

  it('classifies every captured commit, carries it to the session spores, and records a complete check', async () => {
    const { r } = await configured();
    const auth: Array<string | null> = [];
    const changed = await reconcileReleaseProvenance(env(r, REPO, [], auth), 100 * MIN);
    expect(changed).toBe(5);
    expect(byRecord(r)).toEqual({ s_merged: 'merged_unreleased', s_nowhere: 'not_on_release_line', s_released: 'released', s_squashed: 'released', s_unpushed: 'unknown' });
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_1')).toMatchObject({ state: 'released', basisRef: 'refs/tags/a/v1.2.0' });
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

describe('release state on every surface', () => {
  it('reads the same state, age and failed latest check over the owner API and MCP', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    seedSession(r, 's_merged', B);
    r.sqlite.query("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco', 'Myco', 'built-in', 1, 1)").run();
    r.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, observation_type, content, created_at, session_id)
      VALUES (?, 'sp_1', 'myco', 'decision', 'provenance agreement probe', 1, 's_merged')`).run(P);
    const fetcher = fakeGithub(REPO);
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fetcher }, 100 * MIN);
    await r.store.requestCheck(P, 150 * MIN);
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: (async () => new Response('{}', { status: 429 })) as unknown as typeof fetch }, 150 * MIN);

    const expected = {
      state: 'merged_unreleased', confidence: 'medium', ref: 'main', checkedAt: 100 * MIN,
      latestCheck: { status: 'unavailable', failure: 'rate_limited', finishedAt: 150 * MIN },
    };
    const env = { ...r.env, ...OWNER_ENV };
    const http = await (await worker.fetch(await asOwner(`/api/projects/${P}/sessions/s_merged`), env)).json() as { release: unknown };
    expect(http.release).toMatchObject(expected);

    const { token } = await issueMemberToken(r.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const mcp = async (name: string, args: Record<string, unknown>) => {
      const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) }), r.env);
      return ((await res.json()) as { result: { structuredContent: { result: any } } }).result.structuredContent.result;
    };
    expect((await mcp('myco_sessions', { op: 'get', id: 's_merged' })).release).toEqual(http.release);

    const found = await mcp('myco_search', { query: 'agreement probe', mode: 'fts', type: 'spore' });
    expect(found.results[0]).toMatchObject({ id: 'sp_1', release: { state: 'merged_unreleased', ref: 'main', checked_at: 100 * MIN } });
    const httpSearch = await (await worker.fetch(await asOwner(`/api/projects/${P}/search?q=${encodeURIComponent('agreement probe')}&mode=fts&type=spore`), env)).json() as any;
    expect(httpSearch.results?.[0]?.release ?? null).toEqual(found.results[0].release);
  });
});

describe('one check at a time, for the settings it read', () => {
  /** A GitHub whose first compare waits until released, so a check can be held mid-flight. */
  function heldGithub(repo: Repo = REPO) {
    const inner = fakeGithub(repo);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let reached!: () => void;
    const waiting = new Promise<void>((resolve) => { reached = resolve; });
    let held = false;
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push(String(input));
      if (!held && String(input).includes('/compare/')) { held = true; reached(); await gate; }
      return inner(input, init);
    }) as typeof fetch;
    return { fetcher, release, waiting, calls };
  }

  async function heldCheck() {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    seedSession(r, 's_merged', B);
    seedSession(r, 's_released', A);
    const github = heldGithub();
    const running = checkProject(r.db, r.secrets, github.fetcher, P, 100 * MIN);
    await github.waiting;
    return { r, github, running };
  }

  it('refuses a second check while one holds the Project', async () => {
    const { r, github, running } = await heldCheck();
    const other: string[] = [];
    expect(await checkProject(r.db, r.secrets, fakeGithub(REPO, other), P, 100 * MIN)).toBe(0);
    await r.store.requestCheck(P, 101 * MIN);
    expect(await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO, other) }, 101 * MIN)).toBe(0);
    expect(other).toEqual([]);
    github.release();
    expect(await running).toBe(2);
    expect(r.sqlite.query('SELECT check_run_id AS runId, check_status AS status FROM project_release_provenance').get()).toEqual({ runId: null, status: 'complete' });
  });

  it('publishes nothing from a check whose settings were saved while it waited on GitHub', async () => {
    const { r, github, running } = await heldCheck();
    const view = await r.store.describe(P);
    await r.store.save(P, settings({ revision: view.revision, githubRepo: 'o/other', credential: undefined }), 'mem_1', 150 * MIN);
    github.release();
    expect(await running).toBe(0);
    expect(rows(r)).toEqual([]);
    expect((await r.store.describe(P)).check).toMatchObject({ status: null, finishedAt: null, requestedAt: 150 * MIN });
    // The new settings are checked on the next pass.
    const seen: string[] = [];
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO, seen) }, 151 * MIN);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'complete', finishedAt: 151 * MIN });
  });

  it('lets a lapsed lease be taken over, and fences the check that lost it', async () => {
    const { r, github, running } = await heldCheck();
    r.sqlite.query('UPDATE project_release_provenance SET check_lease_until = 0').run();
    expect(await checkProject(r.db, r.secrets, fakeGithub(REPO), P, 300 * MIN)).toBe(2);
    const after = rows(r);
    github.release();
    expect(await running).toBe(0);
    expect(rows(r)).toEqual(after);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'complete', finishedAt: 300 * MIN });
  });
});

describe('the source a session state is classified from', () => {
  const addCommit = (r: ReturnType<typeof rig>, sessionId: string, point: 'session_start' | 'session_end', headSha: string, dirty = 0, at = 20, error: string | null = null) =>
    r.sqlite.query(`INSERT INTO knowledge_git_provenance (project_id, identity_key, session_id, capture_point, captured_at, head_sha, is_dirty, error, status_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?) ON CONFLICT(project_id, identity_key) DO UPDATE SET head_sha = excluded.head_sha, is_dirty = excluded.is_dirty, error = excluded.error, captured_at = excluded.captured_at`)
      .run(P, `session:${sessionId}:${point}`, sessionId, point, at, headSha, dirty, error, at);
  const newSession = (r: ReturnType<typeof rig>, sessionId: string) => r.sqlite.query(`INSERT INTO sessions
    (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, ?, 'machine_1', 'mt_1', 1, 1)`).run(P, sessionId);
  const state = (r: ReturnType<typeof rig>, sessionId: string) => r.sqlite.query(
    `SELECT state, basis_kind AS basisKind, json_extract(evidence_json, '$.source') AS source, json_extract(evidence_json, '$.previous') AS previous
     FROM knowledge_release_state WHERE record_id = ?`).get(sessionId) as { state: string; basisKind: string; source: string; previous: string | null };
  const check = async (r: ReturnType<typeof rig>, at: number) => { await r.store.requestCheck(P, at); return reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO) }, at); };

  it('never presents a session standing on a released start commit as released, and classifies its end commit when captured under unchanged refs', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    newSession(r, 's_live');
    addCommit(r, 's_live', 'session_start', A);
    await check(r, 100 * MIN);
    expect(state(r, 's_live')).toMatchObject({ state: 'unknown', basisKind: 'missing_git_evidence', source: `session_start:${A}:0` });
    addCommit(r, 's_live', 'session_end', B);
    expect(await check(r, 110 * MIN)).toBe(1);
    const after = state(r, 's_live');
    expect(after).toMatchObject({ state: 'merged_unreleased', source: `session_end:${B}:0` });
    expect(JSON.parse(after.previous!)).toMatchObject({ state: 'unknown', source: `session_start:${A}:0`, checked_at: 100 * MIN });
  });

  it('classifies a later end commit of a released session afresh and keeps the released state it replaced', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    newSession(r, 's_resumed');
    addCommit(r, 's_resumed', 'session_end', A, 0, 20);
    await check(r, 100 * MIN);
    expect(state(r, 's_resumed').state).toBe('released');
    addCommit(r, 's_resumed', 'session_end', D, 0, 30);
    await check(r, 110 * MIN);
    const after = state(r, 's_resumed');
    expect(after).toMatchObject({ state: 'not_on_release_line', source: `session_end:${D}:0` });
    expect(JSON.parse(after.previous!)).toMatchObject({ state: 'released', source: `session_end:${A}:0` });
  });

  it('reads uncommitted changes at session end as unknown, and never rewrites a released row with no recorded source', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    newSession(r, 's_dirty');
    addCommit(r, 's_dirty', 'session_end', A, 1);
    newSession(r, 's_history');
    addCommit(r, 's_history', 'session_end', D);
    r.sqlite.query(`INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, state, confidence, checked_at, created_at, evidence_json)
      VALUES (?, 'rs_old', ?, 'sessions', 's_history', 'released', 'high', 5, 5, '{}')`).run(P, `${P}:sessions:s_history`);
    const historical = r.sqlite.query("SELECT * FROM knowledge_release_state WHERE id = 'rs_old'").get();
    await check(r, 100 * MIN);
    expect(state(r, 's_dirty')).toMatchObject({ state: 'unknown', basisKind: 'dirty_worktree' });
    expect(r.sqlite.query("SELECT * FROM knowledge_release_state WHERE record_id = 's_history'").all()).toEqual([historical]);
  });

  it('reads an end whose cleanliness git could not read as unknown, replacing the clean end it followed and keeping the released state', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    newSession(r, 's_resumed');
    addCommit(r, 's_resumed', 'session_end', A, 0, 20);
    await check(r, 100 * MIN);
    expect(state(r, 's_resumed')).toMatchObject({ state: 'released', source: `session_end:${A}:0` });
    addCommit(r, 's_resumed', 'session_end', A, 0, 30, GIT_STATUS_UNREADABLE);
    await check(r, 110 * MIN);
    const after = state(r, 's_resumed');
    expect(after).toMatchObject({ state: 'unknown', basisKind: 'missing_git_evidence', source: `session_end:${A}:unknown` });
    expect(JSON.parse(after.previous!)).toMatchObject({ state: 'released', source: `session_end:${A}:0` });
  });

  it('classifies a session again when its package mapping or its changed paths change, and not while they hold', async () => {
    const r = rig();
    const saved = await r.store.save(P, settings({ packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }] }), 'mem_1', 1);
    newSession(r, 's_mapped');
    addCommit(r, 's_mapped', 'session_end', X);
    newSession(r, 's_late_paths');
    addCommit(r, 's_late_paths', 'session_end', X);
    const toolCall = (sessionId: string, n: number, file: string) => r.sqlite.query(`INSERT INTO tool_calls
      (project_id, tool_call_id, session_id, event_id, tool_name, success, created_at, token_id, received_at, files_affected)
      VALUES (?, ?, ?, ?, 'Edit', 1, 1, 'mt_1', 1, ?)`).run(P, `tc_${sessionId}_${n}`, sessionId, `ev_${sessionId}_${n}`, JSON.stringify([file]));
    toolCall('s_mapped', 1, 'packages/a/x.ts');
    toolCall('s_late_paths', 1, 'packages/a/x.ts');
    await check(r, 100 * MIN);
    expect([state(r, 's_mapped').state, state(r, 's_late_paths').state]).toEqual(['not_on_release_line', 'not_on_release_line']);

    toolCall('s_late_paths', 2, 'packages/b/y.ts');
    await check(r, 110 * MIN);
    expect([state(r, 's_mapped').state, state(r, 's_late_paths').state]).toEqual(['not_on_release_line', 'not_on_release_line']);
    expect((await r.store.describe(P)).check?.counts).toMatchObject({ checked: 1 });

    await r.store.save(P, settings({ revision: saved.revision, credential: undefined, packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/b/v*' }] }), 'mem_1', 115 * MIN);
    await check(r, 120 * MIN);
    expect([state(r, 's_mapped').state, state(r, 's_late_paths').state]).toEqual(['released', 'released']);

    await check(r, 130 * MIN);
    expect((await r.store.describe(P)).check?.counts).toMatchObject({ checked: 0 });
  });

  it('gives a spore or plan recorded after its session was classified the session state, without reading GitHub', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    newSession(r, 's_done');
    addCommit(r, 's_done', 'session_end', A);
    await check(r, 100 * MIN);
    expect(state(r, 's_done').state).toBe('released');
    r.sqlite.query("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco', 'Myco', 'built-in', 1, 1)").run();
    r.sqlite.query(`INSERT INTO spores (project_id, id, agent_id, observation_type, content, created_at, session_id)
      VALUES (?, 'sp_late', 'myco', 'decision', 'x', 200, 's_done')`).run(P);
    r.sqlite.query(`INSERT INTO plans (project_id, plan_key, session_id, event_id, machine_id, content_hash, status, created_at, updated_at, token_id, received_at)
      VALUES (?, 'plan_late', 's_done', 'ev_plan', 'machine_1', 'h', 'active', 200, 200, 'mt_1', 200)`).run(P);
    const seen: string[] = [];
    await r.store.requestCheck(P, 110 * MIN);
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO, seen) }, 110 * MIN);
    expect(seen.filter((p) => p.startsWith('/compare') || p.startsWith('/commits'))).toEqual([]);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_late')).toMatchObject({ state: 'released', basisRef: 'refs/tags/a/v1.2.0' });
    expect(await getReleaseState(r.db, SCOPE, 'plan', 'plan_late')).toMatchObject({ state: 'released', basisRef: 'refs/tags/a/v1.2.0' });
  });
});

describe('stored data that cannot be read', () => {
  it('names unreadable settings, runs no check, and keeps every state', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    seedSession(r, 's_merged', B);
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO) }, 100 * MIN);
    const before = rows(r);
    r.sqlite.query("UPDATE project_release_provenance SET production_refs = 'not json', check_requested_at = ?").run(200 * MIN);
    expect((await r.store.describe(P)).problem).toBe('stored_settings_unreadable');
    const seen: string[] = [];
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO, seen) }, 200 * MIN);
    expect(seen).toEqual([]);
    expect(rows(r)).toEqual(before);
    const status = r.sqlite.query('SELECT check_status AS status, check_failure AS failure FROM project_release_provenance').get();
    expect(status).toEqual({ status: 'unavailable', failure: 'stored_settings_unreadable' });
  });

  it('reads a session whose changed paths cannot be read as unknown rather than as a session that changed nothing', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    seedSession(r, 's_paths', X, ['packages/b/y.ts']);
    r.sqlite.query("UPDATE tool_calls SET files_affected = '[broken' WHERE session_id = 's_paths'").run();
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(REPO) }, 100 * MIN);
    expect(byRecord(r).s_paths).toBe('unknown');
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'partial', failure: 'changed_paths_unreadable' });
  });
});
