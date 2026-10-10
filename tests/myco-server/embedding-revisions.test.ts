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
import { EMBEDDING_SOURCES, embeddingSourcesView, SOURCES_WITH_PRESENTED_SESSION_DATE } from '@myco-server-worker/db/schema-v20.js';
import { processedResourceProofSql } from '@myco-server-worker/core/processed-resources.js';
import { RELEASE_REVISION_COLUMNS } from '@myco-server-worker/db/schema-v49.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configureSqliteLibrary } from '../../packages/myco-server/src/platform/bun/sqlite-library.js';
import { sqliteVectorStore } from '../../packages/myco-server/src/platform/bun/vectors.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { A, B, D, MISSING, REPO, fakeGithub, type Repo } from './helpers/github-fake.js';

configureSqliteLibrary();
const P = 'proj_1';
const SERVER_SRC = join(import.meta.dir, '..', '..', 'packages', 'myco-server', 'src');
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
    seedSessionRecords(f, 's_2');
    f.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_2', 'two', 1)`);
    // A spore under the session's own id, so a release state moved to the spores namespace names a record that exists.
    f.insert('spores', { project_id: P, id: 's_1', agent_id: 'myco', session_id: 's_1', observation_type: 'gotcha', content: 'Keyed like the session', created_at: 3 });
    f.insert('skill_records', { project_id: P, id: 'sk_1', agent_id: 'myco', name: 'skill-one', display_name: 'Skill one', description: 'Does one thing',
      status: 'active', generation: 1, path: 'skills/skill-one', created_at: 5, updated_at: 5 });
    f.insert('knowledge_release_state', { project_id: P, id: 'rs_1', identity_key: `${P}:sessions:s_1`, namespace: 'sessions', record_id: 's_1',
      source_session_id: 's_1', state: 'merged_unreleased', confidence: 'medium', basis_kind: 'integration_ref', basis_ref: 'main', basis_sha: B,
      reason: 'On main', evidence_json: '{"source":"session_end:b:0"}', checked_at: 10, created_at: 10 });
    return f;
  }

  /** The record each source table's seeded row is keyed by. */
  const RECORDS: Record<string, [string]> = { sessions: ['s_1'], spores: ['sp_s_1'], plans: ['plan_s_1'], skill_records: ['sk_1'] };

  /** Columns the embedding view reads that a source's revision does not follow, each with what makes that safe. */
  const SOURCE_EXCEPTIONS: Record<string, Record<string, string>> = {
    sessions: {
      session_id: "the record's key, which no update changes",
      first_received_at: 'written when the session row is inserted and never after',
      occurred_started_at: 'followed by sessions_embedding_occurred',
      occurred_ended_at: 'followed by sessions_embedding_occurred',
    },
  };
  /** Release state columns the view reads that its revision does not follow: they order rows for one record, and the identity key holds one row per record. */
  const RELEASE_VIEW_EXCEPTIONS: Record<string, string> = { checked_at: 'orders rows for one record', id: 'orders rows for one record' };

  const watched = (s: { columns: string }) => s.columns.split(',').map((c) => c.trim());
  const CLAUSES = ['title', 'text', 'blob', 'status', 'session', 'prompt', 'created', 'observation', 'eligible'] as const;

  /** Every column of the source's table that one of its view clauses names. */
  function referencedColumns(f: ReturnType<typeof fixture>, s: (typeof SOURCES_WITH_PRESENTED_SESSION_DATE)[number]): string[] {
    const columns = new Set((f.sqlite.query(`PRAGMA table_info(${s.table})`).all() as { name: string }[]).map((c) => c.name));
    const words = CLAUSES.flatMap((clause) => s[clause].replace(/'[^']*'/g, ' ').match(/\b[a-z_][a-z0-9_]*\b/gi) ?? []);
    return [...new Set(words.filter((w) => columns.has(w)))].sort();
  }

  /** Every release state column the embedding view reads. */
  const releaseColumnsTheViewReads = () => [...new Set([...embeddingSourcesView(EMBEDDING_SOURCES).matchAll(/\bk\.(\w+)/g)].map((m) => m[1]))].sort();

  /** A value for the column that differs from the seeded one and satisfies the table's constraints. */
  function changedValue(table: string, column: string): string {
    const special: Record<string, string> = {
      'spores.session_id': "'s_2'", 'plans.session_id': "'s_2'", 'spores.status': "'superseded'", 'plans.status': "'completed'",
      'skill_records.status': "'retired'", 'sessions.ended_at': 'NULL',
      'knowledge_release_state.project_id': "'proj_2'", 'knowledge_release_state.namespace': "'spores'", 'knowledge_release_state.record_id': "'s_2'",
      'knowledge_release_state.state': "'released'", 'knowledge_release_state.confidence': "'high'",
    };
    return special[`${table}.${column}`] ?? `CASE WHEN typeof(${column}) = 'integer' THEN ${column} + 1 ELSE COALESCE(${column}, '') || ' changed' END`;
  }

  const moved = (before: Revision[], after: Revision[]) => {
    const was = new Map(before.map((r) => [`${r.type}:${r.record_id}`, r.revision]));
    return after.filter((r) => was.get(`${r.type}:${r.record_id}`) !== r.revision).map((r) => `${r.type}:${r.record_id}`).sort();
  };

  it('leaves every revision as it was when any column of any embeddable row is written back unchanged', () => {
    const f = seededSources();
    const tables = (f.sqlite.query(`SELECT DISTINCT tbl_name AS t FROM sqlite_master WHERE type = 'trigger'
      AND (sql LIKE '%INSERT INTO embedding_versions(%' OR sql LIKE '%UPDATE embedding_versions SET%') AND sql LIKE '%AFTER UPDATE%' ORDER BY tbl_name`).all() as { t: string }[]).map((r) => r.t);
    // A new table whose updates re-revision a record is seeded here before this passes.
    expect(tables).toEqual(['knowledge_release_state', 'plans', 'sessions', 'skill_records', 'spores']);
    const before = f.revisions();
    expect([...new Set(before.map((r) => r.type))].sort()).toEqual(['plan', 'session', 'skill', 'spore']);
    for (const table of tables) {
      const columns = (f.sqlite.query(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
      f.sqlite.run(`UPDATE ${table} SET ${columns.map((c) => `${c} = ${c}`).join(', ')}`);
      for (const column of columns) {
        f.sqlite.run(`UPDATE ${table} SET ${column} = ${column}`);
        expect({ table, column, revisions: f.revisions() }).toEqual({ table, column, revisions: before });
      }
    }
  });

  it('gives a record a new revision when any value its revision follows changes, and no other record', () => {
    const probe = fixture();
    for (const s of EMBEDDING_SOURCES) {
      const [key] = RECORDS[s.table];
      // Every column the revision follows, and every column the view builds the record from but the named exceptions.
      const presented = SOURCES_WITH_PRESENTED_SESSION_DATE.find((x) => x.table === s.table)!;
      const read = [...referencedColumns(probe, s), ...referencedColumns(probe, presented)].filter((c) => !(c in (SOURCE_EXCEPTIONS[s.table] ?? {})));
      for (const column of [...new Set([...watched(s), ...read])]) {
        const f = seededSources();
        const before = f.revisions();
        const sql = `UPDATE ${s.table} SET ${column} = ${changedValue(s.table, column)} WHERE project_id = '${P}' AND ${s.id} = '${key}'`;
        f.sqlite.run(sql);
        expect({ sql, changed: f.sqlite.query(`SELECT changes() AS n`).get() }).toEqual({ sql, changed: { n: 1 } });
        expect({ sql, moved: moved(before, f.revisions()) }).toEqual({ sql, moved: [`${s.type}:${key}`] });
      }
    }
  });

  it('gives the records a release state names a new revision when any value it follows changes, and no other record', () => {
    // Every value the release trigger follows, and every column the embedding view reads from the release state but the two named exceptions.
    const columns = [...new Set([...RELEASE_REVISION_COLUMNS.split(',').map((c) => c.trim()), ...releaseColumnsTheViewReads()])]
      .filter((c) => !(c in RELEASE_VIEW_EXCEPTIONS));
    const expected: Record<string, string[]> = {
      project_id: ['session:s_1'], namespace: ['session:s_1', 'spore:s_1'], record_id: ['session:s_1', 'session:s_2'],
      state: ['session:s_1'], confidence: ['session:s_1'],
    };
    expect(columns.sort()).toEqual(Object.keys(expected).sort());
    for (const column of columns) {
      const f = seededSources();
      const before = f.revisions();
      // The source session is scoped to the Project, so a row moved to another Project names none there.
      const also = column === 'project_id' ? ', source_session_id = NULL' : '';
      const sql = `UPDATE knowledge_release_state SET ${column} = ${changedValue('knowledge_release_state', column)}${also} WHERE id = 'rs_1'`;
      f.sqlite.run(sql);
      expect({ sql, moved: moved(before, f.revisions()) }).toEqual({ sql, moved: expected[column] });
    }
  });

  it('follows every column the embedding view builds a record from, but the named exceptions', () => {
    const f = fixture();
    const current = f.sqlite.query(`SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'embedding_sources'`).get() as { sql: string };
    // The view a database serves is the one built from the presented session sources.
    const admittedSources = SOURCES_WITH_PRESENTED_SESSION_DATE.map((source) => source.type === 'plan'
      ? { ...source, eligible: `content IS NOT NULL OR (blob_key IS NOT NULL AND ${processedResourceProofSql('plans.project_id', 'plan', 'plans.plan_key', 'plans.blob_key')})` }
      : source);
    expect(current.sql).toBe(embeddingSourcesView(admittedSources).replace('CREATE VIEW IF NOT EXISTS', 'CREATE VIEW'));
    for (const sources of [EMBEDDING_SOURCES, SOURCES_WITH_PRESENTED_SESSION_DATE]) {
      for (const s of sources) {
        const exceptions = SOURCE_EXCEPTIONS[s.table] ?? {};
        const unwatched = referencedColumns(f, s).filter((c) => !watched(s).includes(c) && !(c in exceptions));
        expect({ table: s.table, unwatched }).toEqual({ table: s.table, unwatched: [] });
      }
    }
    const release = releaseColumnsTheViewReads().filter((c) => !RELEASE_REVISION_COLUMNS.includes(c) && !(c in RELEASE_VIEW_EXCEPTIONS));
    expect({ table: 'knowledge_release_state', unwatched: release }).toEqual({ table: 'knowledge_release_state', unwatched: [] });
  });

  it('holds each named exception to the reason it gives', () => {
    const f = fixture();
    // The presented session dates are followed by their own trigger.
    const occurred = (f.sqlite.query(`SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'sessions_embedding_occurred'`).get() as { sql: string }).sql;
    for (const column of ['occurred_started_at', 'occurred_ended_at']) {
      expect(occurred).toContain(`new.${column} IS NOT old.${column}`);
      expect(occurred).toMatch(new RegExp(`AFTER UPDATE OF [\\w\\s,]*\\b${column}\\b`));
    }
    // Nothing under src writes a session's first receipt after inserting the row.
    const writers = [...new Bun.Glob('**/*.ts').scanSync(SERVER_SRC)]
      .filter((file) => /first_received_at\s*=|SET[^;`]*\bfirst_received_at\b/i.test(readFileSync(join(SERVER_SRC, file), 'utf8')));
    expect(writers).toEqual([]);
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
      AND (sql LIKE '%INSERT INTO embedding_versions(%' OR sql LIKE '%UPDATE embedding_versions SET%') AND sql LIKE '%AFTER UPDATE%' ORDER BY name`).all() as { name: string; sql: string }[];
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
