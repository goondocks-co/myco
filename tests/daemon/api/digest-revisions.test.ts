/**
 * Tests for the digest-revisions API — listing revisions newest-first and
 * rolling content back to a prior revision via POST.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../../helpers/db';
import { registerAgent } from '@myco/db/queries/agents.js';
import {
  upsertDigestExtract,
  getDigestExtract,
} from '@myco/db/queries/digest-extracts.js';
import { createDigestRevisionHandlers } from '@myco/daemon/api/digest-revisions';
import type { RouteRequest } from '@myco/daemon/router';
import { ALL_PROJECTS_SCOPE } from '@myco/grove/ids.js';

const epochNow = () => Math.floor(Date.now() / 1000);
const AGENT_ID = 'myco-agent';
const TIER = 1500;

function makeRequest(overrides: Partial<RouteRequest> = {}): RouteRequest {
  return { params: {}, query: {}, body: undefined, pathname: '/', ...overrides } as RouteRequest;
}

function makeHandlers() {
  const logger = {
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  };
  return {
    logger,
    ...createDigestRevisionHandlers({
      vaultDir: '/tmp/fake-vault',
      logger: logger as never,
    }),
  };
}

describe('digest-revisions API', () => {
  beforeAll(() => { setupTestDb(); });
  afterAll(() => { teardownTestDb(); });
  beforeEach(() => {
    cleanTestDb();
    registerAgent({ id: AGENT_ID, name: 'Test', created_at: epochNow() });
  });

  describe('handleList', () => {
    it('returns revisions newest-first for a given (agent, tier)', async () => {
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v2', generated_at: 2 });
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v3', generated_at: 3 });

      const { handleList } = makeHandlers();
      const res = await handleList(makeRequest({
        query: { agentId: AGENT_ID, tier: String(TIER) },
      }));
      const body = res.body as { revisions: Array<{ content: string }>; count: number };
      expect(body.count).toBe(2);
      // v2 was the live content before v3 took over, so it's the newest revision.
      expect(body.revisions.map((r) => r.content)).toEqual(['v2', 'v1']);
    });

    it('defaults agentId to myco-agent when omitted', async () => {
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v2', generated_at: 2 });

      const { handleList } = makeHandlers();
      const res = await handleList(makeRequest({ query: { tier: String(TIER) } }));
      expect((res.body as { count: number }).count).toBe(1);
    });

    it('rejects missing tier with 400', async () => {
      const { handleList } = makeHandlers();
      const res = await handleList(makeRequest({ query: { agentId: AGENT_ID } }));
      expect(res.status).toBe(400);
    });
  });

  describe('handleRestore', () => {
    it('restores the digest content and returns the new revision id', async () => {
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v1', generated_at: 1 });
      upsertDigestExtract({ agent_id: AGENT_ID, tier: TIER, content: 'v2', generated_at: 2 });

      // Grab the "v1" revision id — that's the one we want to roll back to.
      const { handleList, handleRestore, logger } = makeHandlers();
      const list = await handleList(makeRequest({
        query: { agentId: AGENT_ID, tier: String(TIER) },
      }));
      const revisions = (list.body as { revisions: Array<{ id: number; content: string }> }).revisions;
      const v1Rev = revisions.find((r) => r.content === 'v1')!;
      expect(v1Rev).toBeDefined();

      // runId omitted: the handler records the rollback with
      // triggeredBy='operator' and skips the FK-backed run_id column.
      const res = await handleRestore(makeRequest({
        params: { id: String(v1Rev.id) },
        body: {},
      }));
      const body = res.body as { ok: boolean; restored: number; newRevisionId: number };
      expect(body.ok).toBe(true);
      expect(body.restored).toBe(v1Rev.id);
      expect(typeof body.newRevisionId).toBe('number');

      expect(getDigestExtract(AGENT_ID, TIER, { scope: ALL_PROJECTS_SCOPE })!.content).toBe('v1');
      expect(logger.info).toHaveBeenCalled();
    });

    it('returns 404 for unknown revision id', async () => {
      const { handleRestore } = makeHandlers();
      const res = await handleRestore(makeRequest({
        params: { id: '999999' },
        body: {},
      }));
      expect(res.status).toBe(404);
    });

    it('rejects a non-numeric revision id with 400', async () => {
      const { handleRestore } = makeHandlers();
      const res = await handleRestore(makeRequest({
        params: { id: 'not-a-number' },
        body: {},
      }));
      expect(res.status).toBe(400);
    });
  });
});
