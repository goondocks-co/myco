/**
 * myco_sessions — list past coding sessions with summaries.
 *
 * Proxies through the daemon HTTP API via DaemonClient.
 */

import type { DaemonClient } from '@myco/hooks/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SessionsInput {
  limit?: number;
  status?: string;
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
  const params = new URLSearchParams();
  if (input.limit) params.set('limit', String(input.limit));
  if (input.status) params.set('status', input.status);

  const qs = params.toString();
  const endpoint = qs ? `/api/mcp/sessions?${qs}` : '/api/mcp/sessions';
  const result = await client.get(endpoint);

  if (!result.ok || !result.data?.sessions) return [];

  return result.data.sessions as SessionSummary[];
}
