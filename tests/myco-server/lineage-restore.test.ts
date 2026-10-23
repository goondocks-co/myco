/**
 * A backup taken before sessions carried a launch parent, restored into a Deployment that indexes both parent columns:
 * restore writes deleted sessions' state, so it clears their own parents in the same batch, and the parent indexes keep
 * holding live sessions alone.
 */
import { Database } from 'bun:sqlite';
import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { BACKUP_FORMAT, BACKUP_TABLES, restoreArtifact } from '@myco-server-worker/core/backup.js';
import { LINEAGE_MAX_NODES, sessionLineage } from '@myco-server-worker/read/lineage.js';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { sqliteD1 } from './helpers/d1.js';
import { measuredStore } from './helpers/read-budget.js';

const LIVE_CHILDREN = 201;
/** The last schema before step 96 added the launch parent. */
const BEFORE_LAUNCH_PARENT = 95;

/** A schema-95 Deployment's backup: a root with `size` continuation children, all but the last `LIVE_CHILDREN` deleted, and one more live child the destination already holds a tombstone for. */
async function oldBackup(project: string, size: number): Promise<{ text: string; deploymentId: string }> {
  const old = new Database(':memory:');
  try {
    for (const step of SCHEMA_STEPS.filter(s => s.version <= BEFORE_LAUNCH_PARENT)) for (const sql of step.statements) old.exec(sql);
    old.run("INSERT INTO projects(project_id,name,created_at) VALUES(?,'Old',1)", [project]);
    old.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent) VALUES(?,'root','m','t',1,1,'codex')", [project]);
    old.run(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})
      INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,parent_session_id,parent_reason)
      SELECT ?,printf('child-%05d',i),'m','t',1,1,'codex','root','fork' FROM n`, [project]);
    old.run("INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,parent_session_id,parent_reason) VALUES(?,'held-deleted','m','t',1,1,'codex','root','fork')", [project]);
    old.run("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) SELECT project_id,session_id,1,'owner' FROM sessions WHERE project_id=? AND session_id >= 'child-' AND session_id <= ?",
      [project, `child-${String(size - LIVE_CHILDREN).padStart(5, '0')}`]);
    const tables = new Set((old.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(row => row.name));
    const snapshot = BACKUP_TABLES.filter(table => tables.has(table)).map(table => ({ table, rows: old.query(`SELECT * FROM ${table}`).all() }));
    const meta = new Map((old.query('SELECT key,value FROM schema_meta').all() as { key: string; value: string }[]).map(row => [row.key, row.value]));
    const header = { format: BACKUP_FORMAT, deploymentId: meta.get('deployment_id')!, schemaVersion: Number(meta.get('version')),
      producer: 'lineage-restore', createdAt: 1_000, counts: Object.fromEntries(snapshot.map(({ table, rows }) => [table, rows.length])) };
    const text = [header, ...snapshot.flatMap(({ table, rows }) => rows.map(row => ({ t: table, r: row })))].map(row => JSON.stringify(row)).join('\n') + '\n';
    expect(header.schemaVersion).toBe(BEFORE_LAUNCH_PARENT);
    return { text, deploymentId: header.deploymentId };
  } finally { old.close(); }
}

/** Restores the artifact into `target` after the destination records its own tombstone for `held-deleted`. */
async function restore(target: RelationalStore, project: string, backup: { text: string; deploymentId: string }): Promise<void> {
  await target.prepare("UPDATE schema_meta SET value = ? WHERE key = 'deployment_id'").bind(backup.deploymentId).run();
  await target.prepare("INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES(?,'held-deleted',1,'owner')").bind(project).run();
  await restoreArtifact(target, { text: backup.text, authorization: { kind: 'recovery' } });
}

const deletedWithParents = (target: RelationalStore, project: string) => target.prepare(`SELECT COUNT(*) AS n FROM sessions s JOIN session_tombstones t USING (project_id, session_id)
  WHERE s.project_id = ? AND (s.parent_session_id IS NOT NULL OR s.parent_reason IS NOT NULL OR s.launch_parent_session_id IS NOT NULL)`).bind(project).first<{ n: number }>();
const liveWithParents = (target: RelationalStore, project: string) => target.prepare(`SELECT COUNT(*) AS n FROM sessions s
  WHERE s.project_id = ? AND s.parent_session_id = 'root' AND NOT EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = s.project_id AND t.session_id = s.session_id)`).bind(project).first<{ n: number }>();

it('restores a schema-95 backup into D1 with deleted sessions out of the parent indexes, and reads a family the same whatever was deleted', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const d1 = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    const target = d1 as unknown as RelationalStore;
    const costs: number[] = [];
    for (const size of [1_000, 4_000]) {
      const project = `proj_restore_${size}`;
      await restore(target, project, await oldBackup(project, size));
      expect([await deletedWithParents(target, project), await liveWithParents(target, project)]).toEqual([{ n: 0 }, { n: LIVE_CHILDREN }]);
      const measured = measuredStore(d1);
      const lineage = (await sessionLineage(measured.db, { projectId: project }, 'root'))!;
      expect([lineage.nodes.length, lineage.truncated]).toEqual([LINEAGE_MAX_NODES, true]);
      costs.push(measured.reads());
    }
    expect(costs[1]).toBe(costs[0]);
  } finally { await mf.dispose(); }
}, 120_000);

it('restores a schema-95 backup into a native store with deleted sessions\' own parents cleared and live children\'s kept', async () => {
  const native = new Database(':memory:');
  try {
    for (const step of SCHEMA_STEPS) for (const sql of step.statements) native.exec(sql);
    const target = sqliteD1(native);
    const project = 'proj_restore_native';
    await restore(target, project, await oldBackup(project, 1_000));
    expect([await deletedWithParents(target, project), await liveWithParents(target, project)]).toEqual([{ n: 0 }, { n: LIVE_CHILDREN }]);
    expect(native.query("SELECT parent_session_id FROM sessions WHERE project_id = ? AND session_id = 'held-deleted'").get(project)).toEqual({ parent_session_id: null });
  } finally { native.close(); }
}, 60_000);
