// Read-side daemon HTTP endpoints for the Canopy UI.

import type { RouteHandler, RouteResponse } from '../router.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { getCanopyToolCallContext, rollupCanopy } from '@myco/db/queries/canopy.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { getDatabase } from '@myco/db/client.js';
import { errorBody } from './error-envelope.js';
import { composeBlob } from '@myco/canopy/inject/compose.js';
import { relativizeForLookup } from './canopy-inject.js';

function notFound(reason: string): RouteResponse {
  return { status: 404, body: errorBody('not_found', reason) };
}

function badRequest(reason: string): RouteResponse {
  return { status: 400, body: errorBody('bad_request', reason) };
}

function parseEpochSeconds(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function findCanopyEntry(projectId: string, path: string): CanopyEntry | null {
  const row = getDatabase()
    .prepare('SELECT * FROM canopy_entries WHERE project_id = ? AND path = ?')
    .get(projectId, path) as CanopyEntry | undefined;
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export const handleGetSessionCanopy: RouteHandler = async (req) => {
  const sessionId = req.params.id;
  if (!sessionId) return badRequest('missing_session_id');

  const session = getSession(sessionId);
  if (!session) return notFound('session');

  // Flat shape with column-name parity (see SessionCanopyAggregate in
  // packages/myco/ui/src/hooks/use-canopy.ts). Pre-feature sessions return
  // every field as NULL; the UI hides the tile when that happens.
  return {
    body: {
      canopy_injections_offered: session.canopy_injections_offered,
      canopy_injection_total_tokens: session.canopy_injection_total_tokens,
      canopy_skips_after_injection: session.canopy_skips_after_injection,
      canopy_reads_after_injection: session.canopy_reads_after_injection,
      canopy_tokens_saved: session.canopy_tokens_saved,
      canopy_redundant_reads: session.canopy_redundant_reads,
    },
  };
};

export const handleGetCanopyToolCallBlob: RouteHandler = async (req) => {
  const sessionId = req.params.id;
  const tcIdRaw = req.params.tcId;
  if (!sessionId || !tcIdRaw) return badRequest('missing_param');
  const tcId = Number(tcIdRaw);
  if (!Number.isFinite(tcId)) return badRequest('invalid_tc_id');

  const ctx = getCanopyToolCallContext(null, sessionId, tcId);
  if (!ctx) return notFound('tool_call');

  // The blob is regenerated from the canopy_entries row at request time so
  // the popover renders byte-for-byte what composeBlob() would produce
  // today. If the file's mechanical anatomy has advanced since the call,
  // the popover shows the current blob, not a stale snapshot — design
  // choice per the spec, and the same path the agent would now see.
  if (!ctx.project_id) return notFound('project_root_missing');
  const lookupPath = relativizeForLookup(ctx.file_path, ctx.project_id);
  const entry = findCanopyEntry(ctx.project_id, lookupPath);
  if (!entry) return notFound('entry_missing');

  return { body: { blob: composeBlob(entry) } };
};

export const handleGetCanopyRollup: RouteHandler = async (req) => {
  const since = parseEpochSeconds(req.query.since);
  const until = parseEpochSeconds(req.query.until);

  const r = rollupCanopy(null, { since, until });
  // Reshape for the UI (see CanopyRollup in use-canopy.ts). Field renames +
  // two derived metrics that are cheaper to compute here than in React.
  const sessionsWithCanopy = r.sessions_with_data ?? 0;
  const totalSaved = r.total_tokens_saved ?? 0;
  const totalOffered = r.total_injections_offered ?? 0;
  const totalSkips = r.total_skips_after_injection ?? 0;
  return {
    body: {
      total_tokens_saved: r.total_tokens_saved,
      sessions_with_canopy: r.sessions_with_data,
      avg_tokens_saved_per_session: sessionsWithCanopy > 0
        ? Math.round(totalSaved / sessionsWithCanopy)
        : null,
      total_injections_offered: r.total_injections_offered,
      total_skips_after_injection: r.total_skips_after_injection,
      injection_effectiveness_ratio: totalOffered > 0
        ? totalSkips / totalOffered
        : null,
    },
  };
};

// ---------------------------------------------------------------------------
// Wire-in helper
// ---------------------------------------------------------------------------

/**
 * Register the read-side Canopy routes on a Router-like server. Mirrors
 * the pattern used by other daemon/api/*.ts wirings.
 *
 * Canopy injection endpoints register separately via their own file; the two
 * registrations are non-overlapping so order doesn't matter.
 */
export function registerCanopyReadRoutes(server: {
  registerRoute(method: string, pattern: string, handler: RouteHandler): void;
}): void {
  server.registerRoute('GET', '/api/sessions/:id/canopy', handleGetSessionCanopy);
  server.registerRoute(
    'GET',
    '/api/sessions/:id/canopy/tool-calls/:tcId/blob',
    handleGetCanopyToolCallBlob,
  );
  server.registerRoute('GET', '/api/canopy/rollup', handleGetCanopyRollup);
}
