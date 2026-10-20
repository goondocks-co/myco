import fs from 'node:fs';
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { BACKUP_FORMAT, deploymentId, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { relationalSnapshot } from '@myco-server-worker/core/relational-snapshot.js';
import { recordModelCatalog } from '@myco-server-worker/core/model-catalogs.js';
import { runnerUpdateReportStatements } from '@myco-server-worker/core/runner-updates.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteD1 } from './helpers/d1.js';
import { sqliteEnv } from './helpers/fixtures.js';

const SEED = [
  "INSERT INTO projects(project_id,name,created_at) VALUES ('proj_upgrade','Upgrade',1)",
  "INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES ('proj_upgrade','s','machine','t',1,1)",
  "INSERT INTO runners(id,name,created_at) VALUES ('rn_upgrade','Upgrade',1)",
  "INSERT INTO knowledge_git_provenance(project_id,identity_key,session_id,capture_point,captured_at,head_sha,status_hash,created_at) VALUES ('proj_upgrade','session:s:session_start','s','session_start',1,'" + 'a'.repeat(40) + "','hash',1)",
  "INSERT INTO deployment_settings(leaf,value,updated_at,updated_by) VALUES ('embedding.provider','\"ollama\"',1,'member')",
  "INSERT INTO worker_model_catalogs(machine_id,harness,catalog,resolutions,fetched_at,received_at) VALUES ('machine','claude-code','{}','{}',1,1)",
  "INSERT INTO runner_model_catalogs(runner_id,harness,catalog,resolutions,fetched_at,received_at) VALUES ('rn_upgrade','claude-code','{}','{}',1,1)",
  "INSERT INTO runner_update_reports(runner_id,channel,current_version,latest_version,last_check_at,last_result) VALUES ('rn_upgrade','alpha','2.0.0',NULL,1,NULL)",
];
const NEW_COLUMNS = [
  ['knowledge_git_provenance', 'event_id'], ['deployment_settings', 'write_id'],
  ['worker_model_catalogs', 'observed_order'], ['runner_model_catalogs', 'observed_order'], ['runner_update_reports', 'observed_order'],
] as const;

it('fresh and populated v91 upgrades agree on native and workerd D1, including first stamped reports', async () => {
  const native = new Database(':memory:');
  const fresh = new Database(':memory:');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    expect(SERVER_SCHEMA_VERSION).toBe(92);
    expect(SCHEMA_STEPS.at(-1)!.version).toBe(92);
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) {
      for (const sql of step.statements) fresh.exec(sql);
      if (step.version >= 92) continue;
      for (const sql of step.statements) native.exec(sql);
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    }
    for (const sql of SEED) native.exec(sql);
    await d1.batch(SEED.map(sql => d1.prepare(sql)));
    for (const sql of SCHEMA_STEPS.at(-1)!.statements) native.exec(sql);
    await d1.batch(SCHEMA_STEPS.at(-1)!.statements.map(sql => d1.prepare(sql)));
    for (const db of [sqliteD1(native), d1] satisfies RelationalStore[]) {
      for (const [table, column] of NEW_COLUMNS) {
        expect((await db.prepare(`SELECT ${column} AS value FROM ${table}`).all()).results, table).toEqual([{ value: null }]);
        const columns = (await db.prepare(`PRAGMA table_info(${table})`).all()).results;
        expect(columns).toEqual(fresh.query<Record<string, unknown>, []>(`PRAGMA table_info(${table})`).all());
      }
      for (const owner of [{ kind: 'machine', machineId: 'machine' }, { kind: 'runner', runnerId: 'rn_upgrade' }] as const) {
        expect((await recordModelCatalog(db, { owner, now: 2, catalog: { observedOrder: 1, harness: 'claude-code', source: { kind: 'command', command: 'list' }, signIn: 'worker-login', fetchedAt: 1, models: [] } })).recorded).toBe(true);
      }
      await db.batch(await runnerUpdateReportStatements(db, 'rn_upgrade', { observedOrder: 1, channel: 'alpha', currentVersion: '2.0.1', latestVersion: null, lastCheckAt: 1 }));
      expect(await db.prepare('SELECT observed_order FROM runner_update_reports').first<{ observed_order: number }>()).toEqual({ observed_order: 1 });
      expect((await db.prepare('SELECT value FROM schema_meta WHERE key = ?').bind('version').first<{ value: string }>())).toEqual({ value: '92' });
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
    for (const file of renderMigrationFiles()) expect(fs.readFileSync(`${import.meta.dir}/../../packages/myco-server/migrations/${file.name}`, 'utf8')).toBe(file.sql);
  } finally { native.close(); fresh.close(); await mf.dispose(); }
}, 60_000);

it('v90 backup restore preserves provenance identity with NULL event rank and round trips', async () => {
  const old = new Database(':memory:');
  const target = sqliteEnv();
  const roundTrip = sqliteEnv();
  try {
    for (const step of SCHEMA_STEPS.filter(s => s.version <= 90)) for (const sql of step.statements) old.exec(sql);
    for (const sql of SEED) old.exec(sql);
    const tables = ['projects', 'sessions', 'knowledge_git_provenance'];
    const savedRows = tables.flatMap(t => old.query(`SELECT * FROM ${t}`).all().map(r => ({ t, r })));
    const header = { format: BACKUP_FORMAT, deploymentId: await deploymentId(target.db), schemaVersion: 90, createdAt: 1, producer: 'v90', counts: Object.fromEntries(tables.map(t => [t, 1])) };
    const text = [header, ...savedRows].map(r => JSON.stringify(r)).join('\n') + '\n';
    for (const repeat of [0, 1]) {
      const result = await restoreArtifact(target.db, { authorization: { kind: 'recovery' }, text });
      expect(result.tables.knowledge_git_provenance).toMatchObject({ rows: 1, inserted: repeat === 0 ? 1 : 0 });
      expect(target.sqlite.query("SELECT identity_key,session_id,head_sha,event_id FROM knowledge_git_provenance WHERE project_id = 'proj_upgrade'").all())
        .toEqual([{ identity_key: 'session:s:session_start', session_id: 's', head_sha: 'a'.repeat(40), event_id: null }]);
    }
    const snapshot = await relationalSnapshot(target.db, tables, 1024 * 1024);
    const roundTripRows = [...snapshot].flatMap(([t, rows]) => rows.map(r => ({ t, r })));
    const roundTripHeader = { ...header, schemaVersion: 92, counts: Object.fromEntries([...snapshot].map(([table, rows]) => [table, rows.length])) };
    const roundTripText = [roundTripHeader, ...roundTripRows].map(row => JSON.stringify(row)).join('\n') + '\n';
    await restoreArtifact(roundTrip.db, { authorization: { kind: 'recovery' }, text: roundTripText, allowForeignLineage: true });
    expect(roundTrip.sqlite.query('SELECT * FROM knowledge_git_provenance').all()).toEqual(target.sqlite.query('SELECT * FROM knowledge_git_provenance').all());
  } finally { old.close(); target.sqlite.close(); roundTrip.sqlite.close(); }
});
