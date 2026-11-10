import { expect, it } from 'bun:test';
import { capturedSinceMap } from '@myco-server-worker/core/canopy.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { schemaSqlite } from './helpers/schema-template.js';
import { d1TwoScale, eachUnit, expectTwoScale } from './helpers/two-scale.js';

it('capture since the map costs D1 the same as the mapped Project\'s history and another Project\'s capture grow', async () => {
  expectTwoScale(await d1TwoScale({
    sizes: [500, 5_000],
    setup: async (db) => {
      await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('mapped','Mapped',1),('busy','Busy',1)").run();
      await db.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)").run();
      await db.prepare("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES('mapped','last-map','agent','canopy-map','completed',100)").run();
    },
    // The mapped Project's sessions all came before its map; another Project keeps capturing after it.
    grow: async (db, from, to) => {
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT 'mapped','session-'||i,'machine','capture',1,100 FROM n`);
      await eachUnit(db, from, to, `INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT 'busy','session-'||i,'machine','capture',1,200 FROM n`);
    },
    cases: [{ name: 'capture since the map', run: async (db) => expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(false) }],
  }));
}, 120_000);

it('counts a session received after the map, unless it is deleted', async () => {
  const sqlite = schemaSqlite();
  try {
    sqlite.exec("INSERT INTO projects(project_id,name,created_at) VALUES('mapped','Mapped',1)");
    sqlite.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)");
    sqlite.exec("INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at) VALUES('mapped','last-map','agent','canopy-map','completed',100)");
    sqlite.exec("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at) VALUES('mapped','session-0','machine','capture',1,100)");
    const db = sqliteRelationalStore(sqlite);
    expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(false);
    sqlite.exec("UPDATE sessions SET last_received_at=201 WHERE project_id='mapped' AND session_id='session-0'");
    expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(true);
    sqlite.exec("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('mapped','session-0',202,'member')");
    expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(false);
    sqlite.exec("DELETE FROM session_tombstones WHERE project_id='mapped' AND session_id='session-0'");
    expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(true);
  } finally { sqlite.close(); }
});
