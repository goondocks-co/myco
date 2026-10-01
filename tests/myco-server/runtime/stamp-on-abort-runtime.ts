/**
 * Runtime proof that a turn's stamp lands when the member stops waiting mid-compose (#1558), on real workerd and on
 * Bun's own server.
 *
 * The product's `noteTurnStarted` is bundled and run inside a workerd isolate against a local D1, through the
 * Cloudflare target's own deferral (`ctx.waitUntil(work())`), and on Bun through `serverEnvFromBunConfig`'s. Each
 * handler stands in for `handlePromptContext`: it registers the stamp, then stalls as a slow compose would, and the
 * client aborts during the stall. The stamp must land on both. As a control, a handler that registers the stamp only
 * after the stall shows what the old order did on each target when the client went away.
 *
 * Usage: bun tests/myco-server/runtime/stamp-on-abort-runtime.ts
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Database } from 'bun:sqlite';
import { Miniflare } from 'miniflare';
import { noteTurnStarted } from '@myco-server-worker/api/recall.js';
import { serverEnvFromBunConfig } from '@myco-server-worker/platform/bun/env.js';

const ROOT = path.resolve(import.meta.dir, '../../..');
const RUN = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-stamp-abort-runtime-'));
const EVIDENCE = process.env.MYCO_STAMP_ABORT_EVIDENCE ?? path.join(RUN, 'result.json');
const STALL_MS = 3_000;
const ABORT_MS = 300;
const results: Array<Record<string, unknown>> = [];

/** A prompt id as the member mints one: a UUIDv7 whose timestamp is `at`. */
const promptIdAt = (at: number): string => {
  const hex = at.toString(16).padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7abc-8def-${crypto.randomUUID().slice(-12)}`;
};

const SESSIONS = `CREATE TABLE sessions (project_id TEXT, session_id TEXT, machine_id TEXT, working_since INTEGER, last_turn_end_at INTEGER, PRIMARY KEY (project_id, session_id))`;

function record(target: string, order: string, stamped: unknown, at: number, aborted: string): void {
  const landed = stamped === at;
  results.push({ target, order, aborted, landed });
  console.log(`${target.padEnd(10)} ${order.padEnd(14)} client: ${aborted.padEnd(8)} stamp ${landed ? 'LANDED' : 'missing'}`);
}

// ---------- workerd ----------
const entry = path.join(RUN, 'entry.ts');
fs.writeFileSync(entry, `export { noteTurnStarted } from ${JSON.stringify(path.join(ROOT, 'packages/myco-server/src/api/recall.ts'))};\n`);
const bundle = await Bun.build({ entrypoints: [entry], format: 'esm', target: 'browser', root: ROOT, tsconfig: path.join(ROOT, 'tsconfig.json') });
if (!bundle.success) throw new Error(bundle.logs.map(String).join('\n'));
const stamp = await bundle.outputs[0]!.text();

const worker = `
import { noteTurnStarted } from './stamp.js';
const stall = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/seed') {
      await env.DB.exec(${JSON.stringify(SESSIONS)});
      return Response.json({ ok: true });
    }
    if (url.pathname === '/read') {
      const row = await env.DB.prepare('SELECT working_since AS at FROM sessions WHERE session_id = ?').bind(url.searchParams.get('session')).first();
      return Response.json({ at: row ? row.at : null });
    }
    const session = url.searchParams.get('session');
    await env.DB.prepare('INSERT INTO sessions (project_id, session_id, machine_id) VALUES (?, ?, ?)').bind('proj_1', session, 'machine_1').run();
    const serverEnv = { db: env.DB, afterResponse: (work) => ctx.waitUntil(work()) };
    const routeCtx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'tok', now: Date.now() };
    const promptId = url.searchParams.get('prompt');
    if (url.pathname === '/first') noteTurnStarted(serverEnv, routeCtx, session, promptId);
    await stall(${STALL_MS});
    if (url.pathname === '/after') noteTurnStarted(serverEnv, routeCtx, session, promptId);
    return Response.json({ persisted: true });
  },
};`;

const mf = new Miniflare({
  modules: [{ type: 'ESModule', path: 'worker.js', contents: worker }, { type: 'ESModule', path: 'stamp.js', contents: stamp }],
  compatibilityDate: '2026-07-01',
  d1Databases: ['DB'],
});
try {
  await (await mf.dispatchFetch('http://runtime/seed')).json();
  for (const order of ['first', 'after'] as const) {
    const session = `sess_${order}`;
    const at = Date.now() - 1_000;
    const aborted = await mf.dispatchFetch(`http://runtime/${order}?session=${session}&prompt=${promptIdAt(at)}`, { signal: AbortSignal.timeout(ABORT_MS) })
      .then(() => 'answered', (err: unknown) => (err instanceof Error ? err.name : 'error'));
    await Bun.sleep(STALL_MS + 1_000);
    const read = await (await mf.dispatchFetch(`http://runtime/read?session=${session}`)).json() as { at: unknown };
    record('workerd', order === 'first' ? 'stamp first' : 'stamp after', read.at, at, aborted);
  }
} finally {
  await mf.dispose();
}

// ---------- Bun ----------
const sqlite = new Database(':memory:');
sqlite.exec(SESSIONS);
const bun = serverEnvFromBunConfig({ sqlite, blobDir: fs.mkdtempSync(path.join(RUN, 'blobs-')) });
const server = Bun.serve({
  hostname: '127.0.0.1', port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const session = url.searchParams.get('session')!;
    sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id) VALUES ('proj_1', ?, 'machine_1')`, [session]);
    const routeCtx = { projectId: 'proj_1', machineId: 'machine_1', tokenId: 'tok', now: Date.now() } as never;
    const promptId = url.searchParams.get('prompt')!;
    if (url.pathname === '/first') noteTurnStarted(bun, routeCtx, session, promptId);
    await Bun.sleep(STALL_MS);
    if (url.pathname === '/after') noteTurnStarted(bun, routeCtx, session, promptId);
    return Response.json({ persisted: true });
  },
});
try {
  for (const order of ['first', 'after'] as const) {
    const session = `sess_bun_${order}`;
    const at = Date.now() - 1_000;
    const aborted = await fetch(`${server.url}${order}?session=${session}&prompt=${promptIdAt(at)}`, { signal: AbortSignal.timeout(ABORT_MS) })
      .then(() => 'answered', (err: unknown) => (err instanceof Error ? err.name : 'error'));
    await Bun.sleep(STALL_MS + 500);
    await bun.settle();
    const row = sqlite.query('SELECT working_since AS at FROM sessions WHERE session_id = ?').get(session) as { at: number | null } | null;
    record('bun', order === 'first' ? 'stamp first' : 'stamp after', row?.at ?? null, at, aborted);
  }
} finally {
  await server.stop(true);
}

fs.writeFileSync(EVIDENCE, `${JSON.stringify({ stallMs: STALL_MS, abortMs: ABORT_MS, results }, null, 2)}\n`);
console.log(`evidence: ${EVIDENCE}`);
const firstMissing = results.filter((r) => r.order === 'stamp first' && r.landed !== true);
for (const entryName of fs.readdirSync(RUN)) if (path.join(RUN, entryName) !== EVIDENCE) fs.rmSync(path.join(RUN, entryName), { recursive: true, force: true });
if (firstMissing.length > 0) {
  console.log(`FAIL: the stamp registered first did not land on ${firstMissing.map((r) => r.target).join(', ')}`);
  process.exit(1);
}
