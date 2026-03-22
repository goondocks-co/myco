/**
 * myco_sessions — list past coding sessions with summaries.
 *
 * Delegates to PGlite `listSessions()` query helper.
 */

import { listSessions, type SessionRow } from '@myco/db/queries/sessions.js';
import { MCP_SESSIONS_DEFAULT_LIMIT, SESSION_SUMMARY_PREVIEW_CHARS } from '@myco/constants.js';

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
// Helpers
// ---------------------------------------------------------------------------

function toSummary(row: SessionRow): SessionSummary {
  return {
    id: row.id,
    agent: row.agent,
    user: row.user,
    branch: row.branch,
    started_at: row.started_at,
    ended_at: row.ended_at,
    status: row.status,
    title: row.title,
    summary: (row.summary ?? '').slice(0, SESSION_SUMMARY_PREVIEW_CHARS),
    prompt_count: row.prompt_count,
    tool_count: row.tool_count,
    parent_session_id: row.parent_session_id,
  };
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handleMycoSessions(
  input: SessionsInput,
): Promise<SessionSummary[]> {
  const rows = await listSessions({
    limit: input.limit ?? MCP_SESSIONS_DEFAULT_LIMIT,
    status: input.status,
  });

  return rows.map(toSummary);
}
