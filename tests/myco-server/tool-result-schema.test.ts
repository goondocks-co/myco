import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { sqliteD1 } from './helpers/d1.js';

it('upgrades populated v93 tool calls to nullable result reasons on native and D1 without guessing legacy reasons', async () => {
  const native = new Database(':memory:');
  const fresh = new Database(':memory:');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    expect(SERVER_SCHEMA_VERSION).toBeGreaterThanOrEqual(94);
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) {
      for (const sql of step.statements) fresh.exec(sql);
      if (step.version > 93) continue;
      for (const sql of step.statements) native.exec(sql);
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    }
    const seed = [
      "INSERT INTO projects(project_id,name,created_at) VALUES ('proj_upgrade','Upgrade',1)",
      "INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES ('proj_upgrade','s','machine','t',1,1)",
      "INSERT INTO tool_calls(project_id,session_id,tool_call_id,event_id,tool_name,success,error_message,created_at,token_id,received_at) VALUES ('proj_upgrade','s','t','e','Bash',0,'no result captured at idle',1,'tok',1)",
    ];
    for (const sql of seed) native.exec(sql);
    await d1.batch(seed.map(sql => d1.prepare(sql)));
    const migration = SCHEMA_STEPS.find(step => step.version === 94)!;
    for (const sql of migration.statements) native.exec(sql);
    await d1.batch(migration.statements.map(sql => d1.prepare(sql)));
    for (const db of [sqliteD1(native), d1]) {
      expect((await db.prepare('PRAGMA table_info(tool_calls)').all()).results).toEqual(fresh.query<Record<string, unknown>, []>('PRAGMA table_info(tool_calls)').all());
      expect((await db.prepare('SELECT success,result_reason FROM tool_calls').all()).results).toEqual([{ success: 0, result_reason: null }]);
      await db.prepare("UPDATE tool_calls SET result_reason='reported'").run();
      expect(await db.prepare('SELECT result_reason FROM tool_calls').first()).toEqual({ result_reason: 'reported' });
      expect(await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first()).toEqual({ value: '94' });
      expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
    }
  } finally { native.close(); fresh.close(); await mf.dispose(); }
}, 60_000);
