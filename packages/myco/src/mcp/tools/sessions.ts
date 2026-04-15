/**
 * myco_sessions — list past coding sessions with summaries.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';
import { buildEndpoint } from './shared.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionsInput {
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

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSessions(
  input: SessionsInput,
  client: DaemonClient,
): Promise<SessionSummary[]> {
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
