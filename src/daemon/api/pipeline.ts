/**
 * API handlers for pipeline health, items, circuits, and retry operations.
 *
 * Each handler follows the thin-handler pattern: validate input,
 * delegate to PipelineManager, return RouteResponse.
 */

import { z } from 'zod';
import type { RouteRequest, RouteResponse } from '../router.js';
import type { PipelineManager } from '../pipeline.js';
import { PIPELINE_PROVIDER_ROLES } from '../../constants.js';

// --- Request body schemas ---

const RetryItemBody = z.object({
  type: z.string(),
  stage: z.string(),
});

// --- GET /api/pipeline/health ---

export function handlePipelineHealth(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async () => {
    const health = pipeline.health();
    return { body: health };
  };
}

// --- GET /api/pipeline/items ---

export function handlePipelineItems(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req) => {
    const { stage, status, type, limit, offset } = req.query;

    const parsedLimit = limit ? parseInt(limit, 10) : undefined;
    const parsedOffset = offset ? parseInt(offset, 10) : undefined;

    if (limit && (isNaN(parsedLimit!) || parsedLimit! < 0)) {
      return { status: 400, body: { error: 'invalid_limit', message: 'limit must be a non-negative integer' } };
    }
    if (offset && (isNaN(parsedOffset!) || parsedOffset! < 0)) {
      return { status: 400, body: { error: 'invalid_offset', message: 'offset must be a non-negative integer' } };
    }

    const result = pipeline.listItems({
      stage,
      status,
      type,
      limit: parsedLimit,
      offset: parsedOffset,
    });

    return { body: result };
  };
}

// --- GET /api/pipeline/items/:id ---

export function handlePipelineItemDetail(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req) => {
    const { id } = req.params;
    const { type } = req.query;

    if (!type) {
      return { status: 400, body: { error: 'missing_type', message: 'query param "type" is required' } };
    }

    const stages = pipeline.getItemStatus(id, type);
    if (stages.length === 0) {
      return { status: 404, body: { error: 'not_found', message: `No work item found: ${id} (${type})` } };
    }

    const history = pipeline.getTransitionHistory(id, type);

    return { body: { id, type, stages, history } };
  };
}

// --- GET /api/pipeline/circuits ---

export function handlePipelineCircuits(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async () => {
    const circuits = pipeline.listCircuits();
    return { body: circuits };
  };
}

// --- POST /api/pipeline/retry/:id ---

export function handlePipelineRetry(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req) => {
    const { id } = req.params;
    const parsed = RetryItemBody.safeParse(req.body);

    if (!parsed.success) {
      return { status: 400, body: { error: 'validation_failed', issues: parsed.error.issues } };
    }

    const { type, stage } = parsed.data;
    const retried = pipeline.retryItem(id, type, stage);

    if (!retried) {
      return { status: 404, body: { error: 'not_poisoned', message: `Item ${id} is not poisoned at stage ${stage}` } };
    }

    return { body: { retried: true, id, type, stage } };
  };
}

// --- POST /api/pipeline/retry-all ---

export function handlePipelineRetryAll(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async () => {
    const count = pipeline.retryAllPoisoned();
    return { body: { retried: count } };
  };
}

// --- POST /api/pipeline/circuit/:provider/reset ---

export function handlePipelineCircuitReset(pipeline: PipelineManager): (req: RouteRequest) => Promise<RouteResponse> {
  return async (req) => {
    const { provider } = req.params;

    if (!(PIPELINE_PROVIDER_ROLES as readonly string[]).includes(provider)) {
      return {
        status: 400,
        body: {
          error: 'unknown_provider',
          message: `Unknown provider role '${provider}'. Valid roles: ${PIPELINE_PROVIDER_ROLES.join(', ')}`,
        },
      };
    }

    pipeline.resetCircuit(provider);
    const unblocked = pipeline.unblockItemsForCircuit(provider);

    return { body: { reset: true, provider, unblocked } };
  };
}
