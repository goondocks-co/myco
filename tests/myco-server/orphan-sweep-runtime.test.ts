import { expect, it } from 'bun:test';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { blobObjectKey } from '@myco-server-worker/core/blob-objects.js';
import { BLOB_RESERVATION_TTL_MS } from '@myco-server-worker/constants.js';

const key = (n: number) => n.toString(16).padStart(64, '0');
const generation = '00000000-0000-4000-8000-000000000001';
const now = BLOB_RESERVATION_TTL_MS + 2;

it('workerd D1/R2 sweeps all-held pages, a sparse orphan, and a late orphan behind the cursor', async () => {
  const bundle = await Bun.build({
    entrypoints: ['packages/myco-server/src/ingest/retention.ts', 'packages/myco-server/src/platform/cloudflare/env.ts',
      'packages/myco-server/src/core/object-release.ts'],
    format: 'esm', target: 'browser', external: ['cloudflare:workers'], naming: { entry: '[name].js' },
  });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
  const source = new Map(await Promise.all(bundle.outputs.map(async output => [output.path.split('/').at(-1)!, await output.text()] as const)));
  const mf = new Miniflare({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { freeOrphanedBlobs } from './retention.js';
      import { serverEnvFromBindings } from './env.js';
      import { drainObjectReleases } from './object-release.js';
      export default { async fetch(request, bindings) {
        const env = serverEnvFromBindings({ MYCO_DB: bindings.DB, BUCKET: bindings.BUCKET,
          SOURCE_LIMIT: { limit: async () => ({ success: true }) }, TOKEN_LIMIT: { limit: async () => ({ success: true }) } });
        const now = Number(new URL(request.url).searchParams.get('now'));
        const freed = await freeOrphanedBlobs(env, now);
        await drainObjectReleases(env, now);
        return Response.json({ freed });
      }};` },
    ...[...source].map(([name, contents]) => ({ type: 'ESModule' as const, path: name, contents })),
  ], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
  try {
    const db = await mf.getD1Database('DB');
    const bucket = await mf.getR2Bucket('BUCKET');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    const admissionPlan = await db.prepare(`EXPLAIN QUERY PLAN SELECT 1 AS present FROM session_tombstones WHERE created_at > ? LIMIT 1`)
      .bind(now - 1).all<{ detail: string }>();
    expect(admissionPlan.results.some((step) => /SEARCH session_tombstones USING COVERING INDEX idx_session_tombstones_created/.test(step.detail))).toBe(true);
    await db.prepare(`INSERT INTO projects(project_id,name,created_at) VALUES('proj_1','a',0)`).run();
    const held = 24;
    const seed = async (n: number, heldByCall: boolean) => {
      const digest = key(n);
      await db.prepare(`INSERT INTO blobs(project_id,key,size,media_type,token_id,received_at,generation)
        VALUES('proj_1',?,1,'text/plain','t',1,?)`).bind(digest,generation).run();
      await bucket.put(blobObjectKey('proj_1',digest,generation),'x');
      if (heldByCall) await db.prepare(`INSERT INTO tool_calls(project_id,tool_call_id,session_id,event_id,
        tool_name,input_blob_key,success,created_at,token_id,received_at)
        VALUES('proj_1',?,'s',?,'Read',?,1,1,'t',1)`).bind(`tc-${n}`,`e-${n}`,digest).run();
    };
    for (let n=1;n<=held;n+=1) await seed(n,true);
    await seed(held+1,false);
    await db.prepare(`INSERT INTO session_tombstones(project_id,session_id,created_at,created_by)
      VALUES('proj_1','gone',1,'fixture')`).run();
    const sweep = async () => {
      const response = await mf.dispatchFetch(`http://orphan/?now=${now}`);
      const result = await response.json() as {freed?:number};
      expect(response.status,JSON.stringify(result)).toBe(200);
      return result.freed;
    };
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(1);
    expect(await bucket.head(blobObjectKey('proj_1',key(held+1),generation))).toBeNull();
    expect(await bucket.head(blobObjectKey('proj_1',key(1),generation))).not.toBeNull();
    await seed(0,false);
    expect(await sweep()).toBe(0);
    expect(await sweep()).toBe(1);
    expect(await bucket.head(blobObjectKey('proj_1',key(0),generation))).toBeNull();
    expect((await db.prepare(`SELECT cursor_project,cursor_key FROM orphan_sweep_state WHERE id=1`).first())?.cursor_key).toBe(key(7));
  } finally { await mf.dispose(); }
}, 120_000);
