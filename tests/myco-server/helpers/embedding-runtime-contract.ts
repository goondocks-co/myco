import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDeployment } from '@myco-server-worker/platform/bun/server-main.js';
import { cloudflareEmbeddingLaunch } from '@myco-server-worker/platform/cloudflare/embedding-runtime.js';
import { dispatchEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import { resolveEmbedding, EMBEDDING_MODEL_LEAF, EMBEDDING_PROVIDER_LEAF, EMBEDDING_ENDPOINT_LEAF } from '@myco-server-worker/core/embedding/policy.js';
import { runServerTask, CAPTURE_DRIVEN_ADMISSION } from '@myco/agent/runtime/server-runner.js';
import { ServerClient } from '@myco/member/transport.js';
import { sqliteEnv } from './fixtures.js';

/** Dispatch and execute a resolved embedding selection through the native HTTP server. */
export async function embeddingRuntimeContract(model: string, runtime: 'bun' | 'cloudflare' | 'bun-entry', alter?: (route: string, body: Record<string, unknown>) => void, options: { endpoint?: string; target?: 'bun' | 'cloudflare' } = {}) {
  const selection = resolveEmbedding(options.target === 'cloudflare' ? {} : { [EMBEDDING_PROVIDER_LEAF]: 'ollama', [EMBEDDING_MODEL_LEAF]: model, ...(options.endpoint === undefined ? {} : { [EMBEDDING_ENDPOINT_LEAF]: options.endpoint }) }, options.target ?? 'bun').selection;
  if (selection === null || options.target !== 'cloudflare' && selection.model !== model) throw new Error('custom embedding selection was not resolved');
  const source = sqliteEnv();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-run-contract-'));
  const databasePath = path.join(root, 'myco.sqlite');
  source.sqlite.run("INSERT INTO spores(project_id,id,agent_id,content,observation_type,created_at) VALUES ('proj_1','memory','user','A durable decision','decision',1)");
  source.sqlite.query('VACUUM INTO ?').run(databasePath);
  source.sqlite.close();
  const requests = new Map<string, Record<string, unknown>[]>();
  const work: Promise<unknown>[] = [];
  const proxies: ReturnType<typeof Bun.serve>[] = [];
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.set(route, [...requests.get(route) ?? [], structuredClone(body)]);
    alter?.(route, body);
    return fetch(input, { ...init, body: JSON.stringify(body) });
  };
  const server = await startDeployment({ databasePath, blobDir: path.join(root, 'blobs'), port: 0,
    sourceFrom: 'socket', transport: 'loopback', harnessTasks: ['embedding-reconcile'],
    harnessLaunchFor: (origin) => async (spec) => {
      if (runtime === 'bun-entry') {
        const proxy = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: async (request) => {
          const headers = new Headers(request.headers);
          headers.delete('host'); headers.delete('content-length');
          return fetcher(new URL(new URL(request.url).pathname, origin()).href,
            { method: request.method, headers, body: await request.text() });
        } });
        proxies.push(proxy);
        const child = Bun.spawn([process.execPath, fileURLToPath(new URL('../../../packages/myco/src/agent/runtime/server-entry.ts', import.meta.url))], {
          env: { ...process.env, ...spec.envVars, MYCO_SERVER_URL: proxy.url.origin, MYCO_RUNTIME_PORT: 'none' }, stdout: 'pipe', stderr: 'pipe',
        });
        work.push((async () => {
          const timeout = setTimeout(() => child.kill('SIGKILL'), 30_000);
          try {
            const [exit] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
            if (exit !== 0) throw new Error(`embedding entry exited ${exit}`);
          } finally { clearTimeout(timeout); }
        })());
      } else if (runtime === 'cloudflare') {
        await cloudflareEmbeddingLaunch(origin(), (pending) => work.push(pending), { fetcher: (input, init) => fetcher(input, init) })(spec);
      } else {
        const client = new ServerClient({ serverUrl: origin(), token: spec.envVars.MYCO_MEMBER_TOKEN!, projectId: spec.envVars.MYCO_PROJECT! }, fetcher as typeof fetch);
        work.push(runServerTask({ client, budget: { connectTimeoutMs: 1000, requestTimeoutMs: 5000 },
          runId: spec.runId, taskName: spec.envVars.MYCO_TASK!, model: spec.envVars.MYCO_MODEL, claimModel: spec.envVars.MYCO_CLAIM_MODEL,
          admission: CAPTURE_DRIVEN_ADMISSION, timeoutSeconds: spec.timeoutSeconds }));
      }
    },
  });
  server.env.origin = `http://127.0.0.1:${server.port}`;
  server.env.embeddingProvider = async () => ({ modelKey: selection.modelKey, embed: async () => [1, 0] });
  try {
    if (await dispatchEmbeddingWork(server.env, Date.now()) !== 1) throw new Error('embedding work was not dispatched');
    await Promise.all(work);
    return { server, selection, requests, close: async () => { await server.stop(); for (const proxy of proxies) proxy.stop(true); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { await server.stop(); for (const proxy of proxies) proxy.stop(true); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
