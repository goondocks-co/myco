import { expect } from 'bun:test';
import { type ParityScenario, type ParityTarget } from '../harness.ts';
import { switchVector } from '../embedding-switch/vectors.ts';
import { revisionHeaders } from '../settings-revision.ts';

import { saveSpore } from '../clients/knowledge.ts';
import { owner as readOwner } from '../clients/requests.ts';
import { embeddingPass, embeddingSettings } from '../embedding/runtime.ts';
/** Runtime passes past which a switch over three sources is taken as stuck. */
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
 * of another size builds the new vectors through the dispatched embedding runtime while search answers by meaning
 * between runtime passes, and the embedding settings move to the new model only once every source holds a vector
 * under it.
 */
export const embeddingSwitch: ParityScenario = {
  name: 'embedding switch: search answers by meaning between runtime passes and changes model once the switch finishes',
  dedicated: { cloudflare: { main: '../../tests/parity/embedding-switch/worker-entry.ts' }, selfhosted: { embeddingRuntime: true }, sqliteVec: true, timeoutMs: 120_000 },
  async run(target: ParityTarget) {
    const projectId = target.projectId;
    const models = MODELS[target.name];
    const owner = async (route: string, method: string, body?: unknown) => fetch(`${target.url}${route}`, {
      method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json', ...(route === '/api/embedding' && method === 'PUT' ? await revisionHeaders(target, route) : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const stub = target.name === 'selfhosted' ? startStub(models.dimensions) : null;
    try {
      await embeddingSettings(target);
      const ids = [];
      for (const content of ['an architecture decision', 'architecture of the store', 'an unrelated observation']) ids.push((await saveSpore(target, content, projectId, 'decision')).id);
      const start = stub === null ? { provider: 'workers-ai', model: models.from } : { provider: 'openai-compatible', model: models.from, endpoint: stub.url };
      const to = stub === null ? { provider: 'workers-ai', model: models.to } : { provider: 'openai-compatible', model: models.to, endpoint: stub.url };
      expect((await owner('/api/embedding', 'PUT', start)).status).toBe(200);

      const step = () => embeddingPass(target);
      const meaning = async () => {
        const res = await fetch(`${target.url}/api/projects/${projectId}/search?${new URLSearchParams({ q: 'architecture', mode: 'semantic', limit: '10' })}`, { headers: target.ownerHeaders() });
        const answer = await res.json() as { provider_unavailable: boolean; hits: Array<{ id: string }> };
        return { unavailable: answer.provider_unavailable, ids: answer.hits.map((r) => r.id).sort() };
      };
      const storedModel = async () => (await readOwner(target, '/api/settings')).body.leaves.find((row: any) => row.leaf === 'embedding.model').value;

      for (let i = 0; i < MAX_STEPS && await step() !== 'settled'; i++);
      expect(await meaning()).toEqual({ unavailable: false, ids: ids.slice(0, 2).sort() });

      expect((await owner('/api/embedding/switch', 'POST', to)).status).toBe(400);
      const started = await owner('/api/embedding/switch', 'POST', { ...to, confirm: true });
      expect(`start: ${started.status}`).toBe('start: 200');
      let moved = false;
      for (let i = 0; i < MAX_STEPS && !moved; i++) {
        expect(await meaning()).toEqual({ unavailable: false, ids: ids.slice(0, 2).sort() });
        const sw = (await (await owner('/api/embedding/switch', 'GET')).json() as { switch: { done: number; total: number } | null }).switch;
        if (sw === null) { moved = true; break; }
        expect({ model: await storedModel(), total: sw.total }).toEqual({ model: models.from, total: 3 });
        await step();
      }
      expect(moved).toBe(true);
      expect(await storedModel()).toBe(models.to);
      expect(await meaning()).toEqual({ unavailable: false, ids: ids.slice(0, 2).sort() });
    } finally {
      stub?.stop();
    }
  },
};
