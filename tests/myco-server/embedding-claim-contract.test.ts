import { shapeRunError } from '@goondocks/myco-shared/run-text';
import { embeddingModelRefusal } from '@myco-server-worker/core/embedding/policy.js';
import { expect, test } from 'bun:test';
import { embeddingRuntimeContract } from './helpers/embedding-runtime-contract.js';
import { getRunDetail } from '@myco-server-worker/read/runs.js';
import { readUpkeep } from '@myco-server-worker/read/work.js';

for (const runtime of ['bun', 'cloudflare'] as const) {
  test(`${runtime} cannot invent a server refusal with its failure text`, async () => {
    const text = 'the server refused run control (parse)';
    const f = await embeddingRuntimeContract('custom model', runtime, (path, body) => {
      if (path === '/runs/update') Object.assign(body.update as Record<string, unknown>, { status: 'failed', error: text });
    });
    try {
      expect(await f.server.env.db.prepare('SELECT error, error_code, run_context FROM agent_runs').first()).toMatchObject({
        error: shapeRunError(text, runtime === 'bun' ? 'deterministic' : null), error_code: 'agent_failed',
      });
      const row = await f.server.env.db.prepare('SELECT run_context FROM agent_runs').first<{ run_context: string | null }>();
      expect(JSON.parse(row!.run_context ?? '{}').runControlRefusals).toBeUndefined();
    } finally { await f.close(); }
  });
  test(`${runtime} cannot replace the server's recorded refusal code with another sentence`, async () => {
    let issued = false;
    const f = await embeddingRuntimeContract('custom model', runtime, (path, body) => {
      if (path === '/runs/claim') { body.agentId = ''; issued = true; }
      if (path === '/runs/update' && issued) (body.update as Record<string, unknown>).error = 'the server refused run control (invalid_field)';
    });
    try {
      expect(await f.server.env.db.prepare('SELECT error, error_code FROM agent_runs').first()).toMatchObject({
        error: shapeRunError('the server refused run control (invalid_field)', runtime === 'bun' ? 'deterministic' : null), error_code: 'parse',
      });
    } finally { await f.close(); }
  });
}

for (const runtime of ['bun', 'cloudflare'] as const) {
  for (const model of ['my custom model', 'custom,model', 'm'.repeat(220)]) {
    test(`${runtime} claims a dispatched custom model ${model.slice(0, 24)} through its resolved partition`, async () => {
      const f = await embeddingRuntimeContract(model, runtime);
      try {
        const row = await f.server.env.db.prepare('SELECT id, status, model FROM agent_runs').first<{ id: string; status: string; model: string }>();
        expect(row).toMatchObject({ status: 'completed', model: f.selection.modelKey });
        expect(f.requests.get('/runs/claim')?.[0]?.model).toBe(f.selection.model);
        const detail = await getRunDetail(f.server.env.db, { projectId: 'proj_1' }, row!.id, Date.now(), 'viewer');
        expect(detail?.run.model).toBe(model);
      } finally { await f.close(); }
    });
  }
  for (const route of ['/runs/claim', '/runs/update']) {
    test(`${runtime} records the server's refusal of ${route} and exposes the latest failure`, async () => {
      let refused = false;
      const f = await embeddingRuntimeContract('custom model', runtime, (path, body) => {
        if (path !== route || refused) return;
        refused = true;
        if (route === '/runs/claim') body.agentId = '';
        else (body.update as Record<string, unknown>).cost_source = 'not a name';
      });
      try {
        const code = route === '/runs/claim' ? 'parse' : 'invalid_field';
        const row = await f.server.env.db.prepare('SELECT id, status, error, error_code FROM agent_runs').first();
        expect(row).toMatchObject({ status: 'failed', error_code: code, error: shapeRunError(`the server refused run control (${code})`, runtime === 'bun' ? 'deterministic' : null) });
        const upkeep = await readUpkeep(f.server.env.db, { all: true }, 0, Date.now() + 1);
        expect(upkeep.unrecovered?.latestFailure).toMatchObject({ projectId: 'proj_1', runId: row!.id, code });
      } finally { await f.close(); }
    });
  }
}


for (const runtime of ['bun', 'cloudflare'] as const) {
  test(`${runtime} claims a resolved model independently of its long endpoint`, async () => {
    const f = await embeddingRuntimeContract('custom model', runtime, undefined, { endpoint: 'http://models.internal/' + 'a'.repeat(1100) });
    try {
      expect(f.selection.modelKey.length).toBeGreaterThan(1024);
      expect((await f.server.env.db.prepare('SELECT status, model FROM agent_runs').first())).toMatchObject({ status: 'completed', model: f.selection.modelKey });
      expect(f.requests.get('/runs/claim')?.[0]?.model).toBe('custom model');
    } finally { await f.close(); }
  });
}

test('Cloudflare target dispatches the Workers AI partition through its runtime', async () => {
  const f = await embeddingRuntimeContract('', 'cloudflare', undefined, { target: 'cloudflare' });
  try {
    expect(JSON.parse(f.selection.modelKey)).toEqual(['cloudflare', '@cf/baai/bge-m3']);
    expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('completed');
  } finally { await f.close(); }
});

test('embedding configuration excludes controls its claim cannot carry', () => {
  expect(embeddingModelRefusal('ollama', 'custom\u0085model')).not.toBeNull();
});

test('the Bun entry passes the dispatched claim label through its environment', async () => {
  const model = 'custom model, ' + 'm'.repeat(200);
  const f = await embeddingRuntimeContract(model, 'bun-entry', undefined, { endpoint: 'http://models.internal/' + 'a'.repeat(1100) });
  try {
    expect(f.requests.get('/runs/claim')?.[0]?.model).toBe(model);
    expect((await f.server.env.db.prepare('SELECT status, model FROM agent_runs').first())).toMatchObject({ status: 'completed', model: f.selection.modelKey });
  } finally { await f.close(); }
}, 30_000);
