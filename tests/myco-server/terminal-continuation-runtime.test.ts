import { describe, expect, it } from 'bun:test';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { terminalContinuationRuntime } from './helpers/terminal-continuation-runtime.js';

describe('terminal continuation runtime parity', () => {
  it('native SQLite: terminal wakes record calls and late results upgrade the same row', async () => {
    const source = sqliteEnv();
    try { expect(await terminalContinuationRuntime(source.db, source.bucket)).toHaveLength(18); }
    finally { source.sqlite.close(); }
  });
  it('D1 workerd: terminal wakes record calls and late results upgrade the same row', async () => {
    const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/terminal-continuation-runtime.ts`], format: 'esm', target: 'browser', external: ['cloudflare:workers'] });
    if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
    const mf = new Miniflare({ modules: [
      { type: 'ESModule', path: 'worker.js', contents: `import { terminalContinuationRuntime } from './scenario.js';
        export default { async fetch(request, env) { try { return Response.json(await terminalContinuationRuntime(env.DB, env.BUCKET)); }
          catch(error) { return Response.json({ error: String(error.stack) }, { status: 500 }); } } };` },
      { type: 'ESModule', path: 'scenario.js', contents: await bundle.outputs[0]!.text() },
    ], compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'] });
    try {
      const db = await mf.getD1Database('DB');
      for (const step of SCHEMA_STEPS) await db.batch(step.statements.map((sql) => db.prepare(sql)));
      const response = await mf.dispatchFetch('http://terminal/');
      const answer = await response.json();
      expect({ status: response.status, answer: response.status === 200 ? undefined : answer }).toEqual({ status: 200, answer: undefined });
      expect(answer).toHaveLength(18);
    } finally { await mf.dispose(); }
  }, 60_000);
});
