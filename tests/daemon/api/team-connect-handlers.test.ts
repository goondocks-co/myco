import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db.js';
import { getDatabase } from '@myco/db/client.js';
import type { RouteRequest, RouteResponse } from '@myco/daemon/router.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';
import { createTeamId } from '@myco/grove/ids.js';
import { teamRegistry } from '@myco/team/registry.js';

import { TEST_REQUEST_CONTEXT } from '../../helpers/request-context';
// Direct branch coverage for handlers in
// `packages/myco/src/daemon/api/team-connect.ts` that the existing
// tests/daemon/api/team-connect-status.test.ts left untested:
//   handleConnect (retired legacy route), handleDisconnect, handleBackfill,
//   handleDlqList/Retry/Discard, handleRotateMcpToken.

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
    listDlq: async () => ({ messages: [] }),
    retryDlq: async (ids: string[]) => ({ retried: ids.length }),
    discardDlq: async (ids: string[]) => ({ discarded: ids.length }),
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
  // G3 requires grove_<32hex>; G6 requires registry membership. Mint via
  // createGrove() to satisfy both gates.
  let groveId: string;
  let originalMycoHome: string | undefined;
  let groveCtx: MycoRequestContext;

  beforeAll(() => {
    setupTestDb();
  });

  beforeEach(async () => {
    cleanTestDb();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-handlers-'));
    vaultDir = path.join(tempDir, 'project', '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), [
      'version: 3',
      'config_version: 0',
    ].join('\n'), 'utf-8');
    fs.writeFileSync(path.join(vaultDir, 'secrets.env'), '', 'utf-8');

    // Stage a Grove home so registry-backed handlers resolve the same
    // Grove context users hit at runtime.
    mycoHome = path.join(tempDir, 'home');
    fs.mkdirSync(mycoHome, { recursive: true });
    originalMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    // Register a Grove via the public API so it satisfies G3/G6.
    const { createGrove } = await import('../../../packages/myco/src/grove/registry.js');
    const grove = createGrove('handler-test', mycoHome);
    groveId = grove.id;
    groveDir = path.join(mycoHome, 'groves', groveId);
    fs.mkdirSync(groveDir, { recursive: true });
    groveConfigPath = path.join(groveDir, 'grove.yaml');
    fs.writeFileSync(groveConfigPath, 'team:\n  enabled: false\n', 'utf-8');
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
  // handleConnect — retired legacy route
  // -------------------------------------------------------------------------

  describe('handleConnect', () => {
    it('returns 410 because legacy connect is no longer a Team writer', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => null,
      });

      const noUrl = await handlers.handleConnect(makeRequest({ body: { api_key: 'k' } }));
      expect(noUrl.status).toBe(410);
      expect((noUrl.body as { error: string }).error).toBe('legacy_team_connect_removed');
    });
  });

  // -------------------------------------------------------------------------
  // handleDisconnect
  // -------------------------------------------------------------------------

  describe('handleDisconnect', () => {
    it('removes the current project from its registry Team', async () => {
      const teamId = createTeamId();
      teamRegistry.save({
        team_id: teamId,
        name: 'Handlers Team',
        worker_url: 'https://team.example.workers.dev',
        domain: null,
        mcp_endpoint: null,
        created_at: new Date().toISOString(),
        projects: [{ grove_id: groveCtx.groveId!, project_id: groveCtx.projectId! }],
      });

      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient() as never,
      });

      const response = await handlers.handleDisconnect(
        makeRequest({ requestContext: groveCtx }),
      );
      expect((response.body as { connected: boolean; removed_project: boolean }).connected).toBe(false);
      expect((response.body as { removed_project: boolean }).removed_project).toBe(true);
      expect(teamRegistry.get(teamId)?.projects).toEqual([]);
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
        listDlq: async () => ({
          messages: [{
            lease_id: 'lease-1',
            table_name: 'sessions',
            row_id: 'row-abc',
            machine_id: 'machine-test',
            operation: 'upsert',
            reason: null,
            created_at: 1700000000,
          }],
        }),
      });
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => stub as never,
      });

      const response = await handlers.handleDlqList(makeRequest({ query: { limit: '7' } }));
      const body = response.body as { messages: Array<{ lease_id: string; table_name: string }> };
      expect(body.messages[0].lease_id).toBe('lease-1');
      expect(body.messages[0].table_name).toBe('sessions');
    });

    it('returns 400 on retry/discard when lease_ids is missing or empty', async () => {
      const { createTeamHandlers } = await import('../../../packages/myco/src/daemon/api/team-connect.js');
      const handlers = createTeamHandlers({
        vaultDir,
        machineId: 'machine-test',
        globalPrefix: null,
        logger: noopLogger,
        getTeamClient: () => makeStubClient() as never,
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
      });

      const retry = await handlers.handleDlqRetry(makeRequest({ body: { lease_ids: ['a', 'b', 'c'] } }));
      expect((retry.body as { retried: number }).retried).toBe(3);

      const discard = await handlers.handleDlqDiscard(makeRequest({ body: { lease_ids: ['x'] } }));
      expect((discard.body as { discarded: number }).discarded).toBe(1);
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
      });

      const response = await handlers.handleRotateMcpToken(makeRequest());
      expect(response.status).toBe(500);
      expect((response.body as { error: string }).error).toBe('worker rejected');
    });
  });
});

// Silences unused-imports lint when the assertions don't reference db.
void getDatabase;
