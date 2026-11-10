import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { V712 } from '@myco-server-worker/db/schema-v712.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { applySchemaSteps } from './helpers/migrate.ts';

async function upgraded(populate: (sqlite: Database) => void): Promise<unknown[]> {
  const sqlite = new Database(':memory:');
  const db = sqliteRelationalStore(sqlite);
  await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version < V712));
  populate(sqlite);
  await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version === V712));
  return sqlite.query("SELECT phase,done FROM projection_catchup WHERE projection='passed_over'").all();
}

it('a Deployment holding embedding failures for its processed plans starts the passed-over catch-up at its failures phase, undone', async () => {
  expect(await upgraded((sqlite) => {
    sqlite.run(`INSERT INTO projects(project_id,name,created_at) VALUES ('proj_a','a',1)`);
    sqlite.run(`INSERT INTO processed_resources(project_id,kind,resource_id,blob_key,source_token_id,event_id) VALUES ('proj_a','plan','plan_1','${'b'.repeat(64)}','mt_1','ev_1')`);
    sqlite.run(`INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at) VALUES ('proj_a','plan','plan_1','workers-ai:bge','r1','too_long',2)`);
  })).toEqual([{ phase: 'failures', done: 0 }]);
});

it('a Deployment with no embedding failures starts the passed-over catch-up done', async () => {
  expect(await upgraded(() => {})).toEqual([{ phase: 'failures', done: 1 }]);
});
