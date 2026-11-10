import { expect, test } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { hasEmbeddingWork } from '@myco-server-worker/core/embedding/work.js';
import { prepareEmbeddingDue, resetEmbeddingIndex } from '@myco-server-worker/db/embeddings/work.js';
import { modelProgress, modelReadiness } from '@myco-server-worker/db/embeddings/status.js';
import { catchUpProjections } from '@myco-server-worker/db/projections/catchup.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const NOW = 10 ** 12;
const MODEL = 'm';

async function world(run: (d1: Awaited<ReturnType<Miniflare['getD1Database']>>) => Promise<void>) {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }',
    compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  try {
    const d1 = await mf.getD1Database('DB');
    await d1.prepare("INSERT INTO agents(id,name,source,enabled,created_at) VALUES('a','a','built-in',1,1)").run();
    await run(d1);
  } finally { await mf.dispose(); }
}

const seq = (n: number) => `WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM n WHERE x<${n})`;

test('readiness and work checks read fixed rows, however many ineligible sources a Project holds', async () => {
  await world(async (d1) => {
    const measured = measuredStore(d1);
    const reads: Record<string, number[]> = {};
    const take = async <T,>(label: string, fn: () => Promise<T>): Promise<T> => {
      measured.reset();
      const result = await fn();
      (reads[label] ??= []).push(measured.reads());
      return result;
    };
    for (const [project, size] of [['small', 400], ['large', 4_000]] as const) {
      await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)").bind(project, project).run();
      await d1.prepare(`${seq(size)} INSERT INTO sessions(project_id,session_id,machine_id,created_by_token_id,first_received_at,last_received_at)
        SELECT ?,printf('session-%06d',x),'machine','token',1,1 FROM n`).bind(project).run();
      expect(await take('uninitialized readiness', () => modelReadiness(measured.db, project, MODEL, NOW))).toMatchObject({ state: 'ready', total: 0 });
      expect(await take('uninitialized work', () => hasEmbeddingWork(measured.db, project, MODEL, NOW))).toBe(false);
      while ((await prepareEmbeddingDue(d1, project, MODEL)).more);
      expect(await take('initialized readiness', () => modelReadiness(measured.db, project, MODEL, NOW))).toMatchObject({ state: 'ready', ready: 0, total: 0 });
      expect(await take('initialized work', () => hasEmbeddingWork(measured.db, project, MODEL, NOW + 1))).toBe(false);
      await take('unregistered progress', () => modelProgress(measured.db, 'never-used', NOW));
    }
    console.info(`embedding readiness rows read at 400 / 4,000 ineligible sessions: ${JSON.stringify(reads)}`);
    for (const [label, [small, large]] of Object.entries(reads)) {
      // A model never registered reads one row more once the Project holds sessions at all.
      expect({ label, large }).toEqual({ label, large: label === 'unregistered progress' ? Math.min(large!, small! + 1) : small });
    }
  });
}, 120_000);

test('a reset is admitted in one bounded commit, reads building, and retires history in bounded pages', async () => {
  await world(async (d1) => {
    const measured = measuredStore(d1);
    const admission: Array<{ reads: number; writes: number }> = [];
    const pages: Array<Array<{ reads: number; writes: number }>> = [];
    // The first reset of a Deployment does less than every later one, so a small warm-up Project goes first.
    for (const [project, size] of [['warm', 50], ['small', 400], ['large', 2_000]] as const) {
      await d1.prepare("INSERT INTO projects(project_id,name,created_at) VALUES(?,?,1)").bind(project, project).run();
      await d1.prepare(`${seq(size)} INSERT INTO plans(project_id,plan_key,session_id,event_id,machine_id,content,content_hash,status,created_at,updated_at,token_id,received_at)
        SELECT ?,printf('plan-%06d',x),'s','e','machine','body','h','active',1,1,'token',1 FROM n`).bind(project).run();
      await d1.prepare(`${seq(size)} INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) SELECT ?,printf('spore-%06d',x),'a','body','decision',1 FROM n`).bind(project).run();
      while ((await prepareEmbeddingDue(d1, project, MODEL)).more);
      await d1.prepare(`INSERT INTO embedding_receipts(project_id,model_key,id,type,record_id,revision,ready,updated_at)
        SELECT project_id,?,record_id,type,record_id,revision,1,1 FROM embedding_versions WHERE project_id=?`).bind(MODEL, project).run();
      await d1.prepare(`INSERT INTO embedding_hubness_members(project_id,model_key,id,n,vector) SELECT project_id,model_key,id,0,'AACAPw==' FROM embedding_receipts
        WHERE project_id=? AND type='spore'`).bind(project).run();
      await d1.prepare(`INSERT INTO embedding_source_failures(project_id,type,record_id,model_key,revision,reason,recorded_at)
        SELECT project_id,type,record_id,'',revision,'unreadable',1 FROM embedding_versions WHERE project_id=? AND type='plan' AND record_id<='plan-000050'`).bind(project).run();
      expect(await modelReadiness(d1, project, MODEL, NOW)).toMatchObject({ state: 'ready', ready: size * 2 });
      measured.reset();
      await resetEmbeddingIndex(measured.db, project);
      admission.push({ reads: measured.reads(), writes: measured.writes() });
      expect(await modelReadiness(d1, project, MODEL, NOW)).toMatchObject({ state: 'building' });
      const calls: Array<{ reads: number; writes: number }> = [];
      pages.push(calls);
      for (;;) {
        measured.reset();
        const page = await catchUpProjections(measured.db, { budget: { calls: 12, wallMs: 60_000 } });
        calls.push({ reads: measured.reads(), writes: measured.writes() });
        if (!page.more) break;
      }
      const left = await d1.prepare(`SELECT (SELECT COUNT(*) FROM embedding_receipts WHERE project_id=?1) AS receipts,
        (SELECT COUNT(*) FROM embedding_source_failures WHERE project_id=?1) AS failures, (SELECT COUNT(*) FROM embedding_hubness_members WHERE project_id=?1) AS members,
        (SELECT COUNT(*) FROM embedding_due WHERE project_id=?1) AS due, (SELECT COUNT(*) FROM embedding_versions WHERE project_id=?1) AS versions`).bind(project).first();
      expect(left).toEqual({ receipts: 0, failures: 0, members: 0, due: size * 2, versions: size * 2 });
      expect(await modelReadiness(d1, project, MODEL, NOW)).toMatchObject({ state: 'ready', ready: 0, total: size * 2, byState: { unwritten: size * 2 } });
      expect(await hasEmbeddingWork(d1, project, MODEL, NOW)).toBe(true);
    }
    const worst = (rows: Array<{ reads: number; writes: number }>) => ({ reads: Math.max(...rows.map(r => r.reads)), writes: Math.max(...rows.map(r => r.writes)) });
    console.info(`embedding reset at 800 / 4,000 sources: admission ${JSON.stringify(admission)}; worst page call ${JSON.stringify(pages.map(worst))} over ${JSON.stringify(pages.map(p => p.length))} calls`);
    // A reset's admission and its costliest page call cost the same at 4,000 sources as at 800.
    expect(admission[2]!.reads).toBeLessThanOrEqual(admission[1]!.reads);
    expect(admission[2]!.writes).toBeLessThanOrEqual(admission[1]!.writes);
    expect(worst(pages[2]!).reads).toBeLessThanOrEqual(worst(pages[1]!).reads);
    expect(worst(pages[2]!).writes).toBeLessThanOrEqual(worst(pages[1]!).writes);
  });
}, 300_000);
