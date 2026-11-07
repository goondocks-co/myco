import { readSwitch } from '@myco-server-worker/core/embedding/switch-store.js';
import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { settingsWriter, settingsRevisions, observedSettingsGuard, writeSwitchedEmbedding, CURATION_DAILY_LIMIT_LEAF } from '@myco-server-worker/core/settings.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { migrateAndSeed } from './helpers/d1.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPut, OWNER_ENV } from './helpers/owner.js';

const handles: Database[] = [];
afterEach(() => { for (const handle of handles.splice(0)) handle.close(); });
function rig() {
  const sqlite = migrateAndSeed(new Database(':memory:'));
  handles.push(sqlite);
  return { sqlite, db: sqliteRelationalStore(sqlite) };
}
const isWrite = (statements: PreparedStatement[]) => statements.some(statement =>
  Reflect.get(statement, 'sql')?.includes('$[settings_revision_conflict]'));

it('keeps concurrent sibling task switches through the real writer and native store', async () => {
  const r = rig();
  let arrivals = 0;
  let release!: () => void;
  const bothRead = new Promise<void>(resolve => { release = resolve; });
  const db: RelationalStore = { ...r.db, batch: async statements => {
    if (isWrite(statements) && arrivals < 2) {
      if (++arrivals === 2) release();
      await bothRead;
    }
    return r.db.batch(statements);
  } };
  const writer = settingsWriter(db);
  const results = await Promise.all([
    writer.setTaskSwitch('title-summary', true, 'one', 1),
    writer.setTaskSwitch('canopy-map', true, 'two', 1),
  ]);
  expect(arrivals).toBe(2);
  expect(results).toEqual([{ applied: true }, { applied: true }]);
  expect((await writer.leaves())['agent.tasks']?.value).toEqual({
    'title-summary': { schedule: { enabled: true } }, 'canopy-map': { schedule: { enabled: true } },
  });
});

it('reports conflict after a second patch race and never reports that patch applied', async () => {
  const r = rig();
  let races = 0;
  const db: RelationalStore = { ...r.db, batch: async statements => {
    if (isWrite(statements)) {
      races++;
      await settingsWriter(r.db).setTaskSwitch('canopy-map', races % 2 === 1, 'other', 1);
    }
    return r.db.batch(statements);
  } };
  const result = await settingsWriter(db).setTaskSwitch('title-summary', true, 'loser', 1);
  expect(races).toBe(2);
  expect(result).toEqual({ applied: false, refusal: { reason: 'conflict', leaf: 'agent.tasks', revision: 2 } });
  expect((await settingsWriter(r.db).leaves())['agent.tasks']?.value).toEqual({ 'canopy-map': { schedule: { enabled: false } } });
});

it('distinguishes reset then the same value at the same timestamp and rejects stale readers', async () => {
  const r = rig();
  const writer = settingsWriter(r.db);
  const leaf = 'instructions.template';
  await writer.setLeaf(leaf, 'same', 'owner', 1);
  const revision = (await settingsRevisions(r.db))[leaf]!;
  const guards = await Promise.all([false, true].map(compact => observedSettingsGuard(r.db, [leaf], compact)));
  await writer.resetLeaf(leaf, 'owner', 1);
  const resetRevision = (await settingsRevisions(r.db))[leaf]!;
  expect(resetRevision).toBeGreaterThan(revision);
  await writer.setLeaf(leaf, 'same', 'owner', 1);
  const current = (await settingsRevisions(r.db))[leaf]!;
  expect(current).toBeGreaterThan(resetRevision);
  for (const guard of guards) {
    expect(await r.db.prepare(`SELECT ${guard.sql} AS unchanged`).bind(...guard.params).first()).toEqual({ unchanged: 0 });
  }
  expect(await writer.setLeaf(leaf, 'stale', 'owner', 1, revision)).toEqual({ applied: false, refusal: { reason: 'conflict', leaf, revision: current } });
  expect(await writer.resetLeaf(leaf, 'owner', 1, revision)).toMatchObject({ applied: false, refusal: { reason: 'conflict', revision: current } });
  expect((await writer.leaves())[leaf]?.value).toBe('same');
  await writer.resetLeaf(leaf, 'owner', 1);
  const absentRevision = (await settingsRevisions(r.db))[leaf]!;
  await writer.resetLeaf(leaf, 'owner', 1);
  expect((await settingsRevisions(r.db))[leaf]!).toBeGreaterThan(absentRevision);
});

it('asserts Project activity inside the settings commit and writes no override after archival', async () => {
  const r = rig();
  let archived = false;
  const db: RelationalStore = { ...r.db, batch: async statements => {
    if (isWrite(statements)) {
      archived = true;
      r.sqlite.run("UPDATE projects SET archived_at=1 WHERE project_id='proj_1'");
    }
    return r.db.batch(statements);
  } };
  expect(await settingsWriter(db).setProjectLeaf('proj_1', CURATION_DAILY_LIMIT_LEAF, 3, 'owner', 1)).toEqual({
    applied: false, refusal: { reason: 'invalid_value', leaf: CURATION_DAILY_LIMIT_LEAF, detail: 'Project is not active' },
  });
  expect(archived).toBe(true);
  expect(r.sqlite.query('SELECT * FROM project_settings').all()).toEqual([]);
  expect(await settingsRevisions(r.db, 'proj_1')).toEqual({});
});

it('rolls back a multi-leaf retention write when its observed sibling revision changes', async () => {
  const r = rig();
  let raced = false;
  const db: RelationalStore = { ...r.db, batch: async statements => {
    if (isWrite(statements) && !raced) {
      raced = true;
      await settingsWriter(r.db).setLeaf('retention.transcripts', 0, 'winner', 1);
    }
    return r.db.batch(statements);
  } };
  expect(await settingsWriter(db).setLeaf('retention.raw_days', 30, 'loser', 1)).toMatchObject({ applied: false, refusal: { reason: 'conflict' } });
  expect(r.sqlite.query('SELECT leaf,value,updated_by FROM deployment_settings').all()).toEqual([
    { leaf: 'retention.transcripts', value: '0', updated_by: 'winner' },
  ]);
});

it('rolls back selection leaves when completion no longer ends its switch inside the batch', async () => {
  const r = rig();
  r.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('embedding.provider','"ollama"',1,'owner')`);
  r.sqlite.run(`INSERT INTO embedding_switches(slot,id,provider,model,endpoint,model_key,from_model_key,estimated_tokens,estimated_sources,progressed_at,state,started_at,started_by,updated_at)
    VALUES('deployment','switch','ollama','nomic-embed-text',NULL,'new','old',0,0,1,'building',1,'owner',1)`);
  r.sqlite.run(`CREATE TRIGGER pause_selection AFTER INSERT ON deployment_settings WHEN NEW.leaf='embedding.model'
    BEGIN UPDATE embedding_switches SET state='paused' WHERE slot='deployment'; END`);
  const before = await settingsWriter(r.db).leaves();
  const revisions = await settingsRevisions(r.db);
  const sw = await readSwitch(r.db);
  expect(sw).not.toBeNull();
  expect(await writeSwitchedEmbedding(r.db, { 'embedding.provider': 'ollama', 'embedding.model': 'nomic-embed-text' }, 'owner', 2, sw!)).toBe(false);
  expect(await settingsWriter(r.db).leaves()).toEqual(before);
  expect(await settingsRevisions(r.db)).toEqual(revisions);
  expect((await readSwitch(r.db))?.state).toBe('building');
});

it('migrates stored settings and reset receipts once without changing their bytes', () => {
  const sqlite = new Database(':memory:');
  handles.push(sqlite);
  for (const step of SCHEMA_STEPS.filter(step => step.version < 710)) for (const sql of step.statements) sqlite.exec(sql);
  sqlite.run("INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('agent.tasks',?,1,'owner')", ['{ "title-summary": {"schedule":{"enabled":true}} }']);
  sqlite.run("INSERT INTO deployment_setting_resets VALUES('instructions.template',1,'owner')");
  const project = 'proj_11111111111111111111111111111111';
  sqlite.run('INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)', [project, 'stored settings']);
  sqlite.run('INSERT INTO project_settings(project_id,leaf,value,updated_at,updated_by) VALUES(?,?,?,1,?)', [project, CURATION_DAILY_LIMIT_LEAF, ' 7 ', 'owner']);
  sqlite.run("INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES(?,'canopy',0,1,'owner')", [project]);
  const before = sqlite.query('SELECT * FROM deployment_settings').all();
  const beforeProject = sqlite.query('SELECT * FROM project_settings').all();
  const beforeCapabilities = sqlite.query('SELECT * FROM project_capabilities').all();
  const beforeResets = sqlite.query('SELECT * FROM deployment_setting_resets').all();
  const migration = SCHEMA_STEPS.find(step => step.version === 710)!;
  for (const sql of migration.statements) sqlite.exec(sql);
  expect(sqlite.query('SELECT * FROM deployment_settings').all()).toEqual(before);
  expect(sqlite.query('SELECT * FROM project_settings').all()).toEqual(beforeProject);
  expect(sqlite.query('SELECT * FROM project_capabilities').all()).toEqual(beforeCapabilities);
  expect(sqlite.query('SELECT * FROM deployment_setting_resets').all()).toEqual(beforeResets);
  expect(sqlite.query('SELECT * FROM setting_revisions ORDER BY scope,leaf').all()).toEqual([
    { scope: '', leaf: 'agent.tasks', revision: 1 }, { scope: '', leaf: 'instructions.template', revision: 1 },
    { scope: `capability:${project}`, leaf: 'canopy', revision: 1 }, { scope: project, leaf: CURATION_DAILY_LIMIT_LEAF, revision: 1 },
  ]);
  sqlite.run("UPDATE deployment_settings SET updated_at=1 WHERE leaf='agent.tasks'");
  for (const sql of migration.statements) sqlite.exec(sql);
  expect(sqlite.query("SELECT revision FROM setting_revisions WHERE scope='' AND leaf='agent.tasks'").get()).toEqual({ revision: 2 });
  expect(sqlite.query('SELECT * FROM deployment_settings').all()).toEqual(before);
});

it('answers a stale API edit with 409, its current revision, and the current read', async () => {
  const e = sqliteEnv();
  const env = { ...e.env, ...OWNER_ENV };
  const path = '/api/settings/instructions.template';
  const stale = await asOwnerPut(e.db, path, { value: 'loser' });
  expect((await worker.fetch(await asOwnerPut(e.db, path, { value: 'winner' }), env)).status).toBe(200);
  const refused = await worker.fetch(stale, env);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ applied: false, reason: 'conflict', leaf: 'instructions.template', revision: 1 });
  const current = await worker.fetch(await asOwner(e.db, '/api/settings'), env);
  const answer = await current.json() as { leaves: { leaf: string; value: unknown; revision: string }[] };
  expect(answer.leaves.find(row => row.leaf === 'instructions.template')).toMatchObject({ value: 'winner', revision: '1' });
  e.sqlite.close();
});
