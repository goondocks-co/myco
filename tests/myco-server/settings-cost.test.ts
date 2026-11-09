/** A settings write and an idle-close change cost the same however many sessions the Deployment holds. */
import { afterAll, expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { settingsRevisions, settingsWriter } from '@myco-server-worker/core/settings.js';
import { readQuietPolicy } from '@myco-server-worker/db/learning/quiet-policy.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const NOW = 1_800_000_000_000;
const IDLE_CLOSE = 'agent.titling_idle_close_minutes';
const started: Miniflare[] = [];
afterAll(async () => { await Promise.all(started.map(mf => mf.dispose())); });

async function costsAt(sessions: number) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  started.push(mf);
  const d1 = await mf.getD1Database('DB');
  await d1.prepare("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','one',1)").run();
  const rows = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x<${sessions})`;
  await d1.prepare(`${rows} INSERT INTO sessions(project_id,session_id,created_by_token_id,first_received_at,last_received_at) SELECT 'proj_1','s'||x,'t',1,${NOW} FROM s`).run();
  await d1.prepare(`${rows} INSERT INTO learning_sessions(project_id,session_id,init_state,source_activity_at,pending_cards) SELECT 'proj_1','s'||x,'ready',${NOW},1 FROM s`).run();
  const measured = measuredStore(d1);
  const cost = async (operation: () => Promise<unknown>) => { measured.reset(); await operation(); return { read: measured.reads(), written: measured.writes() }; };
  const writer = settingsWriter(measured.db);
  return {
    read: await cost(async () => { await writer.leaves(); await settingsRevisions(measured.db); await readQuietPolicy(measured.db); }),
    write: await cost(() => writer.setLeaf('instructions.template', 'hello', 'owner', NOW)),
    idleClose: await cost(() => writer.setLeaf(IDLE_CLOSE, 30, 'owner', NOW)),
  };
}

test('a settings read, a leaf write and an idle-close change cost the same at 100 and 1,000 sessions', async () => {
  const [small, large] = [await costsAt(100), await costsAt(1_000)];
  expect(large).toEqual(small);
}, 120_000);
