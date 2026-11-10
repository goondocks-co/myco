import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { SERVER_SCHEMA_VERSION } from '@myco-server-worker/constants.js';
import { sqliteD1 } from './helpers/d1.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';
import {
  lineage_LINEAGE_MAX_NODES as LINEAGE_MAX_NODES,
  lineage_sessionLineage as sessionLineage,
} from '@myco-server-worker/read/catalog/lineage.js';
import { inListChunks } from '@myco-server-worker/read/scope.js';
import { clearDeletedParentsStatement } from '@myco-server-worker/db/sessions/tombstones.js';

let mf: Miniflare;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({
    modules: true,
    script: 'export default {fetch(){return new Response("ok")}}',
    compatibilityDate: '2026-08-01',
    d1Databases: ['DB_UPGRADE', 'DB_COST', 'DB_LAUNCH', 'DB_PARENT'],
    resourcePersistencePath: await schemaD1Root(['DB_COST', 'DB_LAUNCH', 'DB_PARENT']),
  }));
});

afterAll(async () => {
  await mf?.dispose();
});

/** A binding holding the current schema; `DB_UPGRADE` starts empty and replays the upgrade it tests. */
async function migratedD1(binding: 'DB_COST' | 'DB_LAUNCH' | 'DB_PARENT') {
  return mf.getD1Database(binding);
}

it('upgrades populated v95 sessions to a nullable launch parent, clears deleted sessions\' own parents and indexes both parent columns on native and D1', async () => {
  const native = new Database(':memory:');
  const fresh = new Database(':memory:');
  try {
    expect(SERVER_SCHEMA_VERSION).toBeGreaterThanOrEqual(96);
    const d1 = await mf.getD1Database('DB_UPGRADE');
    for (const step of SCHEMA_STEPS) {
      for (const sql of step.statements) fresh.exec(sql);
      if (step.version > 95) continue;
      for (const sql of step.statements) native.exec(sql);
      await d1.batch(step.statements.map(sql => d1.prepare(sql)));
    }
    const seed = [
      "INSERT INTO projects(project_id,name,created_at) VALUES ('proj_upgrade','Upgrade',1)",
      "INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,parent_session_id,parent_reason) VALUES ('proj_upgrade','before','machine','t',1,1,NULL,NULL)",
      "INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,parent_session_id,parent_reason) VALUES ('proj_upgrade','after','machine','t',2,2,'before','compact continuation')",
      "INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,parent_session_id,parent_reason) VALUES ('proj_upgrade','deleted','machine','t',3,3,'before','fork')",
      "INSERT INTO session_tombstones(project_id,session_id,created_at,created_by) VALUES ('proj_upgrade','deleted',3,'owner')",
    ];
    for (const sql of seed) native.exec(sql);
    await d1.batch(seed.map(sql => d1.prepare(sql)));
    const migration = SCHEMA_STEPS.find(step => step.version === 96)!;
    expect(migration.statements.filter(sql => !sql.startsWith('INSERT OR REPLACE INTO schema_meta'))).toEqual([
      'ALTER TABLE sessions ADD COLUMN launch_parent_session_id TEXT',
      `UPDATE sessions SET parent_session_id = NULL, parent_reason = NULL
     WHERE (parent_session_id IS NOT NULL OR parent_reason IS NOT NULL)
       AND EXISTS (SELECT 1 FROM session_tombstones t WHERE t.project_id = sessions.project_id AND t.session_id = sessions.session_id)`,
      'CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions (project_id, parent_session_id, session_id) WHERE parent_session_id IS NOT NULL',
      'CREATE INDEX IF NOT EXISTS idx_sessions_launch_parent ON sessions (project_id, launch_parent_session_id, session_id) WHERE launch_parent_session_id IS NOT NULL',
    ]);
    for (const sql of migration.statements) native.exec(sql);
    await d1.batch(migration.statements.map(sql => d1.prepare(sql)));
    const indexed = (rows: Record<string, unknown>[]) => rows.map(row => String(row.name)).filter(name => name.includes('parent')).sort();
    for (const db of [sqliteD1(native), d1]) {
      expect((await db.prepare('PRAGMA table_info(sessions)').all()).results).toEqual(fresh.query<Record<string, unknown>, []>('PRAGMA table_info(sessions)').all());
      expect(indexed((await db.prepare("PRAGMA index_list('sessions')").all()).results as Record<string, unknown>[])).toEqual(['idx_sessions_launch_parent', 'idx_sessions_parent']);
      expect((await db.prepare('SELECT session_id,parent_session_id,parent_reason,launch_parent_session_id FROM sessions ORDER BY session_id').all()).results).toEqual([
        { session_id: 'after', parent_session_id: 'before', parent_reason: 'compact continuation', launch_parent_session_id: null },
        { session_id: 'before', parent_session_id: null, parent_reason: null, launch_parent_session_id: null },
        { session_id: 'deleted', parent_session_id: null, parent_reason: null, launch_parent_session_id: null },
      ]);
      expect(await db.prepare("SELECT value FROM schema_meta WHERE key='version'").first()).toEqual({ value: '96' });
    }
  } finally { native.close(); fresh.close(); }
}, 60_000);

it('reads the same D1 rows for a family of 1,000 children as of 10,000, through one parent and across a frontier of several', async () => {
  const d1 = await migratedD1('DB_COST');
  await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('proj_cost','Cost',1)").run();
  const session = (id: string, parent: string | null) => d1.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,launch_parent_session_id)
    VALUES('proj_cost',?,'m','t',1,1,'codex',?)`).bind(id, parent).run();
  await session('wide', null);
  await session('deep', null);
  for (const branch of ['a', 'b', 'c']) await session(`deep-${branch}`, 'deep');
  const grow = (parent: string, prefix: string, size: number) => d1.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<${size})
    INSERT OR IGNORE INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,launch_parent_session_id)
    SELECT 'proj_cost',printf('${prefix}-%05d',i),'m','t',1,1,'codex',? FROM n`).bind(parent).run();
  const cost: Record<string, Array<{ rowsRead: number; nodes: number; truncated: boolean }>> = { wide: [], deep: [] };
  for (const size of [1_000, 10_000]) {
    await grow('wide', 'wide-child', size);
    for (const branch of ['a', 'b', 'c']) await grow(`deep-${branch}`, `deep-${branch}-child`, size);
    for (const root of ['wide', 'deep'] as const) {
      const measured = measuredStore(d1);
      const lineage = (await sessionLineage(measured.db, { projectId: 'proj_cost' }, root))!;
      cost[root]!.push({ rowsRead: measured.reads(), nodes: lineage.nodes.length, truncated: lineage.truncated });
    }
  }
  for (const root of ['wide', 'deep'] as const) {
    expect(cost[root]!.map(c => [c.nodes, c.truncated])).toEqual([[LINEAGE_MAX_NODES, true], [LINEAGE_MAX_NODES, true]]);
    expect(cost[root]![1]!.rowsRead).toBe(cost[root]![0]!.rowsRead);
    expect(cost[root]![0]!.rowsRead).toBeLessThanOrEqual(5 * LINEAGE_MAX_NODES);
  }
}, 60_000);

it.each(['launch_parent_session_id', 'parent_session_id'] as const)('reads the same D1 rows while deleted children grow and live ones stay the same, through %s', async (column) => {
  const d1 = await migratedD1(column === 'launch_parent_session_id' ? 'DB_LAUNCH' : 'DB_PARENT');
  const projectId = 'proj_deleted';
  await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?,'Deleted',1)").bind(projectId).run();
  const LIVE_CHILDREN = 201;
  const root = `root-${column}`;
  await d1.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent) VALUES(?,?,'m','t',1,1,'codex')`).bind(projectId, root).run();
  const children = (from: number, to: number, prefix: string) => d1.prepare(`WITH RECURSIVE n(i) AS (SELECT ${from} UNION ALL SELECT i+1 FROM n WHERE i<${to})
    INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at,agent,${column})
    SELECT ?,printf('${prefix}-%05d',i),'m','t',1,1,'codex',? FROM n`).bind(projectId, root).run();
  // Live children sort after every deleted child.
  await children(1, LIVE_CHILDREN, `${root}-live`);
  const costs: number[] = [];
  let deleted = 0;
  for (const target of [799, 9_799]) {
    const firstNew = deleted + 1;
    await children(firstNew, target, `${root}-deleted`);
    const remainingIds = Array.from({ length: target - firstNew }, (_, i) =>
      `${root}-deleted-${String(firstNew + 1 + i).padStart(5, '0')}`);
    await d1.batch([
      d1.prepare(`INSERT OR IGNORE INTO session_tombstones (project_id, session_id, reason, created_at, created_by) VALUES (?, ?, NULL, 1, 'owner')`).bind(projectId, `${root}-deleted-${String(firstNew).padStart(5, '0')}`),
      clearDeletedParentsStatement(asStore(d1), projectId, [`${root}-deleted-${String(firstNew).padStart(5, '0')}`]),
      ...(remainingIds.length === 0 ? [] : [
        d1.prepare(`WITH RECURSIVE n(i) AS (SELECT ${firstNew + 1} UNION ALL SELECT i+1 FROM n WHERE i<${target})
          INSERT OR IGNORE INTO session_tombstones (project_id, session_id, reason, created_at, created_by)
          SELECT ?, printf('${root}-deleted-%05d', i), NULL, 1, 'owner' FROM n`).bind(projectId),
        d1.prepare(`UPDATE sessions SET title = NULL, summary = NULL, titled_at = NULL, titled_by = NULL
          WHERE project_id = ? AND session_id GLOB ?
            AND (title IS NOT NULL OR summary IS NOT NULL OR titled_at IS NOT NULL OR titled_by IS NOT NULL)`)
          .bind(projectId, `${root}-deleted-*`),
        ...inListChunks(remainingIds).map(chunk => clearDeletedParentsStatement(asStore(d1), projectId, chunk)),
      ]),
    ] as never);
    deleted = target;
    const measured = measuredStore(d1);
    const lineage = (await sessionLineage(measured.db, { projectId }, root))!;
    expect([lineage.nodes.length, lineage.truncated]).toEqual([LINEAGE_MAX_NODES, true]);
    costs.push(measured.reads());
  }
  expect({ column, flat: costs[1] === costs[0], costs }).toEqual({ column, flat: true, costs: [costs[0], costs[0]] });
}, 120_000);

/** The D1 binding as the server's store: its prepared statements batch as they are. */
function asStore(d1: Awaited<ReturnType<Miniflare['getD1Database']>>) {
  return d1 as unknown as Parameters<typeof clearDeletedParentsStatement>[0];
}
