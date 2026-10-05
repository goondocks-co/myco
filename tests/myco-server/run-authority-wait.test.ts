import { expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { runAuthorityWait } from './helpers/run-authority-wait.js';

const expected = ['lease', 'attempt', 'credential'].map(bound => ({ bound, refused: true, applied: 0, rows: 0 }));

it('native: authority expires while the real store batch waits', async () => {
  const sqlite = new Database(':memory:');
  try { expect(await runAuthorityWait(sqliteRelationalStore(sqlite))).toEqual(expected); }
  finally { sqlite.close(); }
});

it('D1 workerd: authority expires while the real store batch waits', async () => {
  const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/run-authority-wait.ts`], format: 'esm', target: 'browser', external: ['cloudflare:workers'] });
  if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
  const mf = new Miniflare({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { runAuthorityWait } from './scenario.js';
      export default { async fetch(request, env) { try { return Response.json(await runAuthorityWait(env.DB)); }
        catch(error) { return Response.json({ error: String(error.stack) }, { status: 500 }); } } };` },
    { type: 'ESModule', path: 'scenario.js', contents: await bundle.outputs[0]!.text() },
  ], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'] });
  try {
    const response = await mf.dispatchFetch('http://authority/');
    const answer = await response.json();
    expect({ status: response.status, answer }).toEqual({ status: 200, answer: expected });
  } finally { await mf.dispose(); }
}, 60_000);
