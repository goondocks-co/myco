/** What one contact and one fleet read cost must not depend on how many contacts a machine has accumulated. */
import { afterAll, expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/constants.js';
import { readWorkerFleet, recordWorkerContact } from '@myco-server-worker/core/worker-contacts.js';
import { pruneTerminalRuns } from '@myco-server-worker/db/runs/retention.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const NOW = 1_800_000_000_000;
const OFFER = [{ id: 'codex', authenticated: true }];
const started: Miniflare[] = [];
afterAll(async () => { await Promise.all(started.map(mf => mf.dispose())); });

async function costsAt(contacts: number) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  started.push(mf);
  const d1 = await mf.getD1Database('DB');
  const measured = measuredStore(d1);
  await d1.prepare("INSERT INTO members(id,created_at,role) VALUES('owner',1,'admin')").run();
  const rows = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x<${contacts})`;
  await d1.prepare(`${rows} INSERT INTO member_credentials(id,member_id,machine_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) SELECT 'c'||x,'owner','big','h'||x,x,${NOW + 1_000_000},'root',1 FROM s`).run();
  await d1.prepare(`${rows} INSERT INTO worker_contacts(credential_id,machine_id,offers,capabilities,last_seen_at,updated_at) SELECT 'c'||x,'big','[]','[]',${NOW - 5_000_000}+x,${NOW - 5_000_000}+x FROM s`).run();
  const newest = `c${contacts}`;
  await recordWorkerContact(measured.db, { credentialId: newest, machineId: 'big', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW });
  const reads = async (operation: () => Promise<unknown>) => { measured.reset(); await operation(); return measured.reads(); };
  return {
    poll: await reads(() => recordWorkerContact(measured.db, { credentialId: newest, machineId: 'big', offers: OFFER, capabilities: [], reason: 'no_work', now: NOW + 1 })),
    report: await reads(() => recordWorkerContact(measured.db, { credentialId: newest, machineId: 'big', offers: [], capabilities: [], reason: 'no_work', now: NOW + 2 })),
    fleet: await reads(() => readWorkerFleet(measured.db, NOW + 3)),
  };
}

test('a contact and a fleet read cost the same at ten and at five hundred contacts per machine', async () => {
  expect(await costsAt(500)).toEqual(await costsAt(10));
}, 60_000);

async function retirementCost(runs: number, headTriggers: boolean) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  started.push(mf);
  const d1 = await mf.getD1Database('DB');
  const measured = measuredStore(d1);
  await d1.prepare("INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES('proj_1','one',1)").run();
  await d1.prepare("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','a','built-in',1,1)").run();
  await d1.prepare("INSERT INTO runners(id,name,created_at) VALUES('rn_a','a',1)").run();
  await d1.prepare(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root) VALUES('rc_a','rn_a','h',1,1,${NOW + 1_000_000},'rc_a')`).run();
  const rows = `WITH RECURSIVE s(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM s WHERE x<${runs})`;
  await d1.prepare(`INSERT OR IGNORE INTO members(id,created_at,role) VALUES('${HARNESS_MEMBER_ID}',1,'member')`).run();
  await d1.prepare(`${rows} INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at) SELECT 'at_'||x,'${HARNESS_MEMBER_ID}','hash_'||x,1,${NOW + 1_000_000},'at_'||x,1 FROM s`).run();
  await d1.prepare(`${rows} INSERT INTO agent_runs(id,project_id,agent_id,task,status,queued_at,started_at,leased_runner_id,leased_runner_credential_id,dispatched_by) SELECT 'run_'||x,'proj_1','myco-agent','title-summary','running',x,x,'rn_a','rc_a','at_'||x FROM s`).run();
  await d1.prepare(`${rows} INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,owner_kind,runner_id) SELECT 'proj_1','run_'||x,'at_'||x,'rc_a',x,'runner','rn_a' FROM s`).run();
  await d1.prepare(`UPDATE agent_runs SET status='completed',completed_at=CAST(substr(id,5) AS INTEGER)+1`).run();
  if (!headTriggers) for (const name of ['runner_head_run_delete', 'runner_head_attempt_delete']) await d1.prepare(`DROP TRIGGER ${name}`).run();
  measured.reset();
  expect(await pruneTerminalRuns(measured.db, NOW, runs, undefined, NOW)).toBe(runs);
  return { reads: measured.reads(), writes: measured.writes() };
}

test('retiring many runs costs one head seek per run and attempt, and a write only for the link that goes', async () => {
  const runs = 200;
  const [without, withHead] = [await retirementCost(runs, false), await retirementCost(runs, true)];
  console.info('RETIREMENT_COST', JSON.stringify({ runs, without, withHead }));
  expect(withHead.writes - without.writes).toBeLessThanOrEqual(3);
  expect(withHead.reads - without.reads).toBeLessThanOrEqual(2 * runs + 3);
}, 60_000);
