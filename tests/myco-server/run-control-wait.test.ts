import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';
import { runControlWait } from './helpers/run-control-wait.js';

const expected = ['publication', 'map_pin', 'repository_pin'].flatMap(op => ['attempt', 'credential', 'revocation']
  .map(bound => ({ op, bound, code: 'no_run', refused: true, maps: 0, pinned: false })));

it('native: retained publication and pin writes refuse authority lost in the store queue', async () => {
  const sqlite = new Database(':memory:');
  try {
    for (const step of SCHEMA_STEPS) for (const sql of step.statements) sqlite.exec(sql);
    expect(await runControlWait(serverEnvFromBunConfig({ sqlite, blobDir: '/unused' }))).toEqual(expected);
  } finally { sqlite.close(); }
}, 30_000);

it('D1 workerd: retained publication and pin writes refuse authority lost in the store queue', async () => {
  const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/run-control-wait.ts`, 'packages/myco-server/src/platform/cloudflare/env.ts'],
    format: 'esm', target: 'browser', external: ['cloudflare:workers'], splitting: false });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
  const scenario = bundle.outputs.find(output => output.path.endsWith('run-control-wait.js'))!;
  const environment = bundle.outputs.find(output => output.path.endsWith('env.js'))!;
  const mf = new Miniflare({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { runControlWait } from './scenario.js'; import { serverEnvFromBindings } from './env.js';
      export default { async fetch(request, env) { try { return Response.json(await runControlWait(serverEnvFromBindings({ MYCO_DB: env.DB, BUCKET: env.BUCKET,
        SOURCE_LIMIT: {limit: async()=>({success:true})}, TOKEN_LIMIT: {limit: async()=>({success:true})} }))); }
        catch(error) { return Response.json({ error: String(error.stack) }, { status: 500 }); } } };` },
    { type: 'ESModule', path: 'scenario.js', contents: await scenario.text() },
    { type: 'ESModule', path: 'env.js', contents: await environment.text() },
  ], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
  try {
    const db = await mf.getD1Database('DB');
    for (const step of SCHEMA_STEPS) await db.batch(step.statements.map(sql => db.prepare(sql)));
    const response = await mf.dispatchFetch('http://authority/');
    expect({ status: response.status, answer: await response.json() }).toEqual({ status: 200, answer: expected });
  } finally { await mf.dispose(); }
}, 60_000);
