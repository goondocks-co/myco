import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_SEARCH } from '@myco-server-worker/db/schema-vNEXT-search.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { pendingSearchBlobs } from '@myco-server-worker/db/search/blob-index.js';
import { BackupObjectsMissingError, createBackup } from '@myco-server-worker/core/backup.js';
import { restoreArtifact } from './helpers/restore-artifact.js';
import { runTick, POWER_THRESHOLDS } from '@myco-server-worker/core/tick.js';
import { searchFixture, searchWords, type SearchFixture } from './helpers/search-fixture.js';
import { sqliteD1 } from './helpers/d1.js';
import { applySchemaSteps } from './helpers/migrate.js';

const opened: SearchFixture[] = [];
afterEach(() => { for (const f of opened.splice(0)) f.sqlite.close(); });
const fixture = () => { const f = searchFixture(); opened.push(f); return f; };
const found = async (f: SearchFixture, query: string, options: Record<string, string> = {}) =>
  (await f.search(query, { mode: 'fts', limit: 100, ...options })).hits.map((hit) => `${hit.type}:${hit.id}`).sort();

describe('the search index follows its records', () => {
  it('finds a record once written, by its current words, and not once removed', async () => {
    const f = fixture();
    f.spore('sp', 'amber body');
    f.session('s1');
    f.card('s1', 't1', 'amber turn', { state: 'pending', card: null });
    expect(await found(f, 'amber')).toEqual(['spore:sp']);
    f.sqlite.run("UPDATE turn_cards SET state = 'carded', card = 'amber turn' WHERE turn_key = 't1'");
    f.sqlite.run("UPDATE sessions SET title = 'amber session' WHERE session_id = 's1'");
    expect(await found(f, 'amber')).toEqual(['card:t1', 'session:s1', 'spore:sp']);
    f.sqlite.run("UPDATE spores SET content = 'jade body' WHERE id = 'sp'");
    expect(await found(f, 'amber')).toEqual(['card:t1', 'session:s1']);
    expect(await found(f, 'jade')).toEqual(['spore:sp']);
    f.sqlite.run("UPDATE spores SET status = 'superseded' WHERE id = 'sp'");
    expect(await found(f, 'jade', { status: 'active' })).toEqual([]);
    expect(await found(f, 'jade', { status: 'superseded' })).toEqual(['spore:sp']);
    f.sqlite.run("DELETE FROM spores WHERE id = 'sp'");
    f.sqlite.run("DELETE FROM turn_cards WHERE turn_key = 't1'");
    expect([...await found(f, 'jade'), ...await found(f, 'amber')]).toEqual(['session:s1']);
  });

  it('finds a session once whose start moves when its transcript is read, at its new time', async () => {
    const f = fixture();
    f.session('moved', { title: 'onyx session', first_received_at: 5_000_000 });
    f.sqlite.run("UPDATE sessions SET occurred_started_at = 2_000_000 WHERE session_id = 'moved'");
    const [hit, ...rest] = (await f.search('onyx', { mode: 'fts' })).hits;
    expect({ hit: hit?.id, created: hit?.created_at, rest }).toEqual({ hit: 'moved', created: 2_000_000, rest: [] });
  });

  it('stops finding a deleted session\'s session, turns and plans at once, before its records are removed', async () => {
    const f = fixture();
    f.session('gone', { title: 'quartz session' });
    f.card('gone', 't1', 'quartz turn');
    f.plan('plan', 'quartz plan', { session_id: 'gone' });
    expect(await found(f, 'quartz')).toEqual(['card:t1', 'plan:plan', 'session:gone']);
    f.insert('session_tombstones', { project_id: 'search-a', session_id: 'gone', reason: 'deleted', created_at: 2_000, created_by: 'member' });
    expect(await found(f, 'quartz')).toEqual([]);
  });

  it('never finds a plan body stored apart until it is proved processed, then finds it, and loses it when the plan goes', async () => {
    const f = fixture();
    await f.blob('body', 'hidden opalbody words');
    f.spilledPlan('spilled', 'body', { proved: false });
    await f.index();
    expect(await found(f, 'opalbody')).toEqual([]);
    f.prove('spilled', 'body');
    await f.index();
    expect(await found(f, 'opalbody')).toEqual(['plan:spilled']);
    f.sqlite.run("DELETE FROM plans WHERE plan_key = 'spilled'");
    expect(await found(f, 'opalbody')).toEqual([]);
    await f.index();
    expect({ found: await found(f, 'opalbody'), pending: await pendingSearchBlobs(f.db, 'search-a') }).toEqual({ found: [], pending: 0 });
  });

  it('finds every one of a hundred records written in the same second', async () => {
    const f = fixture();
    f.sqlite.transaction(() => { for (let i = 0; i < 100; i += 1) f.spore(`same${i}`, 'pyrite body', { created_at: 7_000_123 }); })();
    expect(await found(f, 'pyrite')).toHaveLength(100);
  });
});

describe('building the index for records it does not hold yet', () => {
  it('answers building after the upgrade until every existing record is indexed, then ready, and a record edited during the build holds its new words', async () => {
    const sqlite = new Database(':memory:');
    try {
      const db = sqliteD1(sqlite);
      await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version < NEXT_SEARCH));
      sqlite.run("INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('agent', 'agent', 'built-in', 1, 1)");
      sqlite.run("INSERT INTO projects (project_id, name, created_at) VALUES ('search-a', 'search-a', 1)");
      for (let i = 0; i < 120; i += 1) {
        sqlite.run("INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) VALUES ('search-a', ?, 'agent', 'gotcha', 'active', 'beryl body', ?)", [`b${String(i).padStart(3, '0')}`, 1_000 + i]);
      }
      await applySchemaSteps(db, SCHEMA_STEPS);
      const words = (query: string, cursor?: string) => searchWords(db, { projectId: 'search-a' }, { query, mode: 'fts', limit: 100, type: 'spore', ...(cursor === undefined ? {} : { cursor }) });
      const every = async (query: string) => {
        const listed: string[] = [];
        for (let answer = await words(query); ; answer = await words(query, answer.nextCursor!)) {
          listed.push(...answer.hits.map((hit) => hit.id));
          if (answer.nextCursor === null) return listed.sort();
        }
      };
      expect((await words('beryl')).coverage.state).toBe('building');
      await catchUpProjections(db, { budget: { calls: 12, wallMs: 60_000 } });
      sqlite.run("UPDATE spores SET content = 'garnet body' WHERE id IN ('b000', 'b119')");
      for (let round = 0; round < 20; round += 1) if (!(await catchUpProjections(db)).more) break;
      expect({ state: (await words('beryl')).coverage.state, beryl: (await every('beryl')).length, garnet: await every('garnet') })
        .toEqual({ state: 'ready', beryl: 118, garnet: ['b000', 'b119'] });
    } finally { sqlite.close(); }
  });
});

describe('restoring a backup', () => {
  it('carries no search index, finds restored records at once and indexes their stored bodies on the next wake', async () => {
    const source = fixture();
    await source.blob('restore-body', 'restoredneedle deepbody');
    source.spilledPlan('restored', 'restore-body');
    source.plan('restored-plan', 'restoredneedle inlinebody');
    await source.index();
    const backup = await createBackup(source.db, source.bucket, { producer: 'test', now: 2000 });
    const artifact = new TextDecoder().decode(source.bucket.objects.get(backup.key)!.bytes);
    expect(artifact).not.toContain('"t":"search_');
    const bare = fixture();
    await expect(restoreArtifact(bare.db, { authorization: { kind: 'recovery' }, text: artifact, allowForeignLineage: true })).rejects.toBeInstanceOf(BackupObjectsMissingError);
    const target = fixture();
    await target.blob('restore-body', 'restoredneedle deepbody');
    const result = await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact, allowForeignLineage: true });
    expect(result.tables.plans.inserted).toBe(2);
    expect(await found(target, 'restoredneedle')).toEqual(['plan:restored-plan']);
    expect(await pendingSearchBlobs(target.db)).not.toBe(0);
    const tick = await runTick(target.serverEnv, POWER_THRESHOLDS.deepSleepMs + 100_000);
    expect(tick.state).toBe('active');
    for (let wake = 0; wake < 5 && (await pendingSearchBlobs(target.db)) !== 0; wake += 1) await runTick(target.serverEnv, POWER_THRESHOLDS.deepSleepMs + 200_000 + wake);
    expect(await found(target, 'deepbody')).toEqual(['plan:restored']);
    const repeated = await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text: artifact, allowForeignLineage: true });
    expect(Object.values(repeated.tables).every((table) => table.inserted === 0)).toBe(true);
  });
});
