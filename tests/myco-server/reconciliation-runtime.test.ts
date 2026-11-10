import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { RECONCILIATION_CASES } from './helpers/reconciliation-vectors.js';
import { schemaD1Root } from './helpers/schema-template.js';

// Each case runs inside a Worker against a D1 database of its own holding the current schema.
const BINDINGS = RECONCILIATION_CASES.map((_, i) => `DB_${i}`);
let mf: Miniflare | undefined;

beforeAll(async () => {
  const built = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/reconciliation-vectors.ts`], format: 'esm', target: 'browser' });
  if (!built.success) throw new Error(built.logs.map(String).join('\n'));
  mf = new Miniflare(convertV4MiniflareOptions({ modules: [
    { type: 'ESModule', path: 'worker.js', contents: `import { runReconciliationCase } from './vectors.js';
      export default { async fetch(request, env) { const url = new URL(request.url);
        try { await runReconciliationCase(env[url.searchParams.get('db')], url.searchParams.get('case')); return Response.json({ passed: true }); }
        catch (error) { return Response.json({ error: String(error.stack) }, { status: 500 }); } } };` },
    { type: 'ESModule', path: 'vectors.js', contents: await built.outputs[0]!.text() },
  ], compatibilityDate: '2026-08-01', d1Databases: BINDINGS, resourcePersistencePath: await schemaD1Root(BINDINGS) }));
}, 120_000);

afterAll(async () => { await mf?.dispose(); });

for (const [i, name] of RECONCILIATION_CASES.entries()) {
  it(`workerd D1: ${name}`, async () => {
    const response = await mf!.dispatchFetch(`http://reconcile/?db=${BINDINGS[i]}&case=${encodeURIComponent(name)}`);
    expect({ status: response.status, body: await response.json() }).toEqual({ status: 200, body: { passed: true } });
  }, 60_000);
}
