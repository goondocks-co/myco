/**
 * The ingest retirement upgrade over a store at the release before it: the session facts the dropped read model leaves
 * behind survive the step, and keep counting.
 */
import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { NEXT_S2F } from '@myco-server-worker/db/schema-vNEXT-s2f.js';
import { applySchemaSteps } from './helpers/migrate.js';

it('keeps every session\'s presence, end and receipt facts and the Project\'s session count', async () => {
  const sqlite = new Database(':memory:');
  const db = sqliteRelationalStore(sqlite);
  await applySchemaSteps(db, SCHEMA_STEPS.filter((step) => step.version < NEXT_S2F));
  sqlite.run("INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','p',1)");
  sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,ended_at)
    VALUES('proj_1','ended','m','t',1,5,9),('proj_1','open','m','t',2,7,NULL)`);
  sqlite.run("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('proj_1','ended',10,'member')");
  const facts = () => sqlite.query('SELECT project_id,session_id,has_session,tombstoned,ended_at,last_received_at FROM session_read_facts ORDER BY session_id').all();
  const counts = () => sqlite.query('SELECT project_id,session_count FROM project_session_counts').all();
  const before = { facts: facts(), counts: counts() };
  expect(before.facts).toHaveLength(2);

  await applySchemaSteps(db);

  expect({ facts: facts(), counts: counts() }).toEqual(before);
  sqlite.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('proj_1','later','m','t',3,8)");
  expect(counts()).toEqual([{ project_id: 'proj_1', session_count: 2 }]);
  sqlite.close();
}, 120_000);
