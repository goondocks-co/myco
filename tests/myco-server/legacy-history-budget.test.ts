import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { importedLegacyRows } from '@myco-server-worker/read/legacy-history.js';
import { LEGACY_HISTORY_MAX_EVENTS } from '@goondocks/myco-shared/member-protocol';
import { measuredStore } from './helpers/read-budget.js';

it('D1 source proof reads a bounded set of identities independently of retained history size', async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    await db.prepare("INSERT INTO projects(project_id,name,created_at) VALUES('project','Project',1)").run();
    await db.prepare("INSERT OR IGNORE INTO agents(id,name,created_at) VALUES('user','User',1)").run();
    const seed = async (start: number, end: number) => {
      const seq = `WITH RECURSIVE n(i) AS (SELECT ${start} UNION ALL SELECT i+1 FROM n WHERE i<${end})`;
      await db.prepare(seq + " INSERT INTO spores(project_id,id,agent_id,observation_type,content,created_at,author) SELECT 'project','spore-'||i,'user','gotcha','Retained',1,'member' FROM n").run();
      await db.prepare(seq + " INSERT INTO resolution_events(project_id,id,agent_id,spore_id,action,created_at,author) SELECT 'project','lineage-'||i,'user','spore-'||i,'obsolete',1,'member' FROM n").run();
    };
    const count = LEGACY_HISTORY_MAX_EVENTS / 2;
    const sporeIds = Array.from({ length: count }, (_, i) => `spore-${i+1}`);
    const lineageIds = Array.from({ length: count }, (_, i) => `lineage-${i+1}`);
    const measured = measuredStore(db);
    const measure = async () => {
      measured.reset();
      const proof = await importedLegacyRows(measured.db, 'project', 'member', 'machine', sporeIds, lineageIds);
      expect(proof.sporeIds.size).toBe(count); expect(proof.lineageIds.size).toBe(count);
      expect(measured.writes()).toBe(0);
      return measured.reads();
    };
    await seed(1, 1000);
    const small = await measure();
    await seed(1001, 20000);
    const large = await measure();
    expect(large).toBe(small);
    expect(large).toBeLessThanOrEqual(4 * LEGACY_HISTORY_MAX_EVENTS);
    console.info('LEGACY_HISTORY_D1_BUDGET', { identities: 1000, retainedRows: 40000, rowsRead: large });
  } finally { await mf.dispose(); }
}, 120_000);
