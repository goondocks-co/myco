import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { capturedSinceMap } from '@myco-server-worker/core/canopy.js';
import { SCHEMA_DDL } from '@myco-server-worker/db/schema.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { statementRecorder } from '../helpers/statement-recorder.js';
import { sqliteBudgetMeter } from './helpers/budget-meter.js';

const SESSIONS = 5000;
const READ_CEILING = 4;

it('seeks capture since the map without planner statistics or reading another Project’s recent history', async () => {
  const sqlite = new Database(':memory:');
  const meter = sqliteBudgetMeter();
  try {
    for (const sql of SCHEMA_DDL) sqlite.exec(sql);
    sqlite.exec("INSERT INTO projects(project_id,name,created_at) VALUES('mapped','Mapped',1),('busy','Busy',1)");
    sqlite.exec("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('agent','Agent','built-in',1,1)");
    sqlite.exec(`INSERT INTO agent_runs(project_id,id,agent_id,task,status,started_at)
      VALUES('mapped','last-map','agent','canopy-map','completed',100)`);
    const ids = JSON.stringify(Array.from({ length: SESSIONS }, (_, n) => n));
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      SELECT 'mapped','session-'||value,'machine','capture',1,100 FROM json_each(?)`, [ids]);
    expect(sqlite.query("SELECT 1 FROM sqlite_schema WHERE name='sqlite_stat1'").get()).toBeNull();
    const db = sqliteRelationalStore(sqlite);
    const measurements: Array<{ scenario: string; rows: number; plans: string[] }> = [];
    const check = async (scenario: string, expected: boolean) => {
      const recorded = statementRecorder(db, { accounting: 'native' });
      expect(await capturedSinceMap(recorded.db, { projectId: 'mapped' })).toBe(expected);
      expect(recorded.statements).toHaveLength(1);
      const entry = recorded.statements[0]!;
      const rows = meter.reads(sqlite, { sql: entry.sql, params: [...entry.binds] });
      const plans = sqlite.query<{ detail: string }, never[]>(`EXPLAIN QUERY PLAN ${entry.sql}`).all(...entry.binds as never[]).map(row => row.detail);
      console.info('CANOPY_READ_CEILING', JSON.stringify({ scenario, rows, limit: READ_CEILING, plans }));
      measurements.push({ scenario, rows, plans });
    };
    await check('settled map', false);
    sqlite.run(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
      SELECT 'busy','session-'||value,'machine','capture',1,200 FROM json_each(?)`, [ids]);
    await check('another Project keeps capturing', false);
    sqlite.exec("UPDATE sessions SET last_received_at=201 WHERE project_id='mapped' AND session_id='session-0'");
    await check('new capture', true);
    for (const { scenario, rows, plans } of measurements) {
      expect(rows, scenario).toBeLessThanOrEqual(READ_CEILING);
      expect(plans).toContainEqual(expect.stringMatching(/SEARCH session_read_facts USING COVERING INDEX idx_session_read_activity \(project_id=\? AND last_received_at>\?\)/));
    }
    sqlite.exec("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES('mapped','session-0',202,'member')");
    expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(false);
    sqlite.exec("DELETE FROM session_tombstones WHERE project_id='mapped' AND session_id='session-0'");
    expect(await capturedSinceMap(db, { projectId: 'mapped' })).toBe(true);
  } finally { sqlite.close(); meter.close(); }
});
