import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import { TEAM_API_KEY_SECRET } from '@myco/constants.js';
import { readTeamConnectionSecrets } from '@myco/grove/team-connection.js';
import type { RouteRequest, RouteResponse } from '@myco/daemon/router.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
// Direct branch coverage for handlers in
// `packages/myco/src/daemon/api/team-connect.ts` that the existing
// tests/daemon/api/team-connect-status.test.ts left untested:
//   handleConnect (4 branches), handleDisconnect, handleBackfill,
//   handleDlqList/Retry/Discard, handleSetCfApiToken,
//   handleClearCfApiToken, handleRotateMcpToken.

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function makeStubClient(overrides: Record<string, unknown> = {}): unknown {
  return {
    health: async () => ({
      status: 'ok',
      node_count: 1,
      sync_protocol_version: 1,
      package_version: '0.0.0',
      schema_version: 1,
    }),
    enqueueVectorReindex: async () => ({ enqueued: 0, by_table: {} }),
    listDlq: async () => ({ messages: [], next_cursor: null }),
    retryDlq: async (ids: string[]) => ({ retried: ids.length }),
    discardDlq: async (ids: string[]) => ({ discarded: ids.length }),
    setCfApiToken: async () => ({ configured: true }),
    clearCfApiToken: async () => ({ cleared: true }),
    rotateMcpToken: async () => 'rotated-mcp-token',
    getMcpToken: () => null,
    getMcpEndpoint: () => null,
    getCollectiveStatus: async () => ({
      connected: false,
      collective_url: null,
      project_id: null,
      last_settings_sync: null,
      last_heartbeat: null,
      capabilities: [],
      settings: {},
    }),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return {
    body: undefined,
    requestContext: TEST_REQUEST_CONTEXT,
    query: {},
    params: {},
    pathname: '/api/team/test',
    ...overrides,
  };
}

describe('team-connect handlers — direct coverage', () => {
  let tempDir: string;
  let vaultDir: string;
  let mycoHome: string;
  let groveDir: string;
  let groveConfigPath: string;
  const groveId = 'grove_handler_test';
  let originalMycoHome: string | undefined;
  let groveCtx: MycoRequestContext;

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(() => {
    cleanTestDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-handlers-'));
    vaultDir = path.join(tempDir, 'project', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), '', 'utf-8');

    // Stage a Grove home so updateTeamConnectionConfig writes through
    // the Grove-aware path (the only path that actually persists team
    // settings — the legacy project YAML strips `team:` on save).
    mycoHome = path.join(tempDir, 'home');
    groveDir = path.join(mycoHome, 'groves', groveId);
    fs.mkdirSync(groveDir, { recursive: true });
    groveConfigPath = path.join(groveDir, 'grove.yaml');
    fs.writeFileSync(groveConfigPath, 'team:\n  enabled: false\n', 'utf-8');
    originalMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    groveCtx = {
      projectRoot: path.join(tempDir, 'project'),
      projectVaultDir: vaultDir,
      projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      groveId,
      machineId: 'machine-test',
      sessionId: null,
      databasePath: path.join(groveDir, 'myco.db'),
      source: 'headers',
    };
  });

  afterEach(() => {
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  afterAll(() => {
    teardownTestDb();
  });

  // -------------------------------------------------------------------------
  // handleConnect — 4 branches
  // -------------------------------------------------------------------------

  describe('handleConnect', () => {
    it('returns 400 missing_fields when url or api_key are absent', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const noUrl = await handlers.handleConnect(makeRequest({ body: { api_key: 'k' } }));
      expect(noUrl.status).toBe(400);
      expect((noUrl.body as { error: string }).error).toBe('missing_fields');

      const noKey = await handlers.handleConnect(makeRequest({ body: { url: 'https://x' } }));
      expect(noKey.status).toBe(400);
      expect((noKey.body as { error: string }).error).toBe('missing_fields');

      const empty = await handlers.handleConnect(makeRequest({ body: {} }));
      expect(empty.status).toBe(400);
    });

    it('returns 400 invalid_url when url cannot be parsed', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleConnect(
        makeRequest({ body: { url: 'not-a-url', api_key: 'k' } }),
      );
      expect(response.status).toBe(400);
      expect((response.body as { error: string }).error).toBe('invalid_url');
    });

    it('returns 502 connection_failed when health() throws', async () => {
      // The handler instantiates a real TeamSyncClient internally and
      // calls .health() — pointing at an invalid worker URL surfaces a
      // network error which the handler maps to 502 connection_failed.
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleConnect(
        // 127.0.0.1:1 is reliably closed; fetch fails fast.
        makeRequest({ body: { url: 'http://127.0.0.1:1', api_key: 'k' } }),
      );
      expect(response.status).toBe(502);
      expect((response.body as { error: string }).error).toBe('connection_failed');
    });

    it('persists config + secret and registers the client on successful health', async () => {
      // Stub fetch globally so TeamSyncClient.health() resolves successfully.
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(
        JSON.stringify({ status: 'ok', sync_protocol_version: 1 }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )) as typeof fetch;

      try {
        let registeredClient: unknown = null;
        const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
        const handlers = createTeamHandlers({
          vaultDir,
          machineId: 'machine-test',
          globalPrefix: null,
          logger: noopLogger,
          getTeamClient: () => null,
          setTeamClient: (c) => { registeredClient = c; },
        });

        const response = await handlers.handleConnect(
          makeRequest({
            body: {
              url: 'https://team.example.workers.dev',
              api_key: 'super-secret-key',
            },
            requestContext: groveCtx,
          }),
        );

        expect(response.status).toBeUndefined();
        expect((response.body as { connected: boolean }).connected).toBe(true);
        // Client got installed.
        expect(registeredClient).not.toBeNull();
        // Config persisted to the Grove-tier yaml.
        const yamlText = fs.readFileSync(groveConfigPath, 'utf-8');
        expect(yamlText).toContain('enabled: true');
        expect(yamlText).toContain('https://team.example.workers.dev');
        // Secret persisted under the Grove dir.
        const secrets = readTeamConnectionSecrets(vaultDir, groveCtx);
        expect(secrets[TEAM_API_KEY_SECRET]).toBe('super-secret-key');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // -------------------------------------------------------------------------
  // handleDisconnect
  // -------------------------------------------------------------------------

  describe('handleDisconnect', () => {
    it('flips enabled to false and clears the registered client', async () => {
      // Seed an enabled grove.yaml so the disconnect has something to flip.
      fs.writeFileSync(groveConfigPath, [
        'team:',
        '  enabled: true',
        '  worker_url: https://team.example.workers.dev',
      ].join('\n') + '\n', 'utf-8');

      let registeredClient: unknown = makeStubClient();
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => registeredClient as never,
        setTeamClient: (c) => { registeredClient = c; },
      });

      const response = await handlers.handleDisconnect(
        makeRequest({ requestContext: groveCtx }),
      );
      expect((response.body as { connected: boolean }).connected).toBe(false);
      expect(registeredClient).toBeNull();
      // grove.yaml flipped to enabled: false.
      const yamlText = fs.readFileSync(groveConfigPath, 'utf-8');
      expect(yamlText).toContain('enabled: false');
    });
  });

  // -------------------------------------------------------------------------
  // handleBackfill
  // -------------------------------------------------------------------------

  describe('handleBackfill', () => {
    it('returns enqueued count and reports 0 vector_enqueued when no client', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleBackfill(makeRequest({ body: {} }));
      const body = response.body as {
        enqueued: number;
        mode: string;
        vector_enqueued: number | null;
        vector_error: string | null;
      };
      expect(body.mode).toBe('unsynced');
      expect(body.vector_enqueued).toBeNull();
      expect(body.vector_error).toBeNull();
    });

    it('selects mode "all" when explicitly requested', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleBackfill(makeRequest({ body: { mode: 'all' } }));
      expect((response.body as { mode: string }).mode).toBe('all');
    });

    it('captures vector_error when the worker enqueue throws but still returns local enqueued', async () => {
      let enqueueCalled = 0;
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient({
          enqueueVectorReindex: async () => {
            enqueueCalled += 1;
            throw new Error('cf vector down');
          },
        }) as never,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleBackfill(makeRequest({ body: { mode: 'unsynced' } }));
      const body = response.body as {
        enqueued: number;
        vector_enqueued: number | null;
        vector_error: string | null;
      };
      expect(enqueueCalled).toBe(1);
      expect(body.vector_enqueued).toBeNull();
      expect(body.vector_error).toBe('cf vector down');
    });
  });

  // -------------------------------------------------------------------------
  // DLQ handlers
  // -------------------------------------------------------------------------

  describe('handleDlqList / handleDlqRetry / handleDlqDiscard', () => {
    it('returns 503 team_not_configured when no client is registered', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const list = await handlers.handleDlqList(makeRequest({ query: { limit: '10' } }));
      expect(list.status).toBe(503);
      expect((list.body as { error: string }).error).toBe('team_not_configured');

      const retry = await handlers.handleDlqRetry(makeRequest({ body: { lease_ids: ['a'] } }));
      expect(retry.status).toBe(503);

      const discard = await handlers.handleDlqDiscard(makeRequest({ body: { lease_ids: ['a'] } }));
      expect(discard.status).toBe(503);
    });

    it('forwards listDlq results from the client', async () => {
      const stub = makeStubClient({
        listDlq: async (limit: number) => ({
          messages: [{ msg_id: 'm1', body: { table: 'sessions' }, attempts: 1 }],
          next_cursor: String(limit),
        }),
      });
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => stub as never,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleDlqList(makeRequest({ query: { limit: '7' } }));
      const body = response.body as { messages: Array<{ msg_id: string }>; next_cursor: string };
      expect(body.messages[0].msg_id).toBe('m1');
      expect(body.next_cursor).toBe('7');
    });

    it('returns 400 on retry/discard when lease_ids is missing or empty', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient() as never,
        setTeamClient: () => undefined,
      });

      const retryEmpty = await handlers.handleDlqRetry(makeRequest({ body: { lease_ids: [] } }));
      expect(retryEmpty.status).toBe(400);

      const retryMissing = await handlers.handleDlqRetry(makeRequest({ body: {} }));
      expect(retryMissing.status).toBe(400);

      const discardMissing = await handlers.handleDlqDiscard(makeRequest({ body: {} }));
      expect(discardMissing.status).toBe(400);
    });

    it('forwards retry/discard counts from the client', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient() as never,
        setTeamClient: () => undefined,
      });

      const retry = await handlers.handleDlqRetry(makeRequest({ body: { lease_ids: ['a', 'b', 'c'] } }));
      expect((retry.body as { retried: number }).retried).toBe(3);

      const discard = await handlers.handleDlqDiscard(makeRequest({ body: { lease_ids: ['x'] } }));
      expect((discard.body as { discarded: number }).discarded).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // CF API token handlers
  // -------------------------------------------------------------------------

  describe('handleSetCfApiToken / handleClearCfApiToken', () => {
    it('returns 503 when no client is registered', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const set = await handlers.handleSetCfApiToken(
        makeRequest({ body: { token: 't', account_id: 'a' } }),
      );
      expect(set.status).toBe(503);

      const clear = await handlers.handleClearCfApiToken(makeRequest());
      expect(clear.status).toBe(503);
    });

    it('returns 400 when token or account_id is missing on set', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient() as never,
        setTeamClient: () => undefined,
      });

      const noToken = await handlers.handleSetCfApiToken(makeRequest({ body: { account_id: 'a' } }));
      expect(noToken.status).toBe(400);

      const noAccount = await handlers.handleSetCfApiToken(makeRequest({ body: { token: 't' } }));
      expect(noAccount.status).toBe(400);
    });

    it('forwards setCfApiToken arguments to the client', async () => {
      let captured: { token?: string; accountId?: string } = {};
      const stub = makeStubClient({
        setCfApiToken: async (token: string, accountId: string) => {
          captured = { token, accountId };
          return { configured: true };
        },
      });
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => stub as never,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleSetCfApiToken(
        makeRequest({ body: { token: 'tok', account_id: 'acct' } }),
      );
      expect((response.body as { configured: boolean }).configured).toBe(true);
      expect(captured).toEqual({ token: 'tok', accountId: 'acct' });
    });

    it('forwards clearCfApiToken to the client', async () => {
      let cleared = 0;
      const stub = makeStubClient({
        clearCfApiToken: async () => {
          cleared += 1;
          return { cleared: true };
        },
      });
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => stub as never,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleClearCfApiToken(makeRequest());
      expect(cleared).toBe(1);
      expect((response.body as { cleared: boolean }).cleared).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // handleRotateMcpToken
  // -------------------------------------------------------------------------

  describe('handleRotateMcpToken', () => {
    it('returns 400 when no client is registered', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleRotateMcpToken(makeRequest());
      expect(response.status).toBe(400);
      expect((response.body as { error: string }).error).toBe('Team sync not connected');
    });

    it('returns the rotated token from the client', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient() as never,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleRotateMcpToken(makeRequest());
      expect(response.status).toBeUndefined();
      expect((response.body as { token: string }).token).toBe('rotated-mcp-token');
    });

    it('returns 500 with the error message when rotation throws', async () => {
      const stub = makeStubClient({
        rotateMcpToken: async () => { throw new Error('worker rejected'); },
      });
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => stub as never,
        setTeamClient: () => undefined,
      });

      const response = await handlers.handleRotateMcpToken(makeRequest());
      expect(response.status).toBe(500);
      expect((response.body as { error: string }).error).toBe('worker rejected');
    });
  });
});

// Silences unused-imports lint when the assertions don't reference db.
void getDatabase;
