/**
 * A record's embedding revision follows the values its vector is built from
 * (#1430). An UPDATE that writes back what a row held, on any column of an
 * embeddable table or of a release state, leaves every revision as it was; a
 * changed value the revision follows gives the record a new one. A release
 * check that records new refs under an unchanged state and confidence queues
 * no embedding work; a real change of state re-embeds exactly the records it
 * names.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { releaseProvenance, reconcileReleaseProvenance, type ReleaseProvenanceWrite } from '@myco-server-worker/core/release-provenance.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { reconcileEmbedding } from '@myco-server-worker/core/embedding/reconcile.js';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import type { EmbeddingProvider } from '@myco-server-worker/core/embedding/provider.js';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { A, B, D, MISSING, REPO, fakeGithub, type Repo } from './helpers/github-fake.js';

configureSqliteLibrary();
const P = 'proj_1';
const MIN = 60_000;
const opened: ReturnType<typeof sqliteEnv>[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });

type Revision = { type: string; record_id: string; revision: string };

function fixture() {
  const f = sqliteEnv(); opened.push(f);
  const insert = (table: string, row: Record<string, unknown>) => f.sqlite.query(
    `INSERT INTO ${table}(${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(() => '?').join(',')})`,
  ).run(...Object.values(row) as never[]);
  insert('agents', { id: 'myco', name: 'Myco', source: 'built-in', enabled: 1, created_at: 1 });
  const revisions = () => f.sqlite.query('SELECT type, record_id, revision FROM embedding_versions ORDER BY type, record_id').all() as Revision[];
  const revisionOf = (type: string, recordId: string) => revisions().find((r) => r.type === type && r.record_id === recordId)?.revision;
  return { ...f, insert, revisions, revisionOf };
}

/** A session with a summary, so it is an embedding source, and the spore and plan it produced. */
function seedSessionRecords(f: ReturnType<typeof fixture>, sessionId: string) {
  f.insert('sessions', { project_id: P, session_id: sessionId, machine_id: 'machine_1', created_by_token_id: 'mt_1', first_received_at: 1, last_received_at: 1,
    title: `Title ${sessionId}`, summary: `Summary of ${sessionId}`, started_at: 1, ended_at: 2 });
  f.insert('spores', { project_id: P, id: `sp_${sessionId}`, agent_id: 'myco', session_id: sessionId, observation_type: 'decision', content: `Decision in ${sessionId}`, created_at: 3 });
  f.insert('plans', { project_id: P, plan_key: `plan_${sessionId}`, session_id: sessionId, event_id: `ev_${sessionId}`, machine_id: 'machine_1', title: 'Plan',
    content: `Plan of ${sessionId}`, content_hash: `h_${sessionId}`, status: 'active', created_at: 4, updated_at: 4, token_id: 'mt_1', received_at: 4 });
}

describe('embedding revisions follow the values a vector is built from', () => {
  /** Every table whose UPDATE trigger writes an embedding revision, with a seeded row to write back. */
  function seededSources() {
    const f = fixture();
    seedSessionRecords(f, 's_1');
    f.insert('skill_records', { project_id: P, id: 'sk_1', agent_id: 'myco', name: 'skill-one', display_name: 'Skill one', description: 'Does one thing',
      status: 'active', generation: 1, path: 'skills/skill-one', created_at: 5, updated_at: 5 });
    f.insert('knowledge_release_state', { project_id: P, id: 'rs_1', identity_key: `${P}:sessions:s_1`, namespace: 'sessions', record_id: 's_1',
      source_session_id: 's_1', state: 'merged_unreleased', confidence: 'medium', basis_kind: 'integration_ref', basis_ref: 'main', basis_sha: B,
      reason: 'On main', evidence_json: '{"source":"session_end:b:0"}', checked_at: 10, created_at: 10 });
    return f;
  }

  it('leaves every revision as it was when any column of any embeddable row is written back unchanged', () => {
    const f = seededSources();
    const tables = (f.sqlite.query(`SELECT DISTINCT tbl_name AS t FROM sqlite_master WHERE type = 'trigger'
      AND sql LIKE '%embedding_versions%' AND sql LIKE '%AFTER UPDATE%' ORDER BY tbl_name`).all() as { t: string }[]).map((r) => r.t);
    // A new table whose updates re-revision a record is seeded here before this passes.
    expect(tables).toEqual(['knowledge_release_state', 'plans', 'sessions', 'skill_records', 'spores']);
    const before = f.revisions();
    expect(before.map((r) => r.type).sort()).toEqual(['plan', 'session', 'skill', 'spore']);
    for (const table of tables) {
      const columns = (f.sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      f.sqlite.run(`UPDATE ${table} SET ${columns.map((c) => `${c} = ${c}`).join(', ')}`);
      for (const column of columns) {
        f.sqlite.run(`UPDATE ${table} SET ${column} = ${column}`);
        expect({ table, column, revisions: f.revisions() }).toEqual({ table, column, revisions: before });
      }
    }
  });

  it('gives a record a new revision when a value its revision follows changes, and only that record', () => {
    const f = seededSources();
    const changes: Array<[string, string, string]> = [
      ['session', 's_1', `UPDATE sessions SET summary = 'A new summary' WHERE session_id = 's_1'`],
      ['session', 's_1', `UPDATE sessions SET ended_at = NULL WHERE session_id = 's_1'`],
      ['spore', 'sp_s_1', `UPDATE spores SET status = 'superseded' WHERE id = 'sp_s_1'`],
      ['plan', 'plan_s_1', `UPDATE plans SET content = 'Revised plan', content_hash = 'h2' WHERE plan_key = 'plan_s_1'`],
      ['skill', 'sk_1', `UPDATE skill_records SET description = 'Does another thing' WHERE id = 'sk_1'`],
      ['session', 's_1', `UPDATE knowledge_release_state SET state = 'released' WHERE id = 'rs_1'`],
      ['session', 's_1', `UPDATE knowledge_release_state SET confidence = 'high' WHERE id = 'rs_1'`],
    ];
    for (const [type, recordId, sql] of changes) {
      const before = f.revisions();
      f.sqlite.run(sql);
      const after = f.revisions();
      const moved = after.filter((r, i) => r.revision !== before[i].revision).map((r) => `${r.type}:${r.record_id}`);
      expect({ sql, moved }).toEqual({ sql, moved: [`${type}:${recordId}`] });
    }
  });

  it('keeps the revision when a release state records a new check under the same state and confidence', () => {
    const f = seededSources();
    const before = f.revisions();
    f.sqlite.run(`UPDATE knowledge_release_state SET checked_at = 20, updated_at = 20, reason = 'Still on main', basis_ref = 'main',
      evidence_json = '{"source":"session_end:b:0","refs_fingerprint":"moved"}' WHERE id = 'rs_1'`);
    expect(f.revisions()).toEqual(before);
  });

  it('fires each revision trigger on an UPDATE only when a column it names holds a different value', () => {
    const f = fixture();
    const triggers = f.sqlite.query(`SELECT name, sql FROM sqlite_master WHERE type = 'trigger'
      AND sql LIKE '%embedding_versions%' AND sql LIKE '%AFTER UPDATE%' ORDER BY name`).all() as { name: string; sql: string }[];
    expect(triggers.length).toBeGreaterThan(0);
    for (const { name, sql } of triggers) {
      const named = /AFTER UPDATE OF ([\w\s,]+?) ON /.exec(sql)?.[1].split(',').map((c) => c.trim()) ?? [];
      const compared = [...sql.matchAll(/(?:old\.(\w+) IS NOT new\.\1|new\.(\w+) IS NOT old\.\2)/g)].map((m) => m[1] ?? m[2]);
      expect({ name, named: named.length > 0, compared: [...new Set(compared)].sort() }).toEqual({ name, named: true, compared: [...named].sort() });
    }
  });
});

describe('the release check re-embeds only what changed state', () => {
  const TOKEN = 'fixture-release-token-with-no-real-permissions';
  const settings: ReleaseProvenanceWrite = {
    revision: null, enabled: true, githubRepo: 'o/r',
    productionRefs: ['refs/tags/a/v*', 'refs/tags/b/v*'], integrationRefs: ['origin/main'], packageMap: [],
    includeUnknown: true, maxLookups: 50, credential: { token: TOKEN },
  };

  async function configured() {
    const f = fixture();
    f.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
    const store = releaseProvenance(f.db, deploymentSecretStore(f.db, f.serverEnv.wrappingKey));
    await store.save(P, settings, 'mem_1', 1);
    // Released, merged but unreleased, on no release line, and not on GitHub at all.
    for (const [sessionId, headSha] of [['s_released', A], ['s_merged', B], ['s_nowhere', D], ['s_unpushed', MISSING]] as const) {
      seedSessionRecords(f, sessionId);
      f.insert('knowledge_git_provenance', { project_id: P, identity_key: `session:${sessionId}:session_end`, session_id: sessionId, capture_point: 'session_end',
        captured_at: 10, head_sha: headSha, is_dirty: 0, status_hash: '', created_at: 10 });
    }
    const provider: EmbeddingProvider = { modelKey: 'test-model', embed: async () => [1, 0] };
    const context = { db: f.db, blobs: f.bucket, vectors: sqliteVectorStore(f.sqlite), provider };
    const embedAll = async (now: number) => {
      for (let i = 0; i < 100; i++) if ((await reconcileEmbedding(context, P, now)).phase === 'settled') return;
      throw new Error('embedding did not settle');
    };
    const check = (repo: Repo, now: number) => {
      const env = { ...f.serverEnv, outbound: fakeGithub(repo) };
      return store.requestCheck(P, now).then(() => reconcileReleaseProvenance(env, now));
    };
    const pending = (now: number) => hasEmbeddingWork(f.db, P, provider.modelKey, now);
    const states = () => f.sqlite.query(`SELECT namespace, record_id, state, confidence FROM knowledge_release_state ORDER BY namespace, record_id`).all();
    const receipts = () => (f.sqlite.query('SELECT COUNT(*) AS n FROM embedding_receipts').get() as { n: number }).n;
    return { f, check, embedAll, pending, states, receipts, store };
  }

  it('leaves every revision unchanged and queues no embedding work when a check finds no new state, identical refs or moved ones', async () => {
    const { f, check, embedAll, pending, states, receipts, store } = await configured();
    expect(await check(REPO, 100 * MIN)).toBe(4);
    await embedAll(100 * MIN);
    expect(await pending(100 * MIN)).toBe(false);
    const revisions = f.revisions();
    const held = states();
    const embedded = receipts();

    // The same refs again: nothing is re-classified.
    await check(REPO, 110 * MIN);
    // Refs that moved without touching any captured commit: every unreleased session is classified again and stays as it was.
    const moved: Repo = { ...REPO, tags: [...REPO.tags, 'refs/tags/b/v2.1.0'], contains: { ...REPO.contains, 'refs/tags/b/v2.1.0': [] } };
    expect(await check(moved, 120 * MIN)).toBe(0);
    expect((await store.describe(P)).check).toMatchObject({ status: 'complete', counts: { checked: 3, changed: 0, unchanged: 3 } });

    expect(states()).toEqual(held);
    expect(f.revisions()).toEqual(revisions);
    expect(await pending(130 * MIN)).toBe(false);
    await embedAll(130 * MIN);
    expect(receipts()).toBe(embedded);
  });

  it('re-embeds a session and the spore and plan it produced when a tag releases its commit, and nothing else', async () => {
    const { f, check, embedAll, pending } = await configured();
    await check(REPO, 100 * MIN);
    await embedAll(100 * MIN);
    const before = f.revisions();

    const tagged: Repo = { ...REPO, tags: [...REPO.tags, 'refs/tags/a/v1.3.0'], contains: { ...REPO.contains, 'refs/tags/a/v1.3.0': [A, B] } };
    expect(await check(tagged, 200 * MIN)).toBe(1);
    const moved = f.revisions().filter((r, i) => r.revision !== before[i].revision).map((r) => `${r.type}:${r.record_id}`);
    expect(moved).toEqual(['plan:plan_s_merged', 'session:s_merged', 'spore:sp_s_merged']);
    expect(await pending(200 * MIN)).toBe(true);
  });
});
