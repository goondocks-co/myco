/**
 * myco_runs — agent run read surface.
 *
 * Mirrors GET /api/agent/runs and GET /api/agent/runs/:id so agents can see
 * their own token budget, cost, reasoning level, and phase checkpoints.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RunsOp = 'list' | 'get';

export interface RunsInput {
  op?: RunsOp;
  id?: string;
  task?: string;
  agent_id?: string;
  limit?: number;
}

export interface RunsHandlerResult {
  ok: boolean;
  op: RunsOp;
  data?: unknown;
  error?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoRuns(
  input: RunsInput,
  client: DaemonClient,
): Promise<RunsHandlerResult> {
  const op = input.op ?? 'list';

  if (op === 'get') {
    if (!input.id) {
      return { ok: false, op, error: 'id is required for op: get' };
    }
    const result = await client.get(
      `/api/agent/runs/${encodeURIComponent(input.id)}`,
    );
    if (!result.ok) {
      return { ok: false, op, error: 'not_found' };
    }
    return { ok: true, op, data: result.data };
  }

  // op === 'list' — defer the default limit to the HTTP route so the two
  // defaults can't drift. Only forward `limit` when the caller sets it.
  const endpoint = buildEndpoint('/api/agent/runs', {
    task: input.task,
    agentId: input.agent_id,
    limit: input.limit,
  });
  const result = await client.get(endpoint);
  if (!result.ok) {
    return { ok: false, op, error: 'fetch_failed' };
  }
  return { ok: true, op, data: result.data };
}
