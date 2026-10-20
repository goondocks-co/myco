import { expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RECONCILIATION_CASES } from './helpers/reconciliation-cases.js';
import { RECONCILIATION_FIXTURE } from './helpers/reconciliation-vectors.js';

it('workerd D1 runs the production reconciliation matrices', async () => {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/reconciliation-vectors.ts`], format: 'esm', target: 'browser' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { runReconciliationCase } from './vectors.js';
      export default { async fetch(request, env) { try { await runReconciliationCase(env.DB, new URL(request.url).pathname.slice(1)); return Response.json({ passed: true }); }
        catch (error) { return Response.json({ error: String(error.stack) }, { status: 500 }); } } };` },
    { type: 'ESModule', path: 'vectors.js', contents: await built.outputs[0]!.text() },
  ], compatibilityDate: '2026-08-01', d1Databases: ['DB'] }));
  try {
    const db = await mf.getD1Database('DB');
    await db.batch(RECONCILIATION_FIXTURE.map(sql => db.prepare(sql)));
    for (const name of RECONCILIATION_CASES) {
      const response = await mf.dispatchFetch(`http://reconcile/${name}`);
      expect(await response.json(), name).toEqual({ passed: true });
      expect(response.status, name).toBe(200);
    }
  } finally { await mf.dispose(); }
}, 60_000);
