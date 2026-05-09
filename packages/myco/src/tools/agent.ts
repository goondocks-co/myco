/**
 * myco_agent — agent run read surface.
 *
 * Mirrors GET /api/agent/runs and GET /api/agent/runs/:id so agents can see
 * their own token budget, cost, reasoning level, and phase checkpoints.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { extractErrorMessage } from './error.js';
import { buildEndpoint } from './shared.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';

export type AgentOp = 'runs' | 'run';

export interface AgentInput {
  op?: AgentOp;
  id?: string;
  task?: string;
  agent_id?: string;
  limit?: number;
}

export interface AgentHandlerResult {
  ok: boolean;
  op: AgentOp;
  data?: unknown;
  error?: string;
}

export async function handleMycoAgent(
  input: AgentInput,
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<AgentHandlerResult> {
  const op = input.op ?? 'runs';

  if (op === 'run') {
    if (!input.id) {
      return { ok: false, op, error: 'id is required for op: run' };
    }
    const endpoint = `/api/agent/runs/${encodeURIComponent(input.id)}`;
    const result = requestContext
      ? await client.get(endpoint, { headers: requestContextHeaders(requestContext) })
      : await client.get(endpoint);
    if (!result.ok) {
      return { ok: false, op, error: extractErrorMessage(result.data, 'fetch_failed') };
    }
    return { ok: true, op, data: result.data };
  }

  const endpoint = buildEndpoint('/api/agent/runs', {
    task: input.task,
    agentId: input.agent_id,
    limit: input.limit,
  });
  const result = requestContext
    ? await client.get(endpoint, { headers: requestContextHeaders(requestContext) })
    : await client.get(endpoint);
  if (!result.ok) {
    return { ok: false, op, error: extractErrorMessage(result.data, 'fetch_failed') };
  }
  return { ok: true, op, data: result.data };
}
