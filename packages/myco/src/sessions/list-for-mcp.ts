/**
 * Session list with the MCP response shape (formerly GET /api/mcp/sessions).
 *
 * Wraps `listSessions` with: plan-id resolution to a single session, ISO date
 * parsing for the `since` filter, and the trimmed projection (summary preview,
 * dropping internal-only fields).
 */

import { MCP_SESSIONS_DEFAULT_LIMIT, SESSION_SUMMARY_PREVIEW_CHARS } from '@myco/constants.js';
import { getPlan } from '@myco/db/queries/plans.js';
import { listSessions } from '@myco/db/queries/sessions.js';

export interface SessionSummary {
  id: string;
  agent: string | null;
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

export interface ListSessionsForMcpInput {
  limit?: number;
  status?: string;
  branch?: string;
  user?: string;
  /** Plan id; resolves to that plan's session_id. Empty result if plan or session missing. */
  plan?: string;
  /** ISO-8601 string; parsed to epoch seconds. Invalid input yields no filter. */
  since?: string;
}

function isoToEpochSeconds(iso: string): number | undefined {
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? undefined : Math.floor(ms / 1000);
}

export function listSessionsForMcp(input: ListSessionsForMcpInput): SessionSummary[] {
  const limit = input.limit ?? MCP_SESSIONS_DEFAULT_LIMIT;
  const since = input.since ? isoToEpochSeconds(input.since) : undefined;

  let id: string | undefined;
  if (input.plan) {
    const planRow = getPlan(input.plan);
    if (!planRow || !planRow.session_id) return [];
    id = planRow.session_id;
  }

  const rows = listSessions({
    limit,
    status: input.status,
    branch: input.branch,
    user: input.user,
    since,
    id,
  });

  return rows.map((row) => ({
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
  }));
}
