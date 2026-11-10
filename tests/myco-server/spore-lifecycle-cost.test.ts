/**
 * A consolidation costs what its sources cost, whatever the Project holds: rows read and rows written are measured on D1 at two corpus sizes, and the
 * larger corpus reads and writes the same as the smaller.
 */
import { afterAll, beforeAll, expect, it } from 'bun:test';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { consolidateSpores } from '@myco-server-worker/db/spores/lifecycle.js';
import { measuredStore } from './helpers/read-budget.js';
import { schemaD1Root } from './helpers/schema-template.js';

const SMALL = 200;
const LARGE = 5_000;
let mf: Miniflare;
let measured: ReturnType<typeof measuredStore>;

beforeAll(async () => {
  mf = new Miniflare(convertV4MiniflareOptions({ modules: true, script: 'export default { fetch() { return new Response(null); } }', compatibilityDate: '2026-07-01', d1Databases: ['DB'], resourcePersistencePath: await schemaD1Root() }));
  const d1 = await mf.getD1Database('DB');
  await d1.prepare("INSERT INTO projects (project_id, name, created_at) VALUES ('small', 's', 1), ('large', 'l', 1)").run();
  await d1.prepare("INSERT INTO agents (id, name, source, enabled, created_at) VALUES ('a', 'a', 'built-in', 1, 0)").run();
  const seed = (project: string, size: number) => d1.prepare(`WITH RECURSIVE k(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM k WHERE i < ${size - 1})
    INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, created_at) SELECT '${project}', printf('s%06d', i), 'a', 'decision', 'active', 'body', i FROM k`).run();
  await seed('small', SMALL);
  await seed('large', LARGE);
  measured = measuredStore(d1);
}, 120_000);
afterAll(async () => { await mf.dispose(); });

const wisdom = (id: string) => ({ id, agentId: 'a', sessionId: null, observationType: 'wisdom', content: 'merged', context: null, filePath: null, tags: null, contentHash: null, properties: null, author: null, createdAt: 10 });
const event = { agentId: 'a', reason: 'merged', sessionId: null, author: null, createdAt: 10 };

async function cost(project: string) {
  measured.reset();
  const outcome = await consolidateSpores(measured.db, { projectId: project }, { wisdom: wisdom(`${project}-w`), sources: [{ id: 's000001', revision: 0 }, { id: 's000002', revision: 0 }, { id: 's000003', revision: 0 }], event, now: 20 });
  expect(outcome.consolidated).toBe(3);
  return { reads: measured.reads(), writes: measured.writes() };
}

it('reads and writes the same at any corpus size', async () => {
  const small = await cost('small');
  const large = await cost('large');
  expect(large.reads).toBe(small.reads);
  expect(large.writes).toBe(small.writes);
}, 120_000);
