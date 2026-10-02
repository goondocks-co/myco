import { expect } from 'bun:test';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { lit, memberHeadersFor, type ParityScenario, type ParityTarget } from '../harness.ts';
import { switchVector } from '../embedding-switch/vectors.ts';

const AGENT_ID = 'embedding-switch';
/** Runs, each with its own credential, the embedding steps rotate across. */
const HOLDERS = 2;
/** Steps past which a switch over three sources is taken as stuck. */
const MAX_STEPS = 40;

/** Each target's starting model and the model of another size it switches to. */
const MODELS = {
  selfhosted: { from: 'model-a', to: 'model-b', dimensions: { 'model-a': 8, 'model-b': 16 } as Record<string, number> },
  cloudflare: { from: '@cf/baai/bge-m3', to: '@cf/baai/bge-base-en-v1.5', dimensions: {} as Record<string, number> },
} as const;

/** A loopback OpenAI-compatible embedding server answering each model with a vector of its own size. */
function startStub(dimensions: Record<string, number>): { url: string; stop(): void } {
  const server = Bun.serve({
    port: 0, hostname: '127.0.0.1',
    async fetch(request) {
      const body = await request.json() as { model: string; input: string[] };
      const size = dimensions[body.model];
      if (size === undefined) return new Response('unknown model', { status: 404 });
      return Response.json({ data: [{ embedding: switchVector(body.input[0]!, size) }] });
    },
  });
  return { url: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/**
 * Switch embedding model on each front door: with search built under one model, a confirmed switch to a model
 * of another size builds the new vectors through the shipped `/runs/embedding-step` while search answers by meaning
 * between every two steps, and the embedding settings move to the new model only once every source holds a vector
 * under it.
 */
export const embeddingSwitch: ParityScenario = {
  name: 'embedding switch: search answers by meaning at every step and moves only once the new model covers every source',
  dedicated: { cloudflare: { main: '../../tests/parity/embedding-switch/worker-entry.ts' }, sqliteVec: true, timeoutMs: 120_000 },
  async run(target: ParityTarget) {
    const now = Date.now();
    const projectId = target.projectId;
    const models = MODELS[target.name];
    const owner = async (route: string, method: string, body?: unknown) => fetch(`${target.url}${route}`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const stub = target.name === 'selfhosted' ? startStub(models.dimensions) : null;
    try {
      await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (${lit(projectId)}, 'Embedding switch', ${now})`);
      await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES (${lit(AGENT_ID)}, ${lit(AGENT_ID)}, 'built-in', 1, ${now})`);
      for (const [id, content] of [['one', 'an architecture decision'], ['two', 'architecture of the store'], ['three', 'an unrelated observation']]) {
        await target.sql(`INSERT INTO spores (project_id, id, agent_id, content, observation_type, created_at) VALUES (${lit(projectId)}, ${lit(`switch-${id}-${now}`)}, ${lit(AGENT_ID)}, ${lit(content)}, 'decision', ${now})`);
      }
      const start = stub === null ? { provider: 'workers-ai', model: models.from } : { provider: 'openai-compatible', model: models.from, endpoint: stub.url };
      const to = stub === null ? { provider: 'workers-ai', model: models.to } : { provider: 'openai-compatible', model: models.to, endpoint: stub.url };
      expect((await owner('/api/embedding', 'PUT', start)).status).toBe(200);

      await target.sql(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_harness', 'harness', ${now})`);
      const holders: Array<{ token: string; runId: string }> = [];
      for (let i = 0; i < HOLDERS; i++) {
        const token = `embedding-switch-${target.name}-${i}-${now}`.padEnd(43, 'x');
        const tokenId = `mt_switch_${i}_${now}`;
        const runId = `embedding_switch_${i}_${now}`;
        await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, bytes_written, lineage_root, lineage_started_at)
          VALUES (${lit(tokenId)}, 'mem_harness', 'harness', ${lit(await sha256Hex(token))}, ${now}, ${now + 3_600_000}, 0, ${lit(tokenId)}, ${now})`);
        await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, dispatched_by, lease_expires_at, run_context)
          VALUES (${lit(projectId)}, ${lit(runId)}, ${lit(AGENT_ID)}, 'embedding-reconcile', 'running', ${now}, ${lit(tokenId)}, ${now + 3_600_000}, ${lit(JSON.stringify({ timeoutSeconds: 3_600 }))})`);
        holders.push({ token, runId });
      }
      let steps = 0;
      const step = async () => {
        const { token, runId } = holders[steps++ % HOLDERS]!;
        const res = await fetch(`${target.url}/runs/embedding-step`, { method: 'POST', headers: memberHeadersFor(token, projectId, { 'content-type': 'application/json' }), body: JSON.stringify({ runId }) });
        expect(`embedding step: ${res.status}`).toBe('embedding step: 200');
        const answer = await res.json() as { held?: boolean; phase?: string; provider_unavailable?: boolean };
        if (answer.held !== true || answer.provider_unavailable === true) throw new Error(`the embedding step refused the run: ${JSON.stringify(answer)}`);
        return answer.phase;
      };
      const meaning = async () => {
        const res = await fetch(`${target.url}/api/projects/${projectId}/search?${new URLSearchParams({ q: 'architecture', mode: 'semantic', limit: '10' })}`, { headers: target.ownerHeaders() });
        const answer = await res.json() as { provider_unavailable: boolean; results: Array<{ id: string }> };
        return { unavailable: answer.provider_unavailable, ids: answer.results.map((r) => r.id.replace(/^switch-|-\d+$/g, '')).sort() };
      };
      const storedModel = async () => JSON.parse(String((await target.sql(`SELECT value FROM deployment_settings WHERE leaf = 'embedding.model'`))[0]?.value ?? 'null')) as string | null;

      for (let i = 0; i < MAX_STEPS && await step() !== 'settled'; i++);
      expect(await meaning()).toEqual({ unavailable: false, ids: ['one', 'two'] });

      expect((await owner('/api/embedding/switch', 'POST', to)).status).toBe(400);
      const started = await owner('/api/embedding/switch', 'POST', { ...to, confirm: true });
      expect(`start: ${started.status}`).toBe('start: 200');
      let moved = false;
      for (let i = 0; i < MAX_STEPS && !moved; i++) {
        expect(await meaning()).toEqual({ unavailable: false, ids: ['one', 'two'] });
        const sw = (await (await owner('/api/embedding/switch', 'GET')).json() as { switch: { done: number; total: number } | null }).switch;
        if (sw === null) { moved = true; break; }
        expect({ model: await storedModel(), total: sw.total }).toEqual({ model: models.from, total: 3 });
        await step();
      }
      expect(moved).toBe(true);
      expect(await storedModel()).toBe(models.to);
      expect(await meaning()).toEqual({ unavailable: false, ids: ['one', 'two'] });
      const built = await target.sql(`SELECT model_key, COUNT(*) AS n FROM embedding_receipts WHERE project_id = ${lit(projectId)} AND ready = 1 GROUP BY model_key ORDER BY model_key`);
      expect(built.some((row) => String(row.model_key).includes(models.to) && row.n === 3)).toBe(true);
    } finally {
      stub?.stop();
    }
  },
};
