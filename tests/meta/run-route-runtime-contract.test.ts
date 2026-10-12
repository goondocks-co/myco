import { RUN_REQUEST_FIELDS, RUN_UPDATE_FIELDS } from '@myco-server-worker/api/run-fields.js';
import { expect, test } from 'bun:test';
import { ROUTES } from '@myco-server-worker/routes.js';
import { embeddingRuntimeContract } from '../myco-server/helpers/embedding-runtime-contract.js';

test('both in-process executors send requests admitted by all four run-route validators', async () => {
  const exercised = new Set<string>();
  for (const runtime of ['bun', 'cloudflare'] as const) {
    const f = await embeddingRuntimeContract('custom model, ' + 'm'.repeat(200), runtime, undefined,
      runtime === 'cloudflare' ? { target: 'cloudflare' } : {});
    try {
      expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('completed');
      for (const [path, bodies] of f.requests) {
        exercised.add(path);
        for (const body of bodies) {
          if (path === '/runs/update') expect(Object.keys(body.update as object).every(key => key in RUN_UPDATE_FIELDS)).toBe(true);
          expect(Object.keys(body).every(key => key in RUN_REQUEST_FIELDS[path as keyof typeof RUN_REQUEST_FIELDS])).toBe(true);
        }
      }
    } finally { await f.close(); }
  }
  expect([...exercised].sort()).toEqual(ROUTES.filter(route => route.path.startsWith('/runs/')).map(route => route.path).sort());
  expect(Object.keys(RUN_REQUEST_FIELDS).sort()).toEqual([...exercised].sort());
  const refused = await embeddingRuntimeContract('custom model', 'bun', (path, body) => {
    if (path === '/runs/claim') body.agentId = '';
  });
  try { expect((await refused.server.env.db.prepare('SELECT error_code FROM agent_runs').first())?.error_code).toBe('parse'); }
  finally { await refused.close(); }
}, 30_000);
