import { readSwitch } from '@myco-server-worker/core/embedding/switch-store.js';
import { afterEach, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { calibrationPending } from '@myco-server-worker/core/embedding/hubness.js';
import { listProjects } from '@myco-server-worker/read/sessions.js';
import { settingsWriter, settingsRevisions, observedSettingsGuard, writeSwitchedEmbedding, CURATION_DAILY_LIMIT_LEAF } from '@myco-server-worker/core/settings.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import type { PreparedStatement, RelationalStore } from '@myco-server-worker/core/adapters.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { migrateAndSeed } from './helpers/d1.js';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPatch, asOwnerPost, asOwnerPut, OWNER_ENV } from './helpers/owner.js';

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

it('refuses stale client revisions on both task patch routes and rereads the current values', async () => {
  for (const route of ['tier', 'switch'] as const) {
    const e = sqliteEnv();
    try {
      const env = { ...e.env, ...OWNER_ENV };
      const stale = route === 'tier'
        ? await asOwnerPatch(e.db, '/api/settings/agent.tasks', { task: 'title-summary', tier: 'high' })
        : await asOwnerPut(e.db, '/api/titling-backfill', { enabled: true });
      stale.headers.set('if-match', '0');
      const current = { 'title-summary': { reasoningLevel: 'low', schedule: { enabled: false } } };
      expect(await settingsWriter(e.db).setLeaf('agent.tasks', current, 'other', 1)).toEqual({ applied: true });
      const refused = await worker.fetch(stale, env);
      expect(refused.status).toBe(409);
      expect(await refused.json()).toEqual({ applied: false, reason: 'conflict', leaf: 'agent.tasks', revision: 1 });
      const read = await worker.fetch(await asOwner(e.db, '/api/settings'), env);
      const answer = await read.json() as { leaves: { leaf: string; value: unknown; revision: string }[] };
      expect(answer.leaves.find(row => row.leaf === 'agent.tasks')).toMatchObject({ value: current, revision: '1' });
      expect((await settingsWriter(e.db).leaves())['agent.tasks']?.value).toEqual(current);
    } finally { e.sqlite.close(); }
  }
});

it('admits every settings route without If-Match while preserving other leaves and task fields', async () => {
  const e = sqliteEnv();
  try {
    const env = { ...e.env, ...OWNER_ENV };
    const send = async (method: string, path: string, body?: unknown) => {
      const request = await asOwnerPost(e.db, path, body);
      expect(request.headers.has('if-match')).toBe(false);
      return worker.fetch(new Request(request, { method }), env);
    };
    const tasks = { 'title-summary': { reasoningLevel: 'low' }, 'canopy-map': { schedule: { intervalSeconds: 600 } } };
    expect((await send('PUT', '/api/settings/agent.tasks', { value: tasks })).status).toBe(200);
    for (const value of ['first', 'last']) expect((await send('PUT', '/api/settings/instructions.template', { value })).status).toBe(200);
    expect((await settingsWriter(e.db).leaves())['instructions.template']?.value).toBe('last');
    expect((await settingsWriter(e.db).leaves())['agent.tasks']?.value).toEqual(tasks);
    const patches = await Promise.all([
      send('PATCH', '/api/settings/agent.tasks', { task: 'title-summary', tier: 'high' }),
      send('PUT', '/api/titling-backfill', { enabled: true }),
    ]);
    expect(patches.map(response => response.status)).toEqual([200, 200]);
    expect((await settingsWriter(e.db).leaves())['agent.tasks']?.value).toEqual({
      ...tasks, 'title-summary': { reasoningLevel: 'high', schedule: { enabled: true } },
    });
    for (const [method, path, body] of [
      ['PUT', '/api/settings/agent.spore_curation.daily_runs', { project_id: 'proj_1', value: 7 }],
      ['PUT', '/api/projects/proj_1/capabilities/canopy', { enabled: false }],
      ['PUT', '/api/embedding', { provider: 'workers-ai' }],
      ['POST', '/api/settings/agent.tasks/repair', {}],
      ['DELETE', '/api/settings/instructions.template', undefined],
    ] as const) expect({ path, response: (await send(method, path, body)).status }).toEqual({ path, response: 200 });
    expect((await settingsWriter(e.db).leaves())['instructions.template']).toBeUndefined();
    expect((await settingsWriter(e.db).leaves())['agent.tasks']?.value).toMatchObject({
      'title-summary': { reasoningLevel: 'high', schedule: { enabled: true } },
    });
  } finally { e.sqlite.close(); }
});

it('refuses malformed supplied If-Match on scalar and embedding settings without writing', async () => {
  const e = sqliteEnv();
  try {
    const env = { ...e.env, ...OWNER_ENV };
    for (const [path, body, revision] of [
      ['/api/settings/instructions.template', { value: 'refused' }, '-1'],
      ['/api/embedding', { provider: 'workers-ai' }, '{}'],
    ] as const) {
      const request = await asOwnerPut(e.db, path, body);
      request.headers.set('if-match', revision);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ applied: false, reason: 'malformed', detail: expect.stringContaining('Invalid If-Match') });
    }
    expect(await settingsWriter(e.db).leaves()).toEqual({});
  } finally { e.sqlite.close(); }
});

it('keeps a supplied embedding revision map as a precondition', async () => {
  const e = sqliteEnv();
  try {
    const request = await asOwnerPut(e.db, '/api/embedding', { provider: 'workers-ai' });
    request.headers.set('if-match', JSON.stringify({ 'embedding.provider': 0, 'embedding.model': 0, 'embedding.base_url': 0 }));
    await settingsWriter(e.db, { target: 'cloudflare' }).setEmbedding({ provider: 'workers-ai' }, 'other', 1);
    const response = await worker.fetch(request, { ...e.env, ...OWNER_ENV });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ applied: false, reason: 'conflict', leaf: 'embedding.provider', revision: 1 });
    expect((await settingsWriter(e.db).leaves())['embedding.provider']?.updatedBy).toBe('other');
  } finally { e.sqlite.close(); }
});

it('resets only configured embedding parts during selection writes and switch completion', async () => {
  for (const completing of [false, true]) {
    const r = rig();
    const writer = settingsWriter(r.db, { target: 'cloudflare' });
    const write = async (now: number) => {
      if (!completing) return (await writer.setEmbedding({ provider: 'workers-ai' }, 'owner', now)).applied;
      r.sqlite.run(`INSERT INTO embedding_switches(slot,id,provider,model,endpoint,model_key,from_model_key,estimated_tokens,estimated_sources,progressed_at,state,started_at,started_by,updated_at)
        VALUES('deployment','switch','workers-ai','@cf/baai/bge-m3',NULL,'new','old',0,0,1,'building',1,'owner',1)`);
      const sw = await readSwitch(r.db);
      // Completion takes its calibration authority from a check of every Project, as the switch's completion runs it.
      for (const { projectId } of await listProjects(r.db)) expect(await calibrationPending(r.db, projectId, sw!.modelKey, now)).toBe(false);
      return writeSwitchedEmbedding(r.db, { 'embedding.provider': 'workers-ai', 'embedding.model': sw!.model }, 'owner', now, sw!);
    };
    expect(await write(1)).toBe(true);
    expect(r.sqlite.query('SELECT * FROM deployment_setting_resets').all()).toEqual([]);
    expect(Object.keys(await settingsRevisions(r.db)).sort()).toEqual(completing ? ['embedding.model', 'embedding.provider'] : ['embedding.provider']);
    r.sqlite.run(`INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES('embedding.base_url','"https://example.test"',1,'owner')`);
    expect(await write(2)).toBe(true);
    const receipt = r.sqlite.query("SELECT * FROM deployment_setting_resets WHERE leaf='embedding.base_url'").get();
    expect(receipt).toEqual({ leaf: 'embedding.base_url', reset_at: 2, reset_by: 'owner' });
    const revision = (await settingsRevisions(r.db))['embedding.base_url'];
    expect(await write(3)).toBe(true);
    expect((await settingsRevisions(r.db))['embedding.base_url']).toBe(revision);
    expect(r.sqlite.query("SELECT * FROM deployment_setting_resets WHERE leaf='embedding.base_url'").get()).toEqual(receipt);
  }
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
  stale.headers.set('if-match', '0');
  expect((await worker.fetch(await asOwnerPut(e.db, path, { value: 'winner' }), env)).status).toBe(200);
  const refused = await worker.fetch(stale, env);
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ applied: false, reason: 'conflict', leaf: 'instructions.template', revision: 1 });
  const current = await worker.fetch(await asOwner(e.db, '/api/settings'), env);
  const answer = await current.json() as { leaves: { leaf: string; value: unknown; revision: string }[] };
  expect(answer.leaves.find(row => row.leaf === 'instructions.template')).toMatchObject({ value: 'winner', revision: '1' });
  e.sqlite.close();
});
