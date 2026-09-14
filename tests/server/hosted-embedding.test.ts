import { expect, spyOn, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDeployment } from '@myco-server-worker/platform/bun/server-main.js';
import { cloudflareEmbeddingLaunch, type HostedRunLifetime } from '@myco-server-worker/platform/cloudflare/embedding-runtime.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { dispatchEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import { dispatchPrepared, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { resolveSemanticSearch } from '@myco-server-worker/core/search.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { runControlClient } from '@goondocks/myco-shared/run-control';

async function fixture(timeoutSeconds?: number, lifetime: HostedRunLifetime = 'response') {
  const source = sqliteEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-hosted-embedding-'));
  const databasePath = path.join(home, 'myco.sqlite');
  source.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1','memory','user','A durable architecture decision','decision',1)");
  source.sqlite.query('VACUUM INTO ?').run(databasePath);
  source.sqlite.close();
  const work: Promise<void>[] = [];
  const server = await startDeployment({ databasePath, blobDir: path.join(home, 'blobs'), port: 0,
    sourceFrom: 'socket', transport: 'loopback', harnessTasks: ['embedding-reconcile'],
    harnessLaunchFor: (origin) => (spec) => cloudflareEmbeddingLaunch(origin(), (pending) => { work.push(pending); }, { lifetime })({
      ...spec, ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    }),
  });
  server.env.origin = `http://127.0.0.1:${server.port}`;
  server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => [1, 0] });
  const settle = async () => { await Promise.all(work); };
  return { server, work, settle,
    close: async () => { await settle(); await server.stop(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test('hosted launch executes automatic and manual embedding through authenticated control and preserves project isolation', async () => {
  const f = await fixture();
  try {
    expect(await dispatchEmbeddingWork(f.server.env, Date.now())).toBe(1);
    await f.settle();
    const search = await searchProject(f.server.env.db, { projectId: 'proj_1' }, { query: 'architecture', mode: 'semantic' }, () => resolveSemanticSearch(f.server.env));
    expect(search.results.map((row) => row.id)).toEqual(['memory']);
    expect((await searchProject(f.server.env.db, { projectId: 'proj_2' }, { query: 'architecture', mode: 'semantic' }, () => resolveSemanticSearch(f.server.env))).results).toEqual([]);
    const prepared = await prepareDispatch(f.server.env, 'embedding-reconcile', 'proj_1');
    if (!prepared.ok) throw new Error(prepared.refusal);
    await dispatchPrepared(f.server.env, prepared.prepared, { serverUrl: f.server.env.origin!, actor: 'owner' }, Date.now());
    await f.settle();
    expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').all()).results).toEqual([{ status: 'completed' }, { status: 'completed' }]);
    expect((await f.server.env.db.prepare('SELECT summary FROM agent_reports ORDER BY id').all()).results.map((row) => row.summary))
      .toEqual(['Processed 1 embedding records; missing.', 'Processed 0 embedding records; settled.']);
  } finally { await f.close(); }
});

test('hosted provider failure persists a failed run and permits a subsequent automatic retry', async () => {
  const f = await fixture();
  try {
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => { throw new Error('provider unavailable'); } });
    expect(await dispatchEmbeddingWork(f.server.env, Date.now())).toBe(1);
    await f.settle();
    expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('failed');
    expect((await f.server.env.db.prepare('SELECT ready FROM embedding_receipts').first())?.ready).toBe(0);
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => [1, 0] });
    expect(await dispatchEmbeddingWork(f.server.env, Date.now() + 60_000)).toBe(1);
    await f.settle();
    expect((await f.server.env.db.prepare('SELECT ready FROM embedding_receipts').first())?.ready).toBe(1);
    expect((await f.server.env.db.prepare("SELECT COUNT(*) AS n FROM agent_runs WHERE status='completed'").first())?.n).toBe(1);
  } finally { await f.close(); }
});

test('hosted response work yields before starting another step without a full request window', async () => {
  const f = await fixture();
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    await f.server.env.db.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1','next-memory','user','Another durable decision','decision',1)").run();
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => { now += 9_000; return [1, 0]; } });
    expect(await dispatchEmbeddingWork(f.server.env, now)).toBe(1);
    await f.settle();
    expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('completed');
    expect((await f.server.env.db.prepare('SELECT summary FROM agent_reports').first())?.summary).toBe('Processed 1 embedding records; missing.');
    expect((await f.server.env.db.prepare('SELECT COUNT(*) AS n FROM embedding_receipts WHERE ready=1').first())?.n).toBe(1);
  } finally { clock.mockRestore(); await f.close(); }
});

test('clock-owned hosted work uses its awaited lifetime to finish a batch beyond the response budget', async () => {
  const f = await fixture(undefined, 'clock');
  let now = Date.now();
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    for (const id of ['next-memory', 'last-memory']) {
      await f.server.env.db.prepare("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1',?,'user','Another durable decision','decision',1)").bind(id).run();
    }
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => { now += 9_000; return [1, 0]; } });
    expect(await dispatchEmbeddingWork(f.server.env, now)).toBe(1);
    await f.settle();
    expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('completed');
    expect((await f.server.env.db.prepare('SELECT summary FROM agent_reports').first())?.summary).toEndWith('; settled.');
    expect((await f.server.env.db.prepare('SELECT COUNT(*) AS n FROM embedding_receipts WHERE ready=1').first())?.n).toBe(3);
  } finally { clock.mockRestore(); await f.close(); }
});

test('hosted work deadline leaves time to persist failure while a provider response remains held', async () => {
  const f = await fixture(6);
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  try {
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => {
      entered.resolve(); await released.promise; return [1, 0];
    } });
    expect(await dispatchEmbeddingWork(f.server.env, Date.now())).toBe(1);
    await entered.promise;
    await f.settle();
    expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('failed');
    expect((await f.server.env.db.prepare('SELECT ready FROM embedding_receipts').first())?.ready).toBe(0);
  } finally { released.resolve(); await f.close(); }
});

test('hosted execution binds only when the invocation owns its lifetime and an origin is configured', async () => {
  const f = sqliteEnv();
  try {
    const bindings = { ...f.env, MYCO_ORIGIN: 'https://myco.example' };
    expect((await prepareDispatch(serverEnvFromBindings(bindings), 'embedding-reconcile', 'proj_1')).ok).toBe(false);
    const env = serverEnvFromBindings(bindings, { waitUntil: () => {} });
    expect(env.harnessTasks).toEqual(['embedding-reconcile']);
    expect(await prepareDispatch(env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'harness_unavailable' });
    expect(env.platform?.capabilities().find((row) => row.capability === 'harness-runtime')?.present).toBe(true);
  } finally { f.sqlite.close(); }
});

test('run control rejects redirects without sending the run credential to the destination', async () => {
  let forwarded = 0;
  const destination = Bun.serve({ port: 0, fetch: () => { forwarded++; return Response.json({ persisted: true }); } });
  const redirect = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 307, headers: { location: destination.url.href } }) });
  try {
    const control = runControlClient({ origin: redirect.url.href, token: 'synthetic-run-token', projectId: 'proj_1' }, fetch);
    await expect(control(destination.url.href, {}, AbortSignal.timeout(1000))).rejects.toThrow('cross-origin route refused');
    await expect(control('/runs/claim', {}, AbortSignal.timeout(1000))).rejects.toThrow('status 307');
    expect(forwarded).toBe(0);
  } finally { await redirect.stop(true); await destination.stop(true); }
});
