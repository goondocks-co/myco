import { describe, expect, it } from 'bun:test';
import { Miniflare } from 'miniflare';
import { SCHEMA_STEPS } from '@myco-server-worker/db/schema.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { ingestContinuityRuntime } from './helpers/ingest-continuity-runtime.js';
import { PARSERS } from '@myco-server-worker/ingest/parsers/registry.js';

const check = (answer: Awaited<ReturnType<typeof ingestContinuityRuntime>>) => {
  expect(answer.toSorted((a, b) => a.agent.localeCompare(b.agent))).toEqual(Object.keys(PARSERS).sort().map((agent) => ({ agent, equal: true, later: true })));
};

describe('ingest continuation runtime parity', () => {
  it('native SQLite: real uploads preserve complete rows across live appends and later oversized turns', async () => {
    const source = sqliteEnv();
    try { check(await ingestContinuityRuntime(source.db, source.bucket)); }
    finally { source.sqlite.close(); }
  }, 60_000);

  it('D1 workerd: real uploads preserve complete rows across live appends and later oversized turns', async () => {
    const bundle = await Bun.build({ entrypoints: [`${import.meta.dir}/helpers/ingest-continuity-runtime.ts`], format: 'esm', target: 'browser', external: ['cloudflare:workers'] });
    if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
    const mf = new Miniflare({
      modules: [
        { type: 'ESModule', path: 'worker.js', contents: `import { ingestContinuityRuntime } from './scenario.js';
          export default { async fetch(request, env) {
            try { return Response.json(await ingestContinuityRuntime(env.DB, env.BUCKET)); }
            catch (error) { return Response.json({ error: String(error.stack) }, { status: 500 }); }
          } };` },
        { type: 'ESModule', path: 'scenario.js', contents: await bundle.outputs[0]!.text() },
      ],
      compatibilityDate: '2026-07-01', compatibilityFlags: ['nodejs_compat'], d1Databases: ['DB'], r2Buckets: ['BUCKET'],
    });
    try {
      const db = await mf.getD1Database('DB');
      for (const step of SCHEMA_STEPS) await db.batch(step.statements.map((sql) => db.prepare(sql)));
      const response = await mf.dispatchFetch('http://continuity/');
      const answer = await response.json();
      expect({ status: response.status, error: response.status === 200 ? undefined : answer }).toEqual({ status: 200, error: undefined });
      check(answer as Awaited<ReturnType<typeof ingestContinuityRuntime>>);
    } finally { await mf.dispose(); }
  }, 60_000);
});
