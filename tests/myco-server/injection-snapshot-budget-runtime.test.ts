import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { tombstoneSession } from '@myco-server-worker/core/tombstones.js';
import { measuredStore } from './helpers/read-budget.js';

it('D1 source tombstones read only their snapshots among 10000 served plans', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true,
    script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('snapshot-budget','Snapshots',1)").run();
    for (const session of ['source-target', 'source-other', 'receiver']) {
      await db.prepare(`INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        VALUES('snapshot-budget',?,'machine','fixture',1,1)`).bind(session).run();
    }
    await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<5000)
      INSERT INTO spore_injections(project_id,session_id,id,prompt_id,prompt_hash,spore_ids,plan_ids,created_at)
      SELECT 'snapshot-budget','receiver',printf('00000000-0000-4000-8000-%012d',i),
        printf('00000000-0000-7000-8000-%012d',i),'prompt-hash-'||i,'[]',
        json_array('plan-'||(i*2-1),'plan-'||(i*2)),i FROM seq`).run();
    await db.prepare(`WITH RECURSIVE seq(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM seq WHERE i<10000)
      INSERT INTO injection_served_items(project_id,receipt_id,kind,item_id,title,session_id,content_hash,unavailable)
      SELECT 'snapshot-budget',printf('00000000-0000-4000-8000-%012d',(i+1)/2),'plan','plan-'||i,'Served plan '||i,
        CASE WHEN i<=200 THEN 'source-target' ELSE 'source-other' END,'content-hash-'||i,0 FROM seq`).run();
    const measured = measuredStore(db);
    expect((await tombstoneSession({ db: measured.db }, { projectId: 'snapshot-budget' }, 'source-target', 'fixture', 10001)).applied).toBe(true);
    const rowsRead = measured.reads();
    expect(rowsRead).toBeLessThan(1000);
    const inventory = await db.prepare("PRAGMA index_list('injection_served_items')").all<{ name: string; partial: number }>();
    expect(inventory.results.find(index => index.name === 'idx_injection_served_items_source_session')?.partial).toBe(1);
    expect((await db.prepare("PRAGMA index_info('idx_injection_served_items_source_session')").all<{ name: string }>()).results.map(column => column.name))
      .toEqual(['project_id', 'session_id']);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM injection_served_items
      WHERE session_id IS NULL AND title IS NULL AND content_hash IS NULL AND unavailable=1`).first<{ n: number }>())?.n).toBe(200);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM injection_served_items
      WHERE session_id='source-other' AND title IS NOT NULL AND content_hash IS NOT NULL AND unavailable=0`).first<{ n: number }>())?.n).toBe(9800);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM spore_injections').first<{ n: number }>())?.n).toBe(5000);
    console.info('SNAPSHOT_TOMBSTONE_READ_BUDGET', { snapshots: 10000, sourceSnapshots: 200, rowsRead });
  } finally { await mf.dispose(); }
}, 30000);
