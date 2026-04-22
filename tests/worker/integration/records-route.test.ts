/**
 * Integration coverage for the `GET /records/:type/:id` HTTP route exposed
 * by the team worker. The daemon's recall fallback relies on this route
 * (see `TeamSyncClient.getRecord` and `createGetSessionHandler`), so it
 * needs to keep the contract: authorized hit returns 200 + `{ record }`,
 * authorized miss returns 404 + `{ error: 'not_found' }`, unauthorized
 * returns 401, unknown type returns 400.
 *
 * We drive the worker through its default `fetch` export so the validate-
 * auth plumbing is exercised for real. D1 / Vectorize / AI are mocked
 * because none of them need to round-trip for a simple SELECT.
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';

// Runs in the Cloudflare Workers pool (`cloudflareTest` plugin in
// vitest.config.ts), so `cloudflare:workers` and the transitive `agents/*`
// imports resolve against a real workerd runtime. D1 / KV bindings are
// ephemeral miniflare in-memory stores, but we still mock env at the call
// site because this suite only exercises the `/records/:type/:id` HTTP
// contract — not the D1 schema init or vector search paths.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let worker: any;

interface FakeD1Entry {
  id: string;
  machine_id: string;
  [key: string]: unknown;
}

function createWorkerEnv(rows: Record<string, FakeD1Entry[]>): Record<string, unknown> {
  const prepare = (sql: string) => {
    let boundValues: unknown[] = [];
    const match = sql.match(/FROM\s+(\w+)/i);
    const table = match?.[1];
    return {
      sql,
      bind(...values: unknown[]) {
        boundValues = values;
        return this;
      },
      async all() {
        return { results: [] as unknown[] };
      },
      async first<T = unknown>() {
        if (!table) return null;
        const id = boundValues[0];
        const hit = (rows[table] ?? []).find((r) => r.id === id);
        return (hit as T) ?? null;
      },
      async run() {
        return { success: true };
      },
    };
  };

  return {
    MYCO_TEAM_DB: {
      prepare,
      // `initD1Schema` batches CREATE/ALTER statements — return success.
      batch: async () => [{ success: true }],
    },
    MYCO_TEAM_VECTORS: { query: async () => ({ matches: [], count: 0 }) },
    AI: { run: async () => ({ data: [[]] }) },
    MYCO_TEAM_API_KEY: 'test-api-key',
    SYNC_PROTOCOL_VERSION: '1',
    MYCO_SECRETS: {
      get: async () => null,
      put: async () => {},
    },
  };
}

function makeRequest(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://example.com${path}`, { method: 'GET', headers });
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as ExecutionContext;

// TODO(bun-migration): see vault spore decision-754d7dd5 — runs under vitest-pool-workers; pending worker test runner migration.
describe.skip('GET /records/:type/:id', () => {
  let env: Record<string, unknown>;

  beforeAll(async () => {
    ({ default: worker } = await import('@myco-team-worker/index'));
  });

  beforeEach(() => {
    env = createWorkerEnv({
      sessions: [
        { id: 'sess-hit', machine_id: 'remote-1', title: 'Remote session' },
      ],
      spores: [],
    });
  });

  it('returns { record } with 200 on authorized hit', async () => {
    const req = makeRequest('/records/sessions/sess-hit', {
      Authorization: 'Bearer test-api-key',
    });
    const res = await worker.fetch(req, env as never, ctx);
    expect(res.status).toBe(200);
    const body = await res.json() as { record: { id: string; machine_id: string } };
    expect(body.record.id).toBe('sess-hit');
    expect(body.record.machine_id).toBe('remote-1');
  });

  it('returns 404 with { error: not_found } on authorized miss', async () => {
    const req = makeRequest('/records/sessions/nope', {
      Authorization: 'Bearer test-api-key',
    });
    const res = await worker.fetch(req, env as never, ctx);
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('returns 401 on unauthorized request', async () => {
    const req = makeRequest('/records/sessions/sess-hit');
    const res = await worker.fetch(req, env as never, ctx);
    expect(res.status).toBe(401);
  });

  it('returns 400 on unknown record type', async () => {
    const req = makeRequest('/records/widgets/x', {
      Authorization: 'Bearer test-api-key',
    });
    const res = await worker.fetch(req, env as never, ctx);
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/Unknown record type/);
  });
});
