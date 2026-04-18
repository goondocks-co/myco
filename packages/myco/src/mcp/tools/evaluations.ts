/**
 * myco_evaluations — agent evaluation (matrix) read + create surface.
 *
 * Mirrors /api/agent/evaluations so agents can:
 *   - list recent evaluations (newest-first, paginated)
 *   - fetch one evaluation with its child runs + aggregate
 *   - create a new evaluation that fans out a single task across a matrix
 *     of (runtime × reasoning × model) cells
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';
import { extractErrorMessage } from './error.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EvaluationsOp = 'list' | 'get' | 'create';

export interface EvaluationsInput {
  op?: EvaluationsOp;
  // list filters
  status?: string;
  limit?: number;
  // get
  id?: string;
  // create
  task_id?: string;
  matrix?: unknown;
  notes?: string;
}

export interface EvaluationsHandlerResult {
  ok: boolean;
  op: EvaluationsOp;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoEvaluations(
  input: EvaluationsInput,
  client: DaemonClient,
): Promise<EvaluationsHandlerResult> {
  const op = input.op ?? 'list';

  if (op === 'get') {
    if (!input.id) {
      return { ok: false, op, error: 'id is required for op: get' };
    }
    const result = await client.get(
      `/api/agent/evaluations/${encodeURIComponent(input.id)}`,
    );
    if (!result.ok) {
      return {
        ok: false,
        op,
        error: extractErrorMessage(result.data, 'not_found'),
      };
    }
    return { ok: true, op, data: result.data };
  }

  if (op === 'create') {
    if (!input.task_id) {
      return { ok: false, op, error: 'task_id is required for op: create' };
    }
    if (input.matrix === undefined || input.matrix === null) {
      return { ok: false, op, error: 'matrix is required for op: create' };
    }
    const body: Record<string, unknown> = {
      taskId: input.task_id,
      matrix: input.matrix,
    };
    if (input.notes !== undefined) body.notes = input.notes;

    const result = await client.post('/api/agent/evaluations', body);
    if (!result.ok) {
      return {
        ok: false,
        op,
        error: extractErrorMessage(result.data, 'create_failed'),
      };
    }
    return { ok: true, op, data: result.data };
  }

  // op === 'list'
  const endpoint = buildEndpoint('/api/agent/evaluations', {
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);
  if (!result.ok) {
    return {
      ok: false,
      op,
      error: extractErrorMessage(result.data, 'fetch_failed'),
    };
  }
  return { ok: true, op, data: result.data };
}
