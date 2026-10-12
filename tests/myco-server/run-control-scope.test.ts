import { expect, test } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ROUTES, RETIRED_ROUTES } from '@myco-server-worker/routes.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { IN_PROCESS_SCOPE } from '@myco-server-worker/api/run-admission.js';
import { cloudflareVectorStore } from '@myco-server-worker/platform/cloudflare/vectors.js';
import { indexFixture } from './helpers/vector-index.js';
import { sqliteEnv, memberPost } from './helpers/fixtures.js';

const CHANNEL = ['/runs/claim', '/runs/embedding-step', '/runs/report', '/runs/update'];
const RETIRED = ['get', 'failed', 'resume-admission', 'supersede', 'reports', 'events', 'repository', 'canopy-map',
  'cortex-instructions', 'instruction', 'digest', 'digest-write'].map(name => `/runs/${name}`);

async function fixture(task: string) {
  const f = sqliteEnv();
  const now = Date.now();
  await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
  const token = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
  f.sqlite.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
  await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'run', agentId: 'myco-agent', task,
    provider: 'embedding', model: 'fixture-model', runContext: '{"timeoutSeconds":300}',
    startedAt: now, dispatchedBy: token.tokenId });
  return { ...f, token, now };
}

test('only the four in-process run routes have live declarations', () => {
  expect(ROUTES.filter(route => route.path.startsWith('/runs/')).map(route => route.path).sort()).toEqual(CHANNEL.toSorted());
  for (const path of RETIRED) {
    const route = RETIRED_ROUTES.find(route => route.path === path);
    expect(route).toBeDefined();
    expect(route).not.toHaveProperty('authorization');
  }
});

for (const task of ['extract-curate', 'canopy-map', 'title-summary', 'vault-seed']) {
  test(`a worker credential for ${task} is refused on every in-process route`, async () => {
    const f = await fixture(task);
    try {
      for (const path of CHANNEL) {
        const response = await worker.fetch(memberPost(f.token.token, { id: 'run', runId: 'run' }, path), f.env);
        expect(await response.json()).toMatchObject({ persisted: false, code: 'run_scope', reason: IN_PROCESS_SCOPE });
      }
      expect(f.sqlite.query("SELECT status FROM agent_runs WHERE id='run'").get()).toEqual({ status: 'pending' });
    } finally { f.sqlite.close(); }
  });
}

test('a mixed credential cannot borrow an embedding run to reach the channel', async () => {
  const f = await fixture('embedding-reconcile');
  try {
    await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'worker', agentId: 'myco-agent', task: 'extract-curate',
      provider: null, model: null, runContext: '{}', startedAt: f.now, dispatchedBy: f.token.tokenId });
    const response = await worker.fetch(memberPost(f.token.token, { id: 'run', runId: 'run' }, '/runs/claim'), f.env);
    expect(await response.json()).toMatchObject({ persisted: false, code: 'run_scope' });
  } finally { f.sqlite.close(); }
});

test('retired run routes answer as absent to anonymous and authenticated callers', async () => {
  const f = await fixture('embedding-reconcile');
  try {
    for (const path of RETIRED) for (const token of [null, f.token.token]) {
      const request = token === null ? new Request(`https://s${path}`, { method: 'POST', headers: { 'cf-connecting-ip': '1.2.3.4' }, body: '{}' })
        : memberPost(token, {}, path);
      expect((await worker.fetch(request, f.env)).status).toBe(401);
    }
  } finally { f.sqlite.close(); }
});

test('an embedding credential claims its own dispatch', async () => {
  const f = await fixture('embedding-reconcile');
  try {
    const { createServer } = await import('@myco-server-worker/pipeline.js');
    const pipeline = createServer({ now: () => f.now, sourceOf: () => '127.0.0.1', fetchImpl: fetch });
    const env = { ...f.serverEnv, vectors: cloudflareVectorStore(indexFixture()),
      embeddingProvider: async () => ({ modelKey: 'fixture-model', embed: async () => [1, 0] }) };
    const response = await pipeline.handleRequest(memberPost(f.token.token, { id: 'run', agentId: 'myco-agent', task: 'embedding-reconcile',
      captureDriven: true, harness: null, provider: 'embedding', model: 'fixture-model', runContext: '{}' }, '/runs/claim'), env);
    expect(await response.json()).toMatchObject({ persisted: true, claimed: true });
  } finally { f.sqlite.close(); }
});
