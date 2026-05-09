/**
 * myco_sessions — list or retrieve past coding sessions.
 *
 * `op:list` reads via the in-process service in `sessions/list-for-mcp.ts`.
 * `op:get` proxies through the daemon's `/api/sessions/:id` REST endpoint
 * (the surface the daemon UI also consumes).
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { listSessionsForMcp, type SessionSummary } from '@myco/sessions/list-for-mcp.js';
import { requestContextHeaders, type MycoRequestContext } from './request-context.js';
import type { ToolFailure } from './error.js';

interface SessionsInput {
  op?: 'list' | 'get';
  id?: string;
  plan?: string;
  branch?: string;
  user?: string;
  since?: string;
  status?: string;
  limit?: number;
}

export async function handleMycoSessions(
  input: SessionsInput,
  client: DaemonClient,
  requestContext?: MycoRequestContext,
): Promise<SessionSummary[] | unknown | ToolFailure> {
  const op = input.op ?? 'list';
  if (op === 'get') {
    if (!input.id) return { ok: false, error: 'id is required for op: get' };
    const endpoint = `/api/sessions/${encodeURIComponent(input.id)}`;
    const result = requestContext
      ? await client.get(endpoint, { headers: requestContextHeaders(requestContext) })
      : await client.get(endpoint);
    if (!result.ok || !result.data) return { ok: false, error: 'Session not found' };
    return result.data;
  }

  return listSessionsForMcp({
    plan: input.plan,
    branch: input.branch,
    user: input.user,
    since: input.since,
    status: input.status,
    limit: input.limit,
    requestContext,
  });
}
