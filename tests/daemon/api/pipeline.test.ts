import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PipelineManager } from '@myco/daemon/pipeline';
import type { PipelineConfig } from '@myco/config/schema';
import {
  handlePipelineHealth,
  handlePipelineItems,
  handlePipelineItemDetail,
  handlePipelineCircuits,
  handlePipelineRetry,
  handlePipelineRetryAll,
  handlePipelineCircuitReset,
} from '@myco/daemon/api/pipeline';
import type { RouteRequest } from '@myco/daemon/router';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// --- Test helpers ---

function makeConfig(overrides?: Partial<PipelineConfig>): PipelineConfig {
  return {
    retention_days: 30,
    batch_size: 20,
    tick_interval_seconds: 30,
    retry: { transient_max: 3, backoff_base_seconds: 30 },
    circuit_breaker: { failure_threshold: 3, cooldown_seconds: 300, max_cooldown_seconds: 3600 },
    ...overrides,
  };
}

const TEST_CONFIG = makeConfig();

function makeReq(overrides?: Partial<RouteRequest>): RouteRequest {
  return {
    body: undefined,
    query: {},
    params: {},
    pathname: '/',
    ...overrides,
  };
}

describe('Pipeline API handlers', () => {
  let tmpDir: string;
  let pipeline: PipelineManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-pipeline-api-'));
    pipeline = new PipelineManager(tmpDir, TEST_CONFIG);
  });

  afterEach(() => {
    pipeline.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // --- GET /api/pipeline/health ---

  describe('handlePipelineHealth', () => {
    it('returns health structure with empty pipeline', async () => {
      const handler = handlePipelineHealth(pipeline);
      const result = await handler(makeReq());
      const body = result.body as Record<string, unknown>;

      expect(body.stages).toBeDefined();
      expect(body.circuits).toBeDefined();
      expect(body.totals).toBeDefined();
      expect((body.totals as Record<string, number>).pending).toBe(0);
    });

    it('reflects registered items in health totals', async () => {
      pipeline.register('item-1', 'session', '/path/1');
      pipeline.register('item-2', 'spore', '/path/2');

      const handler = handlePipelineHealth(pipeline);
      const result = await handler(makeReq());
      const body = result.body as Record<string, unknown>;
      const totals = body.totals as Record<string, number>;

      // Each item creates pending + skipped transitions
      expect(totals.pending).toBeGreaterThan(0);
    });
  });

  // --- GET /api/pipeline/items ---

  describe('handlePipelineItems', () => {
    it('returns empty items list for empty pipeline', async () => {
      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq());
      const body = result.body as { items: unknown[]; total: number };

      expect(body.items).toEqual([]);
      expect(body.total).toBe(0);
    });

    it('returns paginated items', async () => {
      pipeline.register('item-1', 'session', '/path/1');
      pipeline.register('item-2', 'spore', '/path/2');

      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq({ query: { limit: '2', offset: '0' } }));
      const body = result.body as { items: unknown[]; total: number };

      expect(body.items.length).toBeLessThanOrEqual(2);
      expect(body.total).toBeGreaterThan(0);
    });

    it('filters by stage', async () => {
      pipeline.register('item-1', 'session', '/path/1');

      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq({ query: { stage: 'capture' } }));
      const body = result.body as { items: Array<{ stage: string }>; total: number };

      for (const item of body.items) {
        expect(item.stage).toBe('capture');
      }
    });

    it('filters by status', async () => {
      pipeline.register('item-1', 'session', '/path/1');

      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq({ query: { status: 'pending' } }));
      const body = result.body as { items: Array<{ status: string }>; total: number };

      for (const item of body.items) {
        expect(item.status).toBe('pending');
      }
    });

    it('filters by type', async () => {
      pipeline.register('item-1', 'session', '/path/1');
      pipeline.register('item-2', 'spore', '/path/2');

      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq({ query: { type: 'session' } }));
      const body = result.body as { items: Array<{ item_type: string }>; total: number };

      for (const item of body.items) {
        expect(item.item_type).toBe('session');
      }
    });

    it('returns 400 for invalid limit', async () => {
      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq({ query: { limit: 'abc' } }));

      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toBe('invalid_limit');
    });

    it('returns 400 for invalid offset', async () => {
      const handler = handlePipelineItems(pipeline);
      const result = await handler(makeReq({ query: { offset: '-1' } }));

      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toBe('invalid_offset');
    });
  });

  // --- GET /api/pipeline/items/:id ---

  describe('handlePipelineItemDetail', () => {
    it('returns item with stages and history', async () => {
      pipeline.register('item-1', 'session', '/path/1');

      const handler = handlePipelineItemDetail(pipeline);
      const result = await handler(makeReq({
        params: { id: 'item-1' },
        query: { type: 'session' },
      }));
      const body = result.body as {
        id: string;
        type: string;
        stages: unknown[];
        history: unknown[];
      };

      expect(body.id).toBe('item-1');
      expect(body.type).toBe('session');
      expect(body.stages.length).toBeGreaterThan(0);
      expect(body.history.length).toBeGreaterThan(0);
    });

    it('returns 400 when type query param is missing', async () => {
      const handler = handlePipelineItemDetail(pipeline);
      const result = await handler(makeReq({
        params: { id: 'item-1' },
        query: {},
      }));

      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toBe('missing_type');
    });

    it('returns 404 for nonexistent item', async () => {
      const handler = handlePipelineItemDetail(pipeline);
      const result = await handler(makeReq({
        params: { id: 'nonexistent' },
        query: { type: 'session' },
      }));

      expect(result.status).toBe(404);
      expect((result.body as Record<string, unknown>).error).toBe('not_found');
    });
  });

  // --- GET /api/pipeline/circuits ---

  describe('handlePipelineCircuits', () => {
    it('returns empty array when no circuits exist', async () => {
      const handler = handlePipelineCircuits(pipeline);
      const result = await handler(makeReq());
      const body = result.body as unknown[];

      expect(body).toEqual([]);
    });

    it('returns circuit breaker states', async () => {
      pipeline.tripCircuit('llm', 'connection failed');

      const handler = handlePipelineCircuits(pipeline);
      const result = await handler(makeReq());
      const body = result.body as Array<{ provider_role: string }>;

      expect(body.length).toBe(1);
      expect(body[0].provider_role).toBe('llm');
    });
  });

  // --- POST /api/pipeline/retry/:id ---

  describe('handlePipelineRetry', () => {
    it('retries a poisoned item', async () => {
      pipeline.register('item-1', 'session', '/path/1');
      // Poison the item at capture stage
      pipeline.advance('item-1', 'session', 'capture', 'processing');
      pipeline.advance('item-1', 'session', 'capture', 'failed', { errorType: 'parse', errorMessage: 'bad data' });
      // parse max retries = 1, so after 1 failure it should be poisoned
      pipeline.advance('item-1', 'session', 'capture', 'processing');
      pipeline.advance('item-1', 'session', 'capture', 'failed', { errorType: 'parse', errorMessage: 'bad data' });

      // Verify it's poisoned
      const status = pipeline.getItemStatus('item-1', 'session');
      const captureStage = status.find((s) => s.stage === 'capture');
      expect(captureStage?.status).toBe('poisoned');

      const handler = handlePipelineRetry(pipeline);
      const result = await handler(makeReq({
        params: { id: 'item-1' },
        body: { type: 'session', stage: 'capture' },
      }));
      const body = result.body as Record<string, unknown>;

      expect(body.retried).toBe(true);
      expect(body.id).toBe('item-1');

      // Verify it's now pending
      const updated = pipeline.getItemStatus('item-1', 'session');
      const updatedCapture = updated.find((s) => s.stage === 'capture');
      expect(updatedCapture?.status).toBe('pending');
    });

    it('returns 404 when item is not poisoned', async () => {
      pipeline.register('item-1', 'session', '/path/1');

      const handler = handlePipelineRetry(pipeline);
      const result = await handler(makeReq({
        params: { id: 'item-1' },
        body: { type: 'session', stage: 'capture' },
      }));

      expect(result.status).toBe(404);
      expect((result.body as Record<string, unknown>).error).toBe('not_poisoned');
    });

    it('returns 400 for invalid body', async () => {
      const handler = handlePipelineRetry(pipeline);
      const result = await handler(makeReq({
        params: { id: 'item-1' },
        body: { missing: 'fields' },
      }));

      expect(result.status).toBe(400);
      expect((result.body as Record<string, unknown>).error).toBe('validation_failed');
    });
  });

  // --- POST /api/pipeline/retry-all ---

  describe('handlePipelineRetryAll', () => {
    it('retries all poisoned items', async () => {
      pipeline.register('item-1', 'session', '/path/1');
      pipeline.register('item-2', 'spore', '/path/2');

      // Poison both at capture
      for (const [id, type] of [['item-1', 'session'], ['item-2', 'spore']] as const) {
        pipeline.advance(id, type, 'capture', 'processing');
        pipeline.advance(id, type, 'capture', 'failed', { errorType: 'parse', errorMessage: 'bad' });
        pipeline.advance(id, type, 'capture', 'processing');
        pipeline.advance(id, type, 'capture', 'failed', { errorType: 'parse', errorMessage: 'bad' });
      }

      const handler = handlePipelineRetryAll(pipeline);
      const result = await handler(makeReq());
      const body = result.body as { retried: number };

      expect(body.retried).toBe(2);

      // Both should be pending now
      for (const [id, type] of [['item-1', 'session'], ['item-2', 'spore']] as const) {
        const status = pipeline.getItemStatus(id, type);
        const capture = status.find((s) => s.stage === 'capture');
        expect(capture?.status).toBe('pending');
      }
    });

    it('returns zero when no poisoned items exist', async () => {
      pipeline.register('item-1', 'session', '/path/1');

      const handler = handlePipelineRetryAll(pipeline);
      const result = await handler(makeReq());
      const body = result.body as { retried: number };

      expect(body.retried).toBe(0);
    });
  });

  // --- POST /api/pipeline/circuit/:provider/reset ---

  describe('handlePipelineCircuitReset', () => {
    it('resets an open circuit breaker', async () => {
      // Trip the circuit enough to open it
      pipeline.tripCircuit('llm', 'error 1');
      pipeline.tripCircuit('llm', 'error 2');
      pipeline.tripCircuit('llm', 'error 3');

      const state = pipeline.circuitState('llm');
      expect(state.state).toBe('open');

      const handler = handlePipelineCircuitReset(pipeline);
      const result = await handler(makeReq({
        params: { provider: 'llm' },
      }));
      const body = result.body as { reset: boolean; provider: string; unblocked: number };

      expect(body.reset).toBe(true);
      expect(body.provider).toBe('llm');
      expect(typeof body.unblocked).toBe('number');

      // Circuit should now be closed
      const updated = pipeline.circuitState('llm');
      expect(updated.state).toBe('closed');
      expect(updated.failure_count).toBe(0);
    });

    it('resets a circuit and unblocks items', async () => {
      pipeline.register('item-1', 'session', '/path/1');
      // Succeed capture so extraction is the next pending stage
      pipeline.advance('item-1', 'session', 'capture', 'processing');
      pipeline.advance('item-1', 'session', 'capture', 'succeeded');

      // Trip and open the llm circuit (extraction uses llm)
      pipeline.tripCircuit('llm', 'error 1');
      pipeline.tripCircuit('llm', 'error 2');
      pipeline.tripCircuit('llm', 'error 3');

      // Block items
      pipeline.blockItemsForCircuit('llm');

      // Verify blocked
      const beforeStatus = pipeline.getItemStatus('item-1', 'session');
      const extractionBefore = beforeStatus.find((s) => s.stage === 'extraction');
      expect(extractionBefore?.status).toBe('blocked');

      // Reset the circuit
      const handler = handlePipelineCircuitReset(pipeline);
      const result = await handler(makeReq({
        params: { provider: 'llm' },
      }));
      const body = result.body as { reset: boolean; unblocked: number };

      expect(body.reset).toBe(true);
      expect(body.unblocked).toBeGreaterThan(0);

      // Extraction should be pending again
      const afterStatus = pipeline.getItemStatus('item-1', 'session');
      const extractionAfter = afterStatus.find((s) => s.stage === 'extraction');
      expect(extractionAfter?.status).toBe('pending');
    });
  });
});
