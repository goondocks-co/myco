/**
 * myco_sessions — list or retrieve past coding sessions.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface SessionSummary {
  id: string;
  agent: string;
  user: string | null;
  branch: string | null;
  started_at: number;
  ended_at: number | null;
  status: string;
  title: string | null;
  summary: string;
  prompt_count: number;
  tool_count: number;
  parent_session_id: string | null;
}

interface SessionGetFailure {
  ok: false;
  error: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSessions(
  input: SessionsInput,
  client: DaemonClient,
): Promise<SessionSummary[] | unknown | SessionGetFailure> {
  const op = input.op ?? 'list';
  if (op === 'get') {
    if (!input.id) return { ok: false, error: 'id is required for op: get' };
    const result = await client.get(`/api/sessions/${encodeURIComponent(input.id)}`);
    if (!result.ok || !result.data) return { ok: false, error: 'Session not found' };
    return result.data;
  }

  const endpoint = buildEndpoint('/api/mcp/sessions', {
    plan: input.plan,
    branch: input.branch,
    user: input.user,
    since: input.since,
    status: input.status,
    limit: input.limit,
  });
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.sessions) return [];

  return result.data.sessions as SessionSummary[];
}
