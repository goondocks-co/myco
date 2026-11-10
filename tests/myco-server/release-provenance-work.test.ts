/**
 * The maintained release work: due rows, capture-fed work rows, the keyed propagation queue, the namespace catch-up and
 * the bounded release state list, asserted through stored rows and the answers readers give.
 */
import { describe, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { checkProject, PROJECTS_PER_PASS, reconcileReleaseProvenance, releaseProvenance, type ReleaseProvenanceWrite } from '@myco-server-worker/core/release-provenance.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { decodeReleaseStatesCursor, getReleaseState, getReleaseStatesForRecords, listReleaseStates } from '@myco-server-worker/core/provenance.js';
import { catchUpPhase, catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { dueReleaseChecks } from '@myco-server-worker/db/release/due.js';
import { openReleaseWork } from '@myco-server-worker/db/release/work.js';
import { RELEASE_PROPAGATION_PAGE } from '@myco-server-worker/db/release/propagation.js';
import { SESSION_PATHS_LIMIT } from '@myco-server-worker/db/document-tables.js';
import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { readReleaseStatePage, RELEASE_LIST_SCAN } from '@myco-server-worker/db/release/states.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { A, B, MISSING, REPO, X, fakeGithub, type Repo } from './helpers/github-fake.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const P = 'proj_1';
const SCOPE = { projectId: P };
const MIN = 60_000;

function rig() {
  const r = sqliteEnv();
  r.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
  const secrets = deploymentSecretStore(r.db, r.serverEnv.wrappingKey);
  r.sqlite.query("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco', 'Myco', 'built-in', 1, 1)").run();
  return { ...r, secrets, store: releaseProvenance(r.db, secrets) };
}
type Rig = ReturnType<typeof rig>;

const settings = (over: Partial<ReleaseProvenanceWrite> = {}): ReleaseProvenanceWrite => ({
  revision: null, enabled: true, githubRepo: 'o/r', productionRefs: ['refs/tags/a/v*'], integrationRefs: ['origin/main'],
  packageMap: [], includeUnknown: true, maxLookups: 50, credential: { token: 'fixture-token-no-permissions' }, ...over,
});

function session(r: Rig, id: string, sha = A, point: 'session_start' | 'session_end' = 'session_end', at = 10, dirty = 0) {
  r.sqlite.query(`INSERT OR IGNORE INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at)
    VALUES (?, ?, 'machine_1', 'mt_1', 1, 1)`).run(P, id);
  r.sqlite.query(`INSERT INTO knowledge_git_provenance (project_id, identity_key, session_id, capture_point, captured_at, head_sha, is_dirty, status_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, '', 1) ON CONFLICT(project_id, identity_key) DO UPDATE SET head_sha=excluded.head_sha, is_dirty=excluded.is_dirty, captured_at=excluded.captured_at`).run(P, `session:${id}:${point}`, id, point, at, sha, dirty);
}

const spore = (r: Rig, sporeId: string, sessionId: string) => r.sqlite.query(
  `INSERT INTO spores (project_id, id, agent_id, observation_type, content, created_at, session_id) VALUES (?, ?, 'myco', 'decision', 'x', 1, ?)`).run(P, sporeId, sessionId);

const check = (r: Rig, now: number, repo: Repo = REPO, seen: string[] = []) => reconcileReleaseProvenance({ ...r.serverEnv, outbound: fakeGithub(repo, seen) }, now);

const due = (r: Rig) => r.sqlite.query('SELECT project_id, next_at, revision, lease_id, lease_until FROM release_check_due').all() as Array<{ project_id: string; next_at: number; revision: string; lease_id: string | null; lease_until: number | null }>;

/** A GitHub whose first compare waits until released, so a check can be held mid-flight or left to die. */
function heldGithub(repo: Repo = REPO) {
  const inner = fakeGithub(repo);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached!: () => void;
  const waiting = new Promise<void>((resolve) => { reached = resolve; });
  let held = false;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (!held && String(input).includes('/compare/')) { held = true; reached(); await gate; }
    return inner(input, init);
  }) as typeof fetch;
  return { fetcher, release, waiting };
}

const DAY = 24 * 60 * MIN;

describe('the release check due row', () => {
  it('exists only while tracking is on, and a save asks for a check on the next pass', async () => {
    const r = rig();
    const view = await r.store.save(P, settings(), 'mem_1', 7);
    expect(due(r)).toMatchObject([{ project_id: P, revision: view.revision!, lease_id: null }]);
    session(r, 's1');
    const seen: string[] = [];
    await check(r, 100 * MIN, REPO, seen);
    expect(seen.length).toBeGreaterThan(0);
    const off = await r.store.save(P, settings({ revision: view.revision, enabled: false, credential: undefined }), 'mem_1', 101 * MIN);
    expect(off.enabled).toBe(false);
    expect(due(r)).toEqual([]);
  });

  it('waits out the interval after a check, and a request made while it ran brings it straight back', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1');
    await check(r, 100 * MIN);
    const early: string[] = [];
    await check(r, 110 * MIN, REPO, early);
    expect(early).toEqual([]);
    const due15: string[] = [];
    await check(r, 115 * MIN, REPO, due15);
    expect(due15.length).toBeGreaterThan(0);

    const github = heldGithub();
    session(r, 's2', B);
    await r.store.requestCheck(P, 200 * MIN);
    const running = reconcileReleaseProvenance({ ...r.serverEnv, outbound: github.fetcher }, 200 * MIN);
    await github.waiting;
    await r.store.requestCheck(P, 200 * MIN + 1);
    github.release();
    await running;
    const again: string[] = [];
    await check(r, 201 * MIN, REPO, again);
    expect(again.length).toBeGreaterThan(0);
  });

  it('leaves an owner when a check dies holding the Project: nothing checks it before its lease ends, and the next pass after does', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', B);
    const dead = heldGithub();
    void reconcileReleaseProvenance({ ...r.serverEnv, outbound: dead.fetcher }, 100 * MIN);
    await dead.waiting;
    const during: string[] = [];
    await check(r, 100 * MIN + 1, REPO, during);
    expect(during).toEqual([]);
    const after: string[] = [];
    await check(r, 100 * MIN + DAY, REPO, after);
    expect(after.length).toBeGreaterThan(0);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'merged_unreleased', checkedAt: 100 * MIN + DAY });
  });

  it('checks a due Project while others hold live checks, even after the interval is shortened under them', async () => {
    const r = rig();
    const held = Array.from({ length: PROJECTS_PER_PASS }, (_, n) => `proj_held_${n}`);
    r.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) SELECT value, value, 1 FROM json_each(?)`, [JSON.stringify(held)]);
    r.sqlite.run(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('release_provenance.reconcile_interval_minutes', '60', 1, 'owner')`);
    const deaths = [];
    for (const project of held) {
      await r.store.save(project, settings(), 'mem_1', 1);
      r.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES (?, 's1', 'machine_1', 'mt_1', 1, 1)`, [project]);
      r.sqlite.run(`INSERT INTO knowledge_git_provenance (project_id, identity_key, session_id, capture_point, captured_at, head_sha, status_hash, created_at)
        VALUES (?, 'session:s1:session_end', 's1', 'session_end', 10, ?, '', 1)`, [project, B]);
      const dead = heldGithub();
      void checkProject(r.db, r.secrets, dead.fetcher, project, 100 * MIN);
      deaths.push(dead.waiting);
    }
    await Promise.all(deaths);
    await r.store.save(P, settings(), 'mem_1', 100 * MIN);
    session(r, 's1', B);
    r.sqlite.run(`UPDATE deployment_settings SET value='5' WHERE leaf='release_provenance.reconcile_interval_minutes'`);
    await check(r, 110 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'merged_unreleased' });
  });
});

describe('release work from capture', () => {
  const compares = (seen: string[]) => seen.filter((path) => path.startsWith('/compare'));

  it('checks a released session again only when its end commit changes', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', A);
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'released' });
    session(r, 's1', A, 'session_end', 20);
    await r.store.requestCheck(P, 110 * MIN);
    const unchanged: string[] = [];
    await check(r, 110 * MIN, REPO, unchanged);
    expect(compares(unchanged)).toEqual([]);
    session(r, 's1', B, 'session_end', 30);
    await r.store.requestCheck(P, 120 * MIN);
    await check(r, 120 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'merged_unreleased', source: `session_end:${B}:0` });
  });

  it('does not write a state from a check that read an end commit a newer capture has replaced', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', B);
    const github = heldGithub();
    const running = checkProject(r.db, r.secrets, github.fetcher, P, 100 * MIN);
    await github.waiting;
    session(r, 's1', MISSING, 'session_end', 50);
    github.release();
    expect(await running).toBe(0);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toBeNull();
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'partial', counts: { checked: 1, deferred: 1 } });
    await r.store.requestCheck(P, 200 * MIN);
    await check(r, 200 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'unknown', basisKind: 'missing_git_evidence' });
  });

  it('marks nothing when the repository cannot be read, and classifies on the next check that can', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', A);
    await reconcileReleaseProvenance({ ...r.serverEnv, outbound: (async () => new Response('{}', { status: 404 })) as unknown as typeof fetch }, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toBeNull();
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'unavailable', failure: 'repository_not_found' });
    await r.store.requestCheck(P, 110 * MIN);
    await check(r, 110 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'released' });
  });

  it('records a session whose stored path catalogue is full as unknown, and checks it again when its paths move', async () => {
    const r = rig();
    await r.store.save(P, settings({ packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }] }), 'mem_1', 1);
    session(r, 's1', X);
    r.sqlite.query(`INSERT INTO session_documents (project_id, session_id, state, generation, updated_at) VALUES (?, 's1', 'live', 1, 1)`).run(P);
    r.sqlite.query(`INSERT INTO session_paths (project_id, session_id, generation, path, tool_calls, last_at)
      SELECT ?, 's1', 1, 'p/'||value, 1, 1 FROM json_each(?)`).run(P, JSON.stringify(Array.from({ length: SESSION_PATHS_LIMIT }, (_, n) => n)));
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'unknown', reason: `The session touched at least ${SESSION_PATHS_LIMIT} paths, so its package is not established` });
    expect((await r.store.describe(P)).check).toMatchObject({ failure: null, counts: { unknown: 1 } });
    await r.store.requestCheck(P, 110 * MIN);
    await check(r, 110 * MIN);
    expect((await r.store.describe(P)).check?.counts).toMatchObject({ checked: 0 });
    r.sqlite.query(`UPDATE session_documents SET tool_calls = 3 WHERE project_id=? AND session_id='s1'`).run(P);
    await r.store.requestCheck(P, 120 * MIN);
    await check(r, 120 * MIN);
    expect((await r.store.describe(P)).check?.counts).toMatchObject({ checked: 1 });
  });

  it('checks a session again when its paths change while a check of it waits, and answers from the paths it now has', async () => {
    const r = rig();
    await r.store.save(P, settings({ productionRefs: ['refs/tags/a/v*', 'refs/tags/b/v*'],
      packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }, { pathGlob: 'packages/b/', tagPattern: 'refs/tags/b/v*' }] }), 'mem_1', 1);
    session(r, 's1', X);
    const touch = (file: string) => {
      r.sqlite.query(`INSERT INTO session_documents (project_id, session_id, state, generation, updated_at) VALUES (?, 's1', 'live', 1, 1) ON CONFLICT (project_id, session_id) DO NOTHING`).run(P);
      r.sqlite.query(`INSERT INTO session_paths (project_id, session_id, generation, path, tool_calls, last_at) VALUES (?, 's1', 1, ?, 1, 1)`).run(P, file);
      r.sqlite.query(`UPDATE session_documents SET tool_calls = tool_calls + 1 WHERE project_id = ? AND session_id = 's1'`).run(P);
    };
    touch('packages/a/x.ts');
    const github = heldGithub();
    const running = checkProject(r.db, r.secrets, github.fetcher, P, 100 * MIN);
    await github.waiting;
    touch('packages/b/y.ts');
    github.release();
    await running;
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toBeNull();
    await r.store.requestCheck(P, 110 * MIN);
    await check(r, 110 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'released', basisRef: 'refs/tags/b/v2.0.0' });
  });

  it('classifies a start-only session whose paths change during a check, since its answer never reads them, and the check completes', async () => {
    const r = rig();
    await r.store.save(P, settings({ productionRefs: ['refs/tags/a/v*', 'refs/tags/b/v*'],
      packageMap: [{ pathGlob: 'packages/a/', tagPattern: 'refs/tags/a/v*' }, { pathGlob: 'packages/b/', tagPattern: 'refs/tags/b/v*' }] }), 'mem_1', 1);
    session(r, 's_end', X, 'session_end', 10);
    session(r, 's_start', B, 'session_start', 5);
    for (const [id, file] of [['s_end', 'packages/b/y.ts'], ['s_start', 'packages/a/z.ts']] as const) {
      r.sqlite.query(`INSERT INTO session_documents (project_id, session_id, state, generation, updated_at) VALUES (?, ?, 'live', 1, 1)`).run(P, id);
      r.sqlite.query(`INSERT INTO session_paths (project_id, session_id, generation, path, tool_calls, last_at) VALUES (?, ?, 1, ?, 1, 1)`).run(P, id, file);
      r.sqlite.query(`UPDATE session_documents SET tool_calls = 1 WHERE project_id = ? AND session_id = ?`).run(P, id);
    }
    const github = heldGithub();
    const running = checkProject(r.db, r.secrets, github.fetcher, P, 100 * MIN);
    await github.waiting;
    r.sqlite.query(`UPDATE session_documents SET tool_calls = tool_calls + 1 WHERE project_id = ? AND session_id = 's_start'`).run(P);
    github.release();
    await running;
    expect(await getReleaseState(r.db, SCOPE, 'session', 's_start')).toMatchObject({ state: 'unknown', basisKind: 'missing_git_evidence' });
    expect(await getReleaseState(r.db, SCOPE, 'session', 's_end')).toMatchObject({ state: 'released' });
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'complete', counts: { checked: 2, deferred: 0 } });
  });

  it('does not check again an unknown the Project does not record, so it cannot crowd out later sessions', async () => {
    const r = rig();
    await r.store.save(P, settings({ includeUnknown: false }), 'mem_1', 1);
    session(r, 's1', MISSING);
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toBeNull();
    await r.store.requestCheck(P, 110 * MIN);
    await check(r, 110 * MIN);
    expect((await r.store.describe(P)).check?.counts).toMatchObject({ checked: 0 });
  });
});

describe('carrying a session state to its records', () => {
  const carried = (r: Rig) => (r.sqlite.query(`SELECT COUNT(*) AS n FROM knowledge_release_state WHERE namespace='spores'`).get() as { n: number }).n;
  const queued = (r: Rig) => (r.sqlite.query('SELECT COUNT(*) AS n FROM release_propagation_due').get() as { n: number }).n;

  it('carries a long session over bounded passes, says a carried record is propagating meanwhile, and ends with every record carried', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', B);
    const total = RELEASE_PROPAGATION_PAGE * 2 + 20;
    const ids = Array.from({ length: total }, (_, n) => `sp_${String(n).padStart(3, '0')}`);
    for (const id of ids) spore(r, id, 's1');
    expect((await check(r, 100 * MIN)).more).toBe(true);
    expect(carried(r)).toBeLessThan(total);
    expect((await getReleaseStatesForRecords(r.db, SCOPE, 'spore', [ids[0]!])).sp_000).toMatchObject({ state: 'merged_unreleased', propagating: true });
    expect(await getReleaseStatesForRecords(r.db, SCOPE, 'spore', [ids.at(-1)!])).toEqual({});
    for (let pass = 1; queued(r) > 0 && pass <= total; pass += 1) await check(r, 100 * MIN + pass);
    expect(carried(r)).toBe(total);
    expect((await check(r, 100 * MIN + total + 1)).more).toBe(false);
    expect((await getReleaseStatesForRecords(r.db, SCOPE, 'spore', [ids[0]!, ids.at(-1)!]))).toMatchObject({
      [ids[0]!]: { state: 'merged_unreleased', propagating: false }, [ids.at(-1)!]: { state: 'merged_unreleased', propagating: false },
    });
  });

  it('queues nothing when a session is checked again to the same answer, so its records never read as propagating', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', B);
    spore(r, 'sp_1', 's1');
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_1')).toMatchObject({ state: 'merged_unreleased', propagating: false });
    const tagged: Repo = { ...REPO, tags: [...REPO.tags, 'refs/tags/a/v0.9.0'], contains: { ...REPO.contains, 'refs/tags/a/v0.9.0': [] } };
    await checkProject(r.db, r.secrets, fakeGithub(tagged), P, 200 * MIN);
    expect((await r.store.describe(P)).check?.counts).toMatchObject({ checked: 1, changed: 0, unchanged: 1 });
    expect(queued(r)).toBe(0);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_1')).toMatchObject({ state: 'merged_unreleased', propagating: false });
  });

  it('keeps a released record when its session is checked again, and carries a state to a record recorded later', async () => {
    const r = rig();
    const saved = await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', A);
    spore(r, 'sp_1', 's1');
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_1')).toMatchObject({ state: 'released' });
    await r.store.save(P, settings({ revision: saved.revision, credential: undefined, maxLookups: 49 }), 'mem_1', 150 * MIN);
    await check(r, 160 * MIN, { ...REPO, tags: [] });
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_1')).toMatchObject({ state: 'released' });
    spore(r, 'sp_late', 's1');
    expect(await getReleaseStatesForRecords(r.db, SCOPE, 'spore', ['sp_late'])).toEqual({});
    await check(r, 170 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_late')).toMatchObject({ state: 'released' });
  });
});

describe('canonicalizing stored release states', () => {
  /** A Project as an older server left it: the seeded rows are not yet placed, and catch-up has not run. */
  function legacyRig() {
    const r = rig();
    r.sqlite.run(`UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='release_provenance'`);
    return r;
  }

  const legacy = (r: Rig, row: { id: string; namespace: string; record: string; state?: string; checkedAt: number; identity?: string; evidence?: string | null }) => r.sqlite.query(
    `INSERT INTO knowledge_release_state (project_id, id, identity_key, namespace, record_id, state, confidence, reason, evidence_json, checked_at, created_at, canonical)
     VALUES (?, ?, ?, ?, ?, ?, 'high', 'r', ?, ?, ?, 0)`)
    .run(P, row.id, row.identity ?? `${P}:${row.namespace}:${row.record}`, row.namespace, row.record, row.state ?? 'released', row.evidence ?? null, row.checkedAt, row.checkedAt);

  const drain = async (r: Rig) => { while ((await catchUpProjections(r.db)).more) { /* pages until done */ } };

  it('keeps the row every reader already answers, reports its rival whole, and leaves different records alone', async () => {
    const r = legacyRig();
    legacy(r, { id: 'old', namespace: 'sessions', record: 'rec', checkedAt: 5, state: 'merged_unreleased', evidence: '{"source":"session_end:a:0"}' });
    legacy(r, { id: 'new', namespace: 'session', record: 'rec', checkedAt: 9, state: 'released', evidence: '{"source":"session_end:b:0"}' });
    legacy(r, { id: 'plan_a', namespace: 'plan', record: 'plan_key_a', checkedAt: 3 });
    legacy(r, { id: 'other', namespace: 'prompts', record: 'rec', checkedAt: 4 });
    legacy(r, { id: 'mismatch', namespace: 'spores', record: 'sp_x', identity: `${P}:spores:sp_y`, checkedAt: 2 });
    expect(await getReleaseState(r.db, SCOPE, 'session', 'rec')).toMatchObject({ id: 'new', state: 'released' });

    await drain(r);

    const current = r.sqlite.query('SELECT id, namespace, identity_key, state, canonical, source_key FROM knowledge_release_state ORDER BY id').all();
    expect(current).toEqual([
      { id: 'mismatch', namespace: 'spores', identity_key: `${P}:spores:sp_y`, state: 'released', canonical: 0, source_key: null },
      { id: 'new', namespace: 'sessions', identity_key: `${P}:sessions:rec`, state: 'released', canonical: 1, source_key: 'session_end:b:0' },
      { id: 'other', namespace: 'prompts', identity_key: `${P}:prompts:rec`, state: 'released', canonical: 0, source_key: null },
      { id: 'plan_a', namespace: 'plans', identity_key: `${P}:plans:plan_key_a`, state: 'released', canonical: 1, source_key: null },
    ]);
    const report = r.sqlite.query('SELECT row_id, reason, state, winner_id, winner_state, namespace FROM release_state_unresolved ORDER BY row_id').all();
    expect(report).toEqual([
      { row_id: 'mismatch', reason: 'identity_mismatch', state: 'released', winner_id: null, winner_state: null, namespace: 'spores' },
      { row_id: 'old', reason: 'duplicate', state: 'merged_unreleased', winner_id: 'new', winner_state: 'released', namespace: 'sessions' },
      { row_id: 'other', reason: 'unknown_namespace', state: 'released', winner_id: null, winner_state: null, namespace: 'prompts' },
    ]);
    const kept = (r.sqlite.query(`SELECT row_json FROM release_state_unresolved WHERE row_id='old'`).get() as { row_json: string }).row_json;
    expect(JSON.parse(kept)).toMatchObject({ id: 'old', state: 'merged_unreleased', evidence_json: '{"source":"session_end:a:0"}', checked_at: 5 });
    expect(await getReleaseState(r.db, SCOPE, 'session', 'rec')).toMatchObject({ id: 'new', state: 'released', source: 'session_end:b:0' });
    expect((await r.store.describe(P)).unresolvedStates).toBe(3);
  });

  it('answers every record while the catch-up runs, and only then reconciles, never reading an absent row as not released', async () => {
    const r = legacyRig();
    const saved = await r.store.save(P, settings(), 'mem_1', 1);
    legacy(r, { id: 'plain', namespace: 'session', record: 's1', checkedAt: 5, state: 'released', evidence: `{"source":"session_end:${A}:0"}` });
    session(r, 's1', A);
    expect((await r.store.describe(P)).building).toBe(true);
    const seen: string[] = [];
    expect((await check(r, 100 * MIN, REPO, seen)).changed).toBe(0);
    expect(seen).toEqual([]);
    expect(await getReleaseStatesForRecords(r.db, SCOPE, 'session', ['s1'])).toMatchObject({ s1: { state: 'released' } });
    await drain(r);
    expect((await r.store.describe(P)).building).toBe(false);
    expect(due(r)[0]).toMatchObject({ project_id: P, revision: saved.revision });
    await check(r, 200 * MIN, REPO, seen);
    expect(seen.length).toBeGreaterThan(0);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'released' });
  });

  it('takes a session the last check already settled as settled, so the catch-up costs no GitHub reads for finished work', async () => {
    const r = rig();
    await r.store.save(P, settings(), 'mem_1', 1);
    session(r, 's1', B);
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'session', 's1')).toMatchObject({ state: 'merged_unreleased' });
    // The state and settings as an older server left them: typed columns empty, no work rows, catch-up not yet run.
    r.sqlite.run('UPDATE knowledge_release_state SET canonical=0, source_key=NULL, refs_fingerprint=NULL');
    r.sqlite.run('DELETE FROM release_work_due');
    r.sqlite.run(`UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='release_provenance'`);
    await drain(r);
    await r.store.requestCheck(P, 110 * MIN);
    const seen: string[] = [];
    await check(r, 110 * MIN, REPO, seen);
    expect(seen.filter((path) => path.startsWith('/compare'))).toEqual([]);
    expect((await r.store.describe(P)).check).toMatchObject({ status: 'complete', counts: { checked: 0 } });
  });

  it('queues only the sessions whose records lack their answer, so records already carried never read as propagating', async () => {
    const r = legacyRig();
    for (const [sessionId, sporeId] of [['s_same', 'sp_same'], ['s_missing', 'sp_missing']] as const) {
      session(r, sessionId, B);
      spore(r, sporeId, sessionId);
      legacy(r, { id: `st_${sessionId}`, namespace: 'sessions', record: sessionId, state: 'merged_unreleased', checkedAt: 5, evidence: `{"source":"session_end:${B}:0"}` });
    }
    r.sqlite.run(`UPDATE knowledge_release_state SET source_session_id=record_id`);
    legacy(r, { id: 'st_sp_same', namespace: 'spores', record: 'sp_same', state: 'merged_unreleased', checkedAt: 5, evidence: `{"source":"session_end:${B}:0"}` });
    r.sqlite.run(`UPDATE knowledge_release_state SET source_session_id='s_same' WHERE id='st_sp_same'`);
    r.sqlite.run('DELETE FROM release_propagation_due');
    await drain(r);
    expect(r.sqlite.query('SELECT session_id FROM release_propagation_due').all()).toEqual([{ session_id: 's_missing' }]);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_same')).toMatchObject({ state: 'merged_unreleased', propagating: false });
    await check(r, 100 * MIN);
    expect(await getReleaseState(r.db, SCOPE, 'spore', 'sp_missing')).toMatchObject({ state: 'merged_unreleased', propagating: false });
  });

  it('holds one current row per record once placed', async () => {
    const r = legacyRig();
    legacy(r, { id: 'one', namespace: 'sessions', record: 'rec', checkedAt: 5 });
    await drain(r);
    expect(() => r.sqlite.query(`INSERT INTO knowledge_release_state (project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at,canonical)
      VALUES (?, 'two', 'a-different-key', 'sessions', 'rec', 'released', 'high', 9, 9, 1)`).run(P)).toThrow(/UNIQUE/);
  });
});

describe('the release state list', () => {
  const seed = (r: Rig, id: string, namespace: string, checkedAt: number, state = 'released') => r.sqlite.query(
    `INSERT INTO knowledge_release_state (project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at,canonical) VALUES (?,?,?,?,?,?, 'high',?,?,1)`)
    .run(P, id, `${P}:${namespace}:${id}`, namespace, id, state, checkedAt, checkedAt);

  it('walks newest checked first with a stable tie on id, and a cursor reads every row once', async () => {
    const r = rig();
    for (let n = 0; n < 5; n += 1) seed(r, `r${n}`, 'sessions', 100 + Math.floor(n / 2));
    const seen: string[] = [];
    let cursor: ReturnType<typeof decodeReleaseStatesCursor> = null;
    for (;;) {
      const page = await listReleaseStates(r.db, SCOPE, { limit: 2, cursor });
      seen.push(...page.states.map(s => s.id));
      if (page.nextCursor === null) break;
      const url = `https://s/api/projects/${P}/release-states?limit=2&cursor=${encodeURIComponent(page.nextCursor)}`;
      const res = await worker.fetch(await asOwner(r.db, url.replace('https://s', '')), { ...r.env, ...OWNER_ENV });
      expect(res.status).toBe(200);
      const body = await res.json() as { releaseStates: Array<{ id: string }>; nextCursor: string | null };
      seen.push(...body.releaseStates.map(s => s.id));
      if (body.nextCursor === null) break;
      cursor = decodeReleaseStatesCursor(body.nextCursor);
    }
    expect(seen).toEqual(['r4', 'r3', 'r2', 'r1', 'r0']);
  });

  it('refuses a cursor that does not continue this listing, naming the next call', async () => {
    const r = rig();
    seed(r, 'r1', 'sessions', 100);
    const env = { ...r.env, ...OWNER_ENV };
    const bad = await worker.fetch(await asOwner(r.db, `/api/projects/${P}/release-states?cursor=not-a-cursor`), env);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { reason: string }).reason).toContain('without cursor');
    const page = await listReleaseStates(r.db, SCOPE, { state: 'released', limit: 1 });
    expect(page.nextCursor).toBeNull();
    const filtered = (await listReleaseStates(r.db, SCOPE, { state: 'released', limit: 1 })).states;
    expect(filtered.map(s => s.id)).toEqual(['r1']);
    const mismatch = await worker.fetch(await asOwner(r.db, `/api/projects/${P}/release-states?namespace=spore&cursor=${encodeURIComponent(btoa(JSON.stringify([1, 'plan', null, 1, 'x'])))}`), env);
    expect(mismatch.status).toBe(400);
  });

  it('stops a sparse filtered walk at its bound and continues from where it stopped', async () => {
    const r = rig();
    r.sqlite.query(`INSERT INTO knowledge_release_state (project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at,canonical)
      SELECT ?, 'r'||value, ?||':sessions:r'||value, 'sessions', 'r'||value, CASE WHEN value=100 THEN 'released' ELSE 'unknown' END, 'high', value, value, 1 FROM json_each(?)`)
      .run(P, P, JSON.stringify(Array.from({ length: RELEASE_LIST_SCAN + 300 }, (_, n) => n)));
    const first = await listReleaseStates(r.db, SCOPE, { state: 'released', limit: 5 });
    expect(first.states.map(s => s.id)).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    const cursor = decodeReleaseStatesCursor(first.nextCursor!);
    const next = await listReleaseStates(r.db, SCOPE, { state: 'released', limit: 5, cursor });
    expect(next.states.map(s => s.id)).toEqual(['r100']);
    expect(next.nextCursor).toBeNull();
  });
});

describe('the release work on D1', () => {
  it('runs a check, carries its state, places an older row and pages a filtered list', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const d1 = await mf.getD1Database('DB');
      const { db } = measuredStore(d1);
      const secrets = deploymentSecretStore(db, undefined as never);
      await d1.batch([
        d1.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES('${P}','p',1)`),
        d1.prepare("INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('myco', 'Myco', 'built-in', 1, 1)"),
        d1.prepare(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('${P}', 's1', 'machine_1', 'mt_1', 1, 1)`),
        d1.prepare(`INSERT INTO knowledge_git_provenance (project_id, identity_key, session_id, capture_point, captured_at, head_sha, status_hash, created_at) VALUES ('${P}', 'session:s1:session_end', 's1', 'session_end', 10, '${B}', '', 1)`),
        d1.prepare(`INSERT INTO spores (project_id, id, agent_id, observation_type, content, created_at, session_id) VALUES ('${P}', 'sp_1', 'myco', 'decision', 'x', 1, 's1')`),
      ]);
      const store = releaseProvenance(db, secrets);
      await store.save(P, settings({ credential: null }), 'mem_1', 1);
      expect(await checkProject(db, secrets, fakeGithub(REPO), P, 100 * MIN)).toBe(1);
      expect(await getReleaseState(db, SCOPE, 'session', 's1')).toMatchObject({ state: 'merged_unreleased' });
      expect(await getReleaseState(db, SCOPE, 'spore', 'sp_1')).toBeNull();
      await reconcileReleaseProvenance({ db, outbound: fakeGithub(REPO), wrappingKey: undefined } as unknown as ServerEnv, 101 * MIN);
      expect(await getReleaseState(db, SCOPE, 'spore', 'sp_1')).toMatchObject({ state: 'merged_unreleased', propagating: false });
      await d1.prepare(`INSERT INTO knowledge_release_state (project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at) VALUES ('${P}','legacy','${P}:plan:k','plan','k','released','high',5,5)`).run();
      await d1.prepare(`UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='release_provenance'`).run();
      while ((await catchUpProjections(db)).more) { /* pages until done */ }
      expect(await d1.prepare(`SELECT namespace,canonical FROM knowledge_release_state WHERE id='legacy'`).first()).toEqual({ namespace: 'plans', canonical: 1 });
      const page = await listReleaseStates(db, SCOPE, { state: 'released', namespace: 'plan', limit: 5 });
      expect(page).toMatchObject({ states: [{ id: 'legacy' }], nextCursor: null });
      expect(await store.requestCheck(P, 200 * MIN)).toBe(true);
    } finally { await mf.dispose(); }
  }, 120_000);
});

describe('what a record read and a canonicalizing page cost on D1', () => {
  /** Reads of each operation over a Project holding `history` other release rows, with or without planner statistics. */
  async function readsAt(history: number, analyzed: boolean): Promise<Record<string, number>> {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const d1 = await mf.getD1Database('DB');
      const measured = measuredStore(d1);
      await d1.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES('${P}','p',1)`).run();
      const spores = JSON.stringify(Array.from({ length: 10 }, (_, n) => `sp_${n}`));
      await d1.batch([
        d1.prepare(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
          SELECT ?1,'z'||value,?1||':spores:f'||value,'spores','f'||value,'unknown','low',1000+value,1000+value FROM json_each(?2)`).bind(P, JSON.stringify(Array.from({ length: history }, (_, n) => n))),
        d1.prepare(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
          SELECT ?1,'a_'||value,?1||':spore:'||value,'spore',value,'released','high',0,0 FROM json_each(?2)`).bind(P, spores),
        d1.prepare(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at)
          SELECT ?1,'b_'||value,?1||':spores:'||value,'spores',value,'unknown','low',0,0 FROM json_each(?2)`).bind(P, spores),
        d1.prepare(`UPDATE projection_catchup SET done=0,after_key='[]',frontier=NULL,generation=generation+1 WHERE projection='release_provenance'`),
      ]);
      if (analyzed) await d1.prepare('ANALYZE').run();
      const reads: Record<string, number> = {};
      const measure = async (name: string, operation: () => Promise<unknown>) => { measured.reset(); await operation(); reads[name] = measured.reads(); };
      await measure('absent', () => getReleaseState(measured.db, SCOPE, 'session', 'never_checked'));
      await measure('oldest', () => getReleaseState(measured.db, SCOPE, 'spore', 'sp_0'));
      await measure('annotation', () => getReleaseStatesForRecords(measured.db, SCOPE, 'spore', JSON.parse(spores) as string[]));
      await measure('canonicalizingPage', () => catchUpPhase(measured.db, 'releaseStateCurrent', 1));
      return reads;
    } finally { await mf.dispose(); }
  }

  for (const analyzed of [false, true]) {
    it(`reads the same rows at a 1,000- and a 50,000-row history ${analyzed ? 'with' : 'without'} planner statistics`, async () => {
      expect(await readsAt(50_000, analyzed)).toEqual(await readsAt(1_000, analyzed));
    }, 240_000);
  }
});

describe('what a due selection, a reconcile page and a list cost', () => {
  it('reads the same rows whatever the history holds', async () => {
    const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response(null)}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
    try {
      const d1 = await mf.getD1Database('DB');
      const measured = measuredStore(d1);
      const reads: Record<string, number[]> = {};
      await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind('proj_due', 'proj_due').run();
      await d1.prepare(`INSERT INTO release_check_due(project_id,next_at,revision) VALUES('proj_due',1,'r')`).run();
      for (const [project, size] of [['proj_small', 100], ['proj_large', 4000]] as const) {
        const numbers = JSON.stringify(Array.from({ length: size }, (_, n) => n));
        await d1.prepare('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)').bind(project, project).run();
        await d1.prepare(`INSERT INTO release_work_due(project_id,session_id,point,head_sha,cleanliness,captured_at)
          SELECT ?1,'s'||value,'session_end','a','0',value FROM json_each(?2)`).bind(project, numbers).run();
        await d1.prepare(`INSERT INTO knowledge_release_state(project_id,id,identity_key,namespace,record_id,state,confidence,checked_at,created_at,canonical)
          SELECT ?1,'r'||value,?1||':sessions:r'||value,'sessions','r'||value,'unknown','low',value,value,1 FROM json_each(?2)`).bind(project, numbers).run();
        reads[project] = [];
        const measure = async (operation: () => Promise<unknown>) => { measured.reset(); await operation(); reads[project]!.push(measured.reads()); };
        await measure(() => dueReleaseChecks(measured.db, { countedBefore: 10, now: 10, limit: 1 }));
        await measure(() => openReleaseWork(measured.db, project, 1, 50));
        await measure(() => readReleaseStatePage(measured.db, project, { before: null, limit: 50 }));
      }
      expect(reads.proj_large).toEqual(reads.proj_small!);
    } finally { await mf.dispose(); }
  }, 120_000);
});
