/**
 * Log explorer API handlers — search, stream (polling), detail, and external ingestion.
 */

import { z } from 'zod';
import { searchLogs, getLogsSince, getLogEntry } from '@myco/db/queries/logs.js';
import type { LogEntryRow } from '@myco/db/queries/logs.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { RouteRequest, RouteResponse, RouteHandler } from '../router.js';
import type { DaemonLogger } from '../logger.js';

// ---------------------------------------------------------------------------
// Search (historical mode)
// ---------------------------------------------------------------------------

export async function handleLogSearch(req: RouteRequest): Promise<RouteResponse> {
  const { q, level, component, kind, session_id, from, to, page, page_size } = req.query;

  const result = searchLogs({
    q: q || undefined,
    level: level || undefined,
    component: component || undefined,
    kind: kind || undefined,
    session_id: session_id || undefined,
    from: from || undefined,
    to: to || undefined,
    page: page ? parseInt(page, 10) : undefined,
    page_size: page_size ? parseInt(page_size, 10) : undefined,
  });

  return {
    body: {
      entries: result.entries.map(formatEntry),
      total: result.total,
      page: result.page,
      page_size: result.page_size,
    },
  };
}

// ---------------------------------------------------------------------------
// Stream (real-time polling mode)
// ---------------------------------------------------------------------------

export async function handleLogStream(req: RouteRequest): Promise<RouteResponse> {
  const sinceStr = req.query.since;
  const limitStr = req.query.limit;
  const sinceId = sinceStr ? parseInt(sinceStr, 10) : 0;
  const limit = limitStr ? parseInt(limitStr, 10) : undefined;

  const result = getLogsSince(sinceId, limit);

  return {
    body: {
      entries: result.entries.map(formatEntry),
      cursor: result.cursor,
    },
  };
}

// ---------------------------------------------------------------------------
// Detail (single entry with resolved references)
// ---------------------------------------------------------------------------

export async function handleLogDetail(req: RouteRequest): Promise<RouteResponse> {
  const id = parseInt(req.params.id, 10);
  if (isNaN(id)) return { status: 400, body: { error: 'Invalid log entry ID' } };

  const entry = getLogEntry(id);
  if (!entry) return { status: 404, body: { error: 'Log entry not found' } };

  const parsed = entry.data ? JSON.parse(entry.data) : {};
  const resolved: Record<string, unknown> = {};

  // Resolve session_id to session title
  if (entry.session_id) {
    try {
      const session = getSession(entry.session_id);
      if (session) {
        resolved.session_title = (session as { title?: string }).title ?? null;
      }
    } catch { /* session may not exist */ }
  }

  return {
    body: {
      ...entry,
      data: parsed,
      resolved,
    },
  };
}

// ---------------------------------------------------------------------------
// External log ingestion
// ---------------------------------------------------------------------------

const ExternalLogBody = z.object({
  level: z.enum(['debug', 'info', 'warn', 'error']),
  component: z.string(),
  message: z.string(),
  data: z.record(z.string(), z.unknown()).optional(),
});

/**
 * POST /api/log — parse ExternalLogBody and write through the daemon logger.
 * Allows the MCP server (separate process) to log through the daemon.
 */
export function createLogIngestionHandler(logger: DaemonLogger): RouteHandler {
  return async (req: RouteRequest): Promise<RouteResponse> => {
    const { level, component, message, data } = ExternalLogBody.parse(req.body);
    logger.log(level, LOG_KINDS.MCP_EVENT, message, { ...data, mcp_component: component });
    return { body: { ok: true } };
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatEntry(entry: LogEntryRow) {
  return {
    ...entry,
    data: entry.data ? JSON.parse(entry.data) : null,
  };
}
