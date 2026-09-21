/**
 * Runtime proof for hosted store maintenance, on real workerd.
 *
 * The product's own D1 port is bundled and run inside a workerd isolate against a local D1, so what D1 accepts,
 * refuses and reports here is D1's own answer: the documented checks run, the undocumented ones are never sent,
 * and the size comes from `meta.size_after`. The checks live D1 would run are the same statements; this does not
 * prove anything about a deployed database's plan or quota.
 *
 * Usage: bun tests/myco-server/runtime/store-maintenance-runtime.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Miniflare } from 'miniflare';

const ROOT = path.resolve(import.meta.dir, '../../..');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-store-maintenance-runtime-'));
const EVIDENCE = process.env.MYCO_STORE_MAINTENANCE_EVIDENCE ?? path.join(RUN, 'result.json');
const checks: Array<Record<string, unknown>> = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  checks.push({ check: label, ok, actual, ...(ok ? {} : { expected }) });
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}: ${JSON.stringify(actual).slice(0, 220)}`);
  if (!ok) throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const bundle = await Bun.build({
  entrypoints: [path.join(ROOT, 'packages/myco-server/src/platform/cloudflare/store-maintenance.ts')],
  format: 'esm', target: 'browser',
});
if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
const port = await bundle.outputs[0]!.text();

const worker = `
import { d1StoreMaintenance } from './port.js';
export default {
  async fetch(request, env) {
    const step = new URL(request.url).pathname.slice(1);
    const db = env.DB;
    const port = d1StoreMaintenance(db);
    try {
      if (step === 'seed') {
        await db.batch([
          db.prepare('CREATE TABLE maint_parent (id INTEGER PRIMARY KEY)'),
          db.prepare('CREATE TABLE maint_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES maint_parent(id))'),
        ]);
        return Response.json({ ok: true });
      }
      if (step === 'dangle') {
        await db.exec('PRAGMA foreign_keys = off; INSERT INTO maint_child (parent) VALUES (99);');
        return Response.json({ ok: true });
      }
      if (step === 'refused') {
        const out = {};
        for (const sql of ['PRAGMA integrity_check', 'PRAGMA page_count']) {
          try { await db.prepare(sql).all(); out[sql] = 'accepted'; } catch (e) { out[sql] = String(e.message); }
        }
        return Response.json(out);
      }
      return Response.json({ support: port.support, result: await port.run(step) });
    } catch (e) {
      return Response.json({ error: String(e.message) }, { status: 500 });
    }
  },
};`;

const mf = new Miniflare({
  modules: [
    { type: 'ESModule', path: 'worker.js', contents: worker },
    { type: 'ESModule', path: 'port.js', contents: port },
  ],
  compatibilityDate: '2026-07-01',
  d1Databases: ['DB'],
  d1Persist: path.join(RUN, 'd1'),
});
const call = async (step: string) => (await mf.dispatchFetch(`http://runtime/${step}`)).json() as Promise<any>;

try {
  check('seed', await call('seed'), { ok: true });
  const optimize = await call('optimize');
  check('optimize: supported', optimize.support.optimize.supported, true);
  check('optimize: no findings', optimize.result.findings, []);
  check('optimize: size measured from size_after', optimize.result.measurements[0].state === 'measured' && optimize.result.measurements[0].value > 0, true);
  check('optimize: size limit unavailable', optimize.result.measurements.find((m: any) => m.name === 'size_limit').state, 'unavailable');
  check('optimize: daily quota unavailable', optimize.result.measurements.find((m: any) => m.name === 'daily_quota').state, 'unavailable');
  const clean = await call('integrity');
  check('integrity: clean store answers no findings', clean.result.findings, []);
  // D1 enforces foreign keys at commit even with enforcement switched off, so no write can leave one dangling:
  // the finding path is reachable only from a store that arrived damaged, which a local D1 cannot be made into.
  const dangled = await call('dangle');
  check('a dangling foreign key is refused at commit', String(dangled.error).includes('SQLITE_CONSTRAINT_FOREIGNKEY'), true);
  check('integrity after the refused write: still no findings', (await call('integrity')).result.findings, []);
  const refused = await call('refused');
  check('undocumented pragmas refused by D1', Object.values(refused).every((v) => String(v).includes('SQLITE_AUTH')), true);
} finally {
  await mf.dispose();
  fs.writeFileSync(EVIDENCE, JSON.stringify({ checks }, null, 2));
  console.log(`evidence: ${EVIDENCE}`);
}
