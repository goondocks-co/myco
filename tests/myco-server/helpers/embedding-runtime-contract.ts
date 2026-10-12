import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startDeployment } from '@myco-server-worker/platform/bun/server-main.js';
import { cloudflareEmbeddingLaunch } from '@myco-server-worker/platform/cloudflare/embedding-runtime.js';
import { dispatchEmbeddingWork } from '@myco-server-worker/core/embedding/jobs.js';
import { resolveEmbedding, EMBEDDING_MODEL_LEAF, EMBEDDING_PROVIDER_LEAF, EMBEDDING_ENDPOINT_LEAF } from '@myco-server-worker/core/embedding/policy.js';
import { EmbeddingRuntime } from '@myco-server-worker/platform/bun/embedding-runtime.js';
import { sqliteEnv } from './fixtures.js';

/** Dispatch and execute a resolved embedding selection through the native HTTP server. */
export async function embeddingRuntimeContract(model: string, runtime: 'bun' | 'cloudflare', alter?: (route: string, body: Record<string, unknown>) => void, options: { endpoint?: string; target?: 'bun' | 'cloudflare' } = {}) {
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
  const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
    const route = new URL(String(input)).pathname;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    requests.set(route, [...requests.get(route) ?? [], structuredClone(body)]);
    alter?.(route, body);
    return fetch(input, { ...init, body: JSON.stringify(body) });
  };
  const native = new EmbeddingRuntime(() => {}, fetcher);
  const server = await startDeployment({ databasePath, blobDir: path.join(root, 'blobs'), port: 0,
    sourceFrom: 'socket', transport: 'loopback', harnessTasks: ['embedding-reconcile'],
    harnessLaunchFor: (origin) => async (spec) => {
      if (runtime === 'cloudflare') {
        await cloudflareEmbeddingLaunch(origin(), (pending) => work.push(pending), { fetcher: (input, init) => fetcher(input, init) })(spec);
      } else {
        await native.launchFor(origin)(spec);
        work.push(native.waitForIdle());
      }
    },
  });
  server.env.origin = `http://127.0.0.1:${server.port}`;
  server.env.embeddingProvider = async () => ({ modelKey: selection.modelKey, embed: async () => [1, 0] });
  try {
    if (await dispatchEmbeddingWork(server.env, Date.now()) !== 1) throw new Error('embedding work was not dispatched');
    await Promise.all(work);
    return { server, selection, requests, close: async () => { await server.stop(); await native.stop(); fs.rmSync(root, { recursive: true, force: true }); } };
  } catch (error) { await server.stop(); await native.stop(); fs.rmSync(root, { recursive: true, force: true }); throw error; }
}
