import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { VIEW_SESSION_TABLES } from '@myco-server-worker/db/view-tables.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { captureViewSession, withViewStores } from './helpers/view-stores.js';
import { seedViewInstance, updateViewSearchText } from './helpers/view-instances.js';
import { VIEW_ACCESS_PATH_DECISIONS } from './helpers/view-access-paths.js';
import { DEPLOYMENT_ACCESS_PATH_INDEXES } from './helpers/access-paths.js';

const TABLES = ['session_views', 'view_instances', 'view_visible', 'view_checkpoints', 'view_checkpoint_chunks',
  'view_key_owners', 'view_prompts', 'view_responses', 'view_tool_calls', 'view_plans', 'view_content_proofs',
  'view_findings', 'fact_classes', 'plan_promotions'];

it('step 100 adds only empty indexed instance storage and preserves captured facts on native and D1', async () => {
  await withViewStores(async (db, target) => {
    await captureViewSession(db);
    const facts = ['prompt_batches', 'responses', 'tool_calls', 'plans'];
    const factsNow = () => Promise.all(facts.map(table => db.prepare(`SELECT * FROM ${table}`).all().then(result => result.results)));
    const before = await factsNow();
    const step = SCHEMA_STEPS.find(step => step.version === 100)!;
    expect(SERVER_SCHEMA_VERSION).toBeGreaterThanOrEqual(100);
    expect(VIEW_SESSION_TABLES.map(String).sort()).toEqual(TABLES.slice().sort());
    for (const sql of step.statements) {
      if (/schema_meta/.test(sql)) continue;
      expect(sql).toMatch(/^CREATE (?:TABLE|VIRTUAL TABLE|INDEX|TRIGGER) IF NOT EXISTS /);
      expect(sql).not.toMatch(/\b(?:ALTER|DROP)\b/);
    }
    for (let replay = 0; replay < 2; replay++) await db.batch(step.statements.map(sql => db.prepare(sql)));
    expect(await factsNow()).toEqual(before);
    for (const table of TABLES) expect({ target, table, row: await db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first() })
      .toEqual({ target, table, row: { n: 0 } });
    for (const [view, fact, id] of [['view_prompts', 'prompt_batches', 'prompt_id'], ['view_responses', 'responses', 'response_id'],
      ['view_tool_calls', 'tool_calls', 'tool_call_id'], ['view_plans', 'plans', 'plan_key']]) {
      const columns = (await db.prepare(`PRAGMA table_info(${view})`).all<{ name: string; pk: number }>()).results;
      const factColumns = (await db.prepare(`PRAGMA table_info(${fact})`).all<{ name: string }>()).results;
      const retired = fact === 'prompt_batches' ? ['processed'] : [];
      expect(factColumns.filter(column => !retired.includes(column.name) && !columns.some(found => found.name === column.name))).toEqual([]);
      for (const name of retired) expect(columns.map(column => column.name)).not.toContain(name);
      expect(columns.filter(column => column.pk > 0).sort((a, b) => a.pk - b.pk).map(column => column.name)).toEqual(['project_id', 'instance_id', id!]);
      const index = async (suffix: string) => (await db.prepare(`PRAGMA index_info(idx_${view}_${suffix})`).all<{ name: string }>()).results.map(column => column.name);
      expect(await index('created')).toEqual(['project_id', 'instance_id', 'created_at', id!]);
      expect(await index('prompt')).toEqual(['project_id', 'instance_id', 'prompt_id', 'created_at']);
      expect(await index('record')).toEqual(['project_id', id!]);
    }
    const triggers = (await db.prepare("SELECT name,tbl_name,sql FROM sqlite_schema WHERE type='trigger' AND tbl_name LIKE 'view_%'")
      .all<{ name: string; tbl_name: string; sql: string }>()).results;
    expect(triggers.map(row => row.name).sort()).toEqual(['view_prompts', 'view_responses', 'view_plans'].flatMap(table => ['ai', 'au', 'ad'].map(op => `${table}_fts_${op}`)).sort());
    for (const trigger of triggers) {
      expect(trigger.sql).not.toMatch(/\b(session_read_facts|embedding_versions|search_blob_queue)\b/);
      expect(trigger.sql).toContain(`INTO ${trigger.tbl_name}_fts`);
    }
    const views = (await db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='view'").all<{ name: string; sql: string }>()).results;
    expect(views.filter(view => /\b(?:view_\w+|session_views|fact_classes)\b/.test(view.sql))).toEqual([]);
    expect(await db.prepare('PRAGMA foreign_key_check').first()).toBeNull();
  }, 99);
}, 60_000);

it('every legacy index has a declared view twin or semantic exclusion on native and D1', async () => {
  await withViewStores(async db => {
    const legacy = (await db.prepare("SELECT name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL AND tbl_name IN ('prompt_batches','responses','tool_calls','plans')")
      .all<{ name: string }>()).results.map(row => row.name).sort();
    expect(Object.keys(VIEW_ACCESS_PATH_DECISIONS).sort()).toEqual(legacy);
    for (const name of legacy) {
      const decision = VIEW_ACCESS_PATH_DECISIONS[name]!;
      if ('absent' in decision) { expect(decision.absent.length).toBeGreaterThan(0); continue; }
      const columns = async (index: string, scope: string) => {
        const rows = (await db.prepare(`PRAGMA index_xinfo(${index})`).all<{ seqno: number; name: string | null; key: number }>()).results;
        expect(rows.length).toBeGreaterThan(0);
        const keys = rows.filter(row => row.key === 1).sort((a, b) => a.seqno - b.seqno);
        for (const key of keys) expect(key.name).not.toBeNull();
        return keys.map(row => row.name).filter(column => column !== scope);
      };
      const expected = await columns(name, 'session_id');
      expect((await columns(decision.twin, 'instance_id')).slice(0, expected.length)).toEqual(expected);
      const sql = async (index: string) => (await db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND name=?")
        .bind(index).first<{ sql: string }>())!.sql.replace(/\s+/g, ' ').trim();
      const predicate = /\bWHERE\s+(.+)$/i.exec(await sql(name))?.[1];
      if (predicate !== undefined) expect(await sql(decision.twin)).toContain(`WHERE ${predicate}`);
      if (DEPLOYMENT_ACCESS_PATH_INDEXES.has(name)) expect(DEPLOYMENT_ACCESS_PATH_INDEXES.has(decision.twin)).toBe(true);
    }
    for (const [name, columns] of [
      ['idx_view_plans_project_updated', ['project_id', 'updated_at', 'plan_key']],
      ['idx_view_prompts_window', ['project_id', 'created_at']],
      ['idx_view_tool_calls_window', ['project_id', 'created_at']],
    ] as const) expect((await db.prepare(`PRAGMA index_info(${name})`).all<{ name: string }>()).results.map(row => row.name)).toEqual(Array.from(columns));
  });
}, 60_000);

it('FTS updates replace the old text and title terms on native and D1', async () => {
  await withViewStores(async db => {
    await captureViewSession(db);
    await seedViewInstance(db, { projectId: 'project', sessionId: 'session', instanceId: 'updated', state: 'building' });
    const matches = (fts: string, term: string) => db.prepare(`SELECT COUNT(*) AS n FROM ${fts} WHERE ${fts} MATCH ?`).bind(term).first();
    for (const fts of ['view_prompts_fts', 'view_responses_fts', 'view_plans_fts']) expect(await matches(fts, 'viewcanary')).toEqual({ n: 1 });
    await updateViewSearchText(db, 'project', 'updated', 'viewupdatedcanary');
    for (const fts of ['view_prompts_fts', 'view_responses_fts', 'view_plans_fts']) {
      expect(await matches(fts, 'viewcanary')).toEqual({ n: 0 });
      expect(await matches(fts, 'viewupdatedcanary')).toEqual({ n: 1 });
    }
  });
}, 60_000);

it('instance-qualified keys isolate Projects and FTS writes leave publication counters untouched on native and D1', async () => {
  await withViewStores(async db => {
    await captureViewSession(db);
    await captureViewSession(db, 'other');
    const counters = async () => Promise.all(['session_read_facts', 'embedding_versions', 'search_blob_queue'].map(table => db.prepare(`SELECT * FROM ${table}`).all().then(result => result.results)));
    const before = await counters();
    await seedViewInstance(db, { projectId: 'project', sessionId: 'session', instanceId: 'shared-id', state: 'building' });
    await seedViewInstance(db, { projectId: 'other', sessionId: 'session', instanceId: 'shared-id', state: 'frozen' });
    expect(await counters()).toEqual(before);
    for (const fts of ['view_prompts_fts', 'view_responses_fts', 'view_plans_fts']) {
      expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${fts} WHERE ${fts} MATCH 'viewcanary'`).first()).toEqual({ n: 2 });
    }
    await expect(seedViewInstance(db, { projectId: 'other', sessionId: 'session', instanceId: 'wrong-parent', state: 'building', parent: 'absent' })).rejects.toThrow();
    expect(await db.prepare("SELECT COUNT(*) AS n FROM view_instances WHERE instance_id='wrong-parent'").first()).toEqual({ n: 0 });
    expect(await db.prepare('PRAGMA foreign_key_check').first()).toBeNull();
  });
}, 60_000);
