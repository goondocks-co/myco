/**
 * Cross-route guarantee: API keys never appear in response bodies.
 *
 * This test seeds sentinel values into the provider-key env vars, exercises
 * every read and mutating route on the daemon that could plausibly echo a
 * key, and asserts the sentinel strings never appear in any response body
 * (success or error path). If a future regression reintroduces an
 * echo-back channel, this test will catch it before release.
 *
 * The SSRF fix in this PR locks the catalog fetch URL for remote providers
 * to the hardcoded default, and the CSRF/Origin/Content-Type gate blocks
 * the web-page exfiltration path; this test guards the last mile.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import { upsertSession } from '@myco/db/queries/sessions.js';
import { upsertPlan } from '@myco/db/queries/plans.js';
import { insertRun } from '@myco/db/queries/runs.js';
import { handleGetProviders, handleTestProvider } from '@myco/daemon/api/providers';
import { handleGetModels } from '@myco/daemon/api/models';
import {
  handleGetProviderSecrets,
  handlePutProviderSecret,
  handleDeleteProviderSecret,
} from '@myco/daemon/api/provider-secrets';
import { createAgentRunHandlers } from '@myco/daemon/api/agent-runs';
import { createSessionMutationHandlers } from '@myco/daemon/api/sessions';
import {
  handleListSessions,
  handleGetSession,
  handleGetSessionBatches,
  handleGetSessionPlans,
} from '@myco/daemon/api/sessions';
import { OPENAI_API_KEY_ENV, OPENROUTER_API_KEY_ENV } from '@myco/providers/env.js';

const SENTINELS = {
  openai: 'sk-sentinel-openai-ABCDEF1234567890',
  openrouter: 'sk-or-sentinel-openrouter-ABCDEF1234567890',
  anthropic: 'sk-ant-sentinel-anthropic-ABCDEF1234567890',
};

// Stub external backends so no network is required.
mock.module('@myco/intelligence/ollama.js', () => ({
  OllamaBackend: class {
    static DEFAULT_BASE_URL = 'http://localhost:11434';
    async isAvailable() { return false; }
    async listModels() { return []; }
  },
}));
mock.module('@myco/intelligence/lm-studio.js', () => ({
  LmStudioBackend: class {
    static DEFAULT_BASE_URL = 'http://localhost:1234';
    async isAvailable() { return false; }
    async listModels() { return []; }
  },
}));
mock.module('@myco/agent/executor.js', () => ({
  runAgent: vi.fn(async () => ({ runId: 'stub', status: 'completed' as const })),
}));
// Don't mock `@myco/config/loader.js` here. In bundled (non-isolated) test
// runs, a top-level `mock.module('@myco/config/loader.js', ...)` returning a
// partial stub poisons every other test file in the same bun process — the
// stub omits notifications/cortex/team/etc., so any test that calls
// `loadMergedConfig` afterwards crashes when it dereferences those keys. The
// real loader works fine here: tmpVault is freshly seeded with a minimal
// myco.yaml in beforeAll, and MYCO_HOME is sandboxed by tests/setup/vitest.ts.
mock.module('@myco/agent/config-resolver.js', () => ({
  hasConfiguredProvider: () => true,
}));

// The /api/providers detection path hits fetch() when an OpenAI/OpenRouter
// key is present. Intercept so we observe what URL was called AND so the
// response itself doesn't echo the key. A compliant remote never includes
// the caller's own bearer token in its body, but the test doubly-guards:
// - If our SSRF defense holds, fetch is called with api.openai.com only.
// - If a body were to contain a sentinel, the leak-scan assertion catches it.
const realFetch = globalThis.fetch;
const fetchMock = vi.fn();
// Only mock outbound calls to provider hosts; let loopback calls (our own
// test fetches to the daemon) fall through to the real fetch so response
// bodies come back via Node's http stack unmodified.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) {
    return realFetch(input, init);
  }
  fetchMock(url, init);
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: [{ id: 'gpt-5' }] }),
    text: async () => JSON.stringify({ data: [{ id: 'gpt-5' }] }),
  } as unknown as Response;
}) as typeof fetch;

const epochNow = () => Math.floor(Date.now() / 1000);

function makeLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('cross-route API key leak guard', () => {
  let server: DaemonServer;
  let tmpVault: string;
  let logger: DaemonLogger;

  beforeAll(async () => {
    // Seed sentinel values BEFORE setupTestDb so handlers see them.
    process.env[OPENAI_API_KEY_ENV] = SENTINELS.openai;
    process.env.OPENAI_API_KEY = SENTINELS.openai;
    process.env[OPENROUTER_API_KEY_ENV] = SENTINELS.openrouter;
    process.env.ANTHROPIC_API_KEY = SENTINELS.anthropic;

    tmpVault = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-leak-guard-'));
    fs.mkdirSync(path.join(tmpVault, 'logs'), { recursive: true });
    // Real loadMergedConfig requires myco.yaml — seed a minimal v3 doc so the
    // (now-unmocked) loader returns schema-defaulted config rather than throwing.
    fs.writeFileSync(
      path.join(tmpVault, 'myco.yaml'),
      'version: 3\nembedding:\n  provider: ollama\n  model: bge-m3\n',
      'utf-8',
    );
    logger = new DaemonLogger(path.join(tmpVault, 'logs'));
    setupTestDb();

    server = new DaemonServer({ vaultDir: tmpVault, logger });

    // Wire up a representative surface of routes.
    server.registerRoute('GET', '/api/providers', async () => handleGetProviders());
    server.registerRoute('POST', '/api/providers/test', async (req) => handleTestProvider(req));
    server.registerRoute('GET', '/api/providers/secrets', async () => handleGetProviderSecrets());
    server.registerRoute('PUT', '/api/providers/secrets/:provider', async (req) => handlePutProviderSecret(req));
    server.registerRoute('DELETE', '/api/providers/secrets/:provider', async (req) => handleDeleteProviderSecret(req));
    server.registerRoute('GET', '/api/models', handleGetModels);

    const embeddingManager = {
      onRemoved: vi.fn(), remove: vi.fn(), reconcile: vi.fn(),
    } as never;
    const agentRunHandlers = createAgentRunHandlers({
      vaultDir: tmpVault,
      embeddingManager,
      logger: makeLogger() as never,
    });
    server.registerRoute('POST', '/api/agent/run', agentRunHandlers.handleRun);
    server.registerRoute('GET', '/api/agent/runs', agentRunHandlers.handleListRuns);
    server.registerRoute('GET', '/api/agent/runs/:id', agentRunHandlers.handleGetRun);

    const sessionMut = createSessionMutationHandlers({
      embeddingManager,
      vaultDir: tmpVault,
      logger: makeLogger() as never,
      liveConfig: { current: { agent: { event_tasks_enabled: false } } } as never,
    });
    server.registerRoute('GET', '/api/sessions', handleListSessions);
    server.registerRoute('GET', '/api/sessions/:id', handleGetSession);
    server.registerRoute('GET', '/api/sessions/:id/batches', handleGetSessionBatches);
    server.registerRoute('GET', '/api/sessions/:id/plans', handleGetSessionPlans);
    server.registerRoute('DELETE', '/api/plans/:id', sessionMut.handleDeletePlan);

    await server.start();
  });

  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: 'myco-agent', name: 'Test', created_at: epochNow() });
  });

  afterAll(async () => {
    await server.stop();
    logger.close();
    teardownTestDb();
    fs.rmSync(tmpVault, { recursive: true, force: true });
    delete process.env[OPENAI_API_KEY_ENV];
    delete process.env.OPENAI_API_KEY;
    delete process.env[OPENROUTER_API_KEY_ENV];
    delete process.env.ANTHROPIC_API_KEY;
  });

  function assertNoLeak(label: string, body: string) {
    for (const [name, sentinel] of Object.entries(SENTINELS)) {
      expect(body, `${label} leaked ${name} sentinel`).not.toContain(sentinel);
    }
  }

  it('no route echoes a seeded API key sentinel in its response body', async () => {
    const base = `http://127.0.0.1:${server.port}`;

    // Seed a session/plan/run so list and detail routes have rows to serialize.
    const now = epochNow();
    upsertSession({ id: 'sess-1', agent: 'myco-agent', started_at: now, created_at: now });
    upsertPlan({
      id: 'plan-1',
      logical_key: 'session:sess-1:key:primary',
      session_id: 'sess-1',
      title: 'p', content: 'c',
      created_at: now,
    });
    insertRun({
      id: 'run-1',
      agent_id: 'myco-agent',
      task: 'task',
      instruction: 'do',
      status: 'completed',
      started_at: now,
      // Simulate a pre-patch historical row that still carries an apiKey in
      // execution_overrides. The serializer currently echoes this column
      // verbatim — this test pins the expectation that any future route
      // which reads it must mask secrets before returning to a client.
      executionOverrides: {
        provider: {
          type: 'openai',
          apiKey: SENTINELS.openai,
          baseUrl: 'https://attacker.example/v1',
        },
      },
    });

    const routes: Array<{ method: string; path: string; body?: unknown }> = [
      { method: 'GET', path: '/api/providers' },
      { method: 'POST', path: '/api/providers/test', body: { type: 'openai' } },
      { method: 'POST', path: '/api/providers/test', body: { type: 'openrouter' } },
      // Attempt to exploit SSRF via an attacker-controlled baseUrl — the
      // daemon MUST ignore it and not send the bearer key anywhere other
      // than the hardcoded default.
      { method: 'POST', path: '/api/providers/test', body: { type: 'openai', baseUrl: 'https://attacker.example/v1' } },
      { method: 'POST', path: '/api/providers/test', body: { type: 'openrouter', base_url: 'https://attacker.example/v1' } },
      { method: 'GET', path: '/api/providers/secrets' },
      { method: 'GET', path: '/api/models?provider=openai&type=llm' },
      { method: 'GET', path: '/api/models?provider=openrouter&type=llm' },
      { method: 'GET', path: '/api/models?provider=openai&type=llm&base_url=https%3A%2F%2Fattacker.example%2Fv1' },
      { method: 'GET', path: '/api/sessions' },
      { method: 'GET', path: '/api/sessions/sess-1' },
      { method: 'GET', path: '/api/sessions/sess-1/batches' },
      { method: 'GET', path: '/api/sessions/sess-1/plans' },
      { method: 'GET', path: '/api/agent/runs' },
      { method: 'GET', path: '/api/agent/runs/run-1' },
      // Attacker-controlled body; the daemon must not echo any key back.
      {
        method: 'POST',
        path: '/api/agent/run',
        body: {
          task: 't', instruction: 'go', agentId: 'myco-agent',
          executionOverrides: {
            provider: { type: 'openai', apiKey: SENTINELS.openai, baseUrl: 'https://attacker.example/v1' },
          },
        },
      },
    ];

    for (const r of routes) {
      const init: RequestInit = { method: r.method };
      if (r.body !== undefined) {
        init.headers = { 'Content-Type': 'application/json' };
        init.body = JSON.stringify(r.body);
      }
      const res = await fetch(`${base}${r.path}`, init);
      const text = await res.text();
      assertNoLeak(`${r.method} ${r.path}`, text);
    }

    // Also verify the SSRF defense held: fetch was only ever called on the
    // hardcoded provider hosts, never the attacker hostname.
    for (const call of fetchMock.mock.calls) {
      const url = String(call[0]);
      expect(url).not.toContain('attacker.example');
    }
  });
});
