import { expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LocalEmbeddingRuntime } from '@myco/server/local-embedding.js';
import { startDeployment } from '@myco-server-worker/platform/bun/server-main.js';
import { prepareDispatch, dispatchPrepared } from '@myco-server-worker/core/harness.js';
import { dispatchEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import { searchProject } from '@myco-server-worker/read/search.js';
import { resolveSemanticSearch } from '@myco-server-worker/core/search.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';

async function fixture() {
  const source = sqliteEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-embedding-'));
  const databasePath = path.join(home, 'myco.sqlite');
  source.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1','memory','user','A durable architecture decision','decision',1)");
  source.sqlite.query('VACUUM INTO ?').run(databasePath);
  source.sqlite.close();
  const failures: string[] = [];
  const runtime = new LocalEmbeddingRuntime((message) => { failures.push(message); });
  const server = await startDeployment({ databasePath, blobDir: path.join(home, 'blobs'), port: 0,
    sourceFrom: 'socket', transport: 'loopback', harnessTasks: runtime.tasks,
    harnessLaunchFor: (origin) => runtime.launchFor(origin),
    beforeStop: () => runtime.stop(),
  });
  server.env.origin = `http://127.0.0.1:${server.port}`;
  server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => [1, 0] });
  const waitForRun = async () => {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const row = await server.env.db.prepare('SELECT id,status FROM agent_runs ORDER BY started_at DESC LIMIT 1').first<{ id: string; status: string }>();
      if (row?.status === 'completed' || row?.status === 'failed') return row;
      await Bun.sleep(20);
    }
    throw new Error('native embedding did not settle');
  };
  return { server, runtime, failures, waitForRun,
    close: async () => { await server.stop(); fs.rmSync(home, { recursive: true, force: true }); },
  };
}

test('native runtime indexes clock-dispatched work and serves semantic results with a persisted report', async () => {
  const f = await fixture();
  try {
    expect(await prepareDispatch(f.server.env, 'container-smoke', 'proj_1')).toEqual({ ok: false, refusal: 'harness_unavailable' });
    expect(await dispatchEmbeddingWork(f.server.env, Date.now())).toBe(1);
    const run = await f.waitForRun();
    expect(run.status).toBe('completed');
    const reports = await f.server.env.db.prepare('SELECT summary FROM agent_reports WHERE run_id=?').bind(run.id).all<{ summary: string }>();
    expect(reports.results).toHaveLength(1);
    expect(reports.results[0]!.summary).toContain('Processed 1 embedding records');
    const search = await searchProject(f.server.env.db, { projectId: 'proj_1' }, { query: 'architecture', mode: 'semantic' }, () => resolveSemanticSearch(f.server.env));
    expect(search.results.map((row) => row.id)).toEqual(['memory']);
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
});

test('native provider failure closes the actual dispatched run as failed', async () => {
  const f = await fixture();
  try {
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => { throw new Error('fixture provider offline'); } });
    const prepared = await prepareDispatch(f.server.env, 'embedding-reconcile', 'proj_1');
    if (!prepared.ok) throw new Error(prepared.refusal);
    await dispatchPrepared(f.server.env, prepared.prepared, { serverUrl: f.server.env.origin!, actor: 'owner' }, Date.now());
    expect((await f.waitForRun()).status).toBe('failed');
    const receipt = await f.server.env.db.prepare('SELECT 1 FROM embedding_receipts WHERE ready=1').first();
    expect(receipt).toBeNull();
  } finally { await f.close(); }
});

test('native dry runs preserve index contents and retain the declared dry-run state', async () => {
  const f = await fixture();
  try {
    let embedded = 0;
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => { embedded++; return [1, 0]; } });
    const prepared = await prepareDispatch(f.server.env, 'embedding-reconcile', 'proj_1');
    if (!prepared.ok) throw new Error(prepared.refusal);
    await dispatchPrepared(f.server.env, prepared.prepared, {
      serverUrl: f.server.env.origin!, actor: 'owner', options: { dryRun: true },
    }, Date.now());
    const run = await f.waitForRun();
    expect(run.status).toBe('completed');
    expect(embedded).toBe(0);
    expect(await f.server.env.db.prepare('SELECT dry_run FROM agent_runs WHERE id=?').bind(run.id).first<{ dry_run: number }>()).toEqual({ dry_run: 1 });
  } finally { await f.close(); }
});

test('native shutdown cancels the active request and persists its failed ending before drain completes', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const released = Promise.withResolvers<void>();
  try {
    f.server.env.embeddingProvider = async () => ({ modelKey: 'fixture-model', embed: async () => {
      entered.resolve(); await released.promise; return [1, 0];
    } });
    expect(await dispatchEmbeddingWork(f.server.env, Date.now())).toBe(1);
    await entered.promise;
    await f.runtime.stop();
    expect((await f.waitForRun()).status).toBe('failed');
    expect(f.failures).toHaveLength(1);
  } finally { released.resolve(); await f.close(); }
});

test('a process signal runs attached-runtime shutdown while run control is still listening', async () => {
  const source = sqliteEnv();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-native-signal-'));
  const databasePath = path.join(home, 'myco.sqlite');
  source.sqlite.query('VACUUM INTO ?').run(databasePath);
  source.sqlite.close();
  const repo = fileURLToPath(new URL('../../', import.meta.url));
  const receipt = path.join(home, 'shutdown.json');
  const script = `
    import { startDeployment } from ${JSON.stringify(path.join(repo, 'packages/myco-server/src/platform/bun/server-main.ts'))};
    let server;
    server = await startDeployment({ databasePath: ${JSON.stringify(databasePath)}, blobDir: ${JSON.stringify(path.join(home, 'blobs'))},
      port: 0, sourceFrom: 'socket', transport: 'loopback', beforeStop: async () => {
        const response = await fetch('http://127.0.0.1:' + server.port + '/health');
        await Bun.write(${JSON.stringify(receipt)}, JSON.stringify({status: response.status}));
      }
    });
    console.log('READY');
  `;
  const child = Bun.spawn([process.execPath, '--no-env-file', '--tsconfig-override', path.join(repo, 'tsconfig.json'), '-e', script],
    { cwd: home, env: { ...process.env, MYCO_HOME: home }, stdout: 'pipe', stderr: 'pipe' });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 10_000);
  const reader = child.stdout.getReader();
  try {
    let output = '';
    while (!output.includes('READY\n')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error('signal fixture exited before binding');
      output += new TextDecoder().decode(chunk.value);
    }
    child.kill('SIGTERM');
    expect(await child.exited).toBe(0);
    expect(JSON.parse(fs.readFileSync(receipt, 'utf8'))).toEqual({ status: 200 });
  } finally { clearTimeout(timeout); reader.releaseLock(); child.kill(); fs.rmSync(home, { recursive: true, force: true }); }
});
