import { describe, expect, it } from 'bun:test';
import { readWorkerFleet, recentWorkerReports, runnerContactStatement, WORKER_CONTACT_RETENTION_MS } from '@myco-server-worker/core/worker-contacts.js';
import { seededSqlite, sqliteD1 } from './helpers/d1.js';

const NOW = 1_800_000_000_000;
const OFFER = [{ id: 'claude-code', authenticated: true }];

function runner(sqlite: ReturnType<typeof seededSqlite>, id: string) {
  sqlite.query(`INSERT INTO runners(id,name,created_at,created_by_member,registration_id) VALUES (?,?,?,?,?)`)
    .run(id, id, NOW - 1, 'mem_machine_1', `request_${id}`);
  sqlite.query(`INSERT INTO runner_credentials(id,runner_id,token_hash,epoch,issued_at,expires_at,lineage_root)
    VALUES (?,?,?,1,?,?,?)`).run(`rc_${id}`, id, `hash_${id}`, NOW - 1, NOW + WORKER_CONTACT_RETENTION_MS * 2, `rc_${id}`);
}

describe('fleet corrections', () => {
  it('retains contact history across pruning and replacement until a new machine reports', async () => {
    const sqlite = seededSqlite();
    try {
      const db = sqliteD1(sqlite);
      runner(sqlite, 'rn_history');
      const old = NOW - WORKER_CONTACT_RETENTION_MS - 1;
      await runnerContactStatement(db, { runnerId: 'rn_history', offers: OFFER, now: old }).run();
      sqlite.query(`DELETE FROM runner_contacts WHERE runner_id = 'rn_history'`).run();
      expect((await readWorkerFleet(db, NOW))[0]?.runnerDetails).toMatchObject({ display: 'Offline', lastSeenAt: old, awaitingReplacement: false });
      sqlite.query(`UPDATE runners SET registration_id = 'replacement_request' WHERE id = 'rn_history'`).run();
      expect((await readWorkerFleet(db, NOW))[0]?.runnerDetails).toMatchObject({ display: 'Offline', lastSeenAt: old, awaitingReplacement: true });
      await runnerContactStatement(db, { runnerId: 'rn_history', offers: OFFER, now: NOW }).run();
      expect((await readWorkerFleet(db, NOW))[0]?.runnerDetails).toMatchObject({ display: 'Online', lastSeenAt: NOW, awaitingReplacement: false });
    } finally { sqlite.close(); }
  });

  it('uses a durable attempt when there is no retained contact', async () => {
    const sqlite = seededSqlite();
    try {
      runner(sqlite, 'rn_attempt');
      sqlite.query(`INSERT INTO agents(id,name,created_at) VALUES ('myco-agent','Myco agent',?)`).run(NOW - 300);
      sqlite.query(`INSERT INTO member_credentials(id,member_id,token_hash,issued_at,expires_at,lineage_root,lineage_started_at)
        VALUES ('mt_run_attempt','mem_machine_1','hash_run_attempt',?,?, 'mt_run_attempt',?)`).run(NOW - 300, NOW + 1000, NOW - 300);
      sqlite.query(`INSERT INTO agent_runs(id,project_id,agent_id,task,status,queued_at,started_at,completed_at,leased_runner_id,leased_runner_credential_id,dispatched_by)
        VALUES ('run_attempt','proj_1','myco-agent','title-summary','completed',?,?,?,?,?,?)`)
        .run(NOW - 300, NOW - 200, NOW - 100, 'rn_attempt', 'rc_rn_attempt', 'mt_run_attempt');
      sqlite.query(`INSERT INTO agent_run_attempts(project_id,run_id,attempt_id,leased_by,claimed_at,owner_kind,runner_id)
        VALUES ('proj_1','run_attempt','mt_run_attempt','rc_rn_attempt',?,'runner','rn_attempt')`).run(NOW - 200);
      expect((await readWorkerFleet(sqliteD1(sqlite), NOW))[0]?.runnerDetails).toMatchObject({ display: 'Offline', lastSeenAt: NOW - 200,
        lastAttempted: { runId: 'run_attempt' } });
    } finally { sqlite.close(); }
  });

  it('degrades malformed update metadata on one runner and keeps claims on the light read', async () => {
    const sqlite = seededSqlite();
    try {
      const sql: string[] = [];
      const db = sqliteD1(sqlite, { onSql: text => sql.push(text) });
      runner(sqlite, 'rn_bad');
      runner(sqlite, 'rn_good');
      for (const id of ['rn_bad', 'rn_good']) await runnerContactStatement(db, { runnerId: id, offers: OFFER, now: NOW }).run();
      sqlite.query(`INSERT INTO runner_update_reports(runner_id,channel,current_version,last_result) VALUES ('rn_bad','alpha','2.0','[1]')`).run();
      const fleet = await readWorkerFleet(db, NOW);
      expect(fleet.find(row => row.runner?.id === 'rn_bad')?.runnerDetails).toMatchObject({ updateState: null, updateMetadataUnavailable: true });
      expect(fleet.find(row => row.runner?.id === 'rn_good')?.runnerDetails).toMatchObject({ updateMetadataUnavailable: false });
      sqlite.query(`INSERT INTO runner_update_reports(runner_id,channel,current_version,latest_version)
        VALUES ('rn_good','alpha','2.0.0-alpha.3','2.0.0-alpha.2')`).run();
      expect((await readWorkerFleet(db, NOW)).find(row => row.runner?.id === 'rn_good')?.runnerDetails?.updateAvailable).toBe(false);
      sqlite.query(`UPDATE runner_update_reports SET latest_version = '2.0.0-alpha.4' WHERE runner_id = 'rn_good'`).run();
      expect((await readWorkerFleet(db, NOW)).find(row => row.runner?.id === 'rn_good')?.runnerDetails?.updateAvailable).toBe(true);
      sql.length = 0;
      expect((await recentWorkerReports(db, NOW)).map(row => row.credentialId).sort()).toEqual(['rn_bad', 'rn_good']);
      expect(sql.join('\n')).not.toContain('agent_run_attempts');
      expect(sql.join('\n')).not.toContain('idx_runner_run_terminal');
      sqlite.query(`UPDATE runner_update_reports SET last_result = ? WHERE runner_id = 'rn_bad'`)
        .run(JSON.stringify({ lastResult: { fromVersion: [], toVersion: '2.0', result: 'updated', at: NOW } }));
      expect((await readWorkerFleet(db, NOW)).find(row => row.runner?.id === 'rn_bad')?.runnerDetails).toMatchObject({ updateState: null, updateMetadataUnavailable: true });
      sqlite.query(`UPDATE runner_update_reports SET last_result = ? WHERE runner_id = 'rn_bad'`)
        .run(JSON.stringify({ updateState: { phase: 'probation', since: NOW } }));
      expect((await recentWorkerReports(db, NOW)).map(row => row.credentialId)).toEqual(['rn_good']);
    } finally { sqlite.close(); }
  });
});
