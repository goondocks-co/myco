/**
 * Read-side daemon HTTP endpoints for the Canopy UI.
 *
 * Three endpoints:
 *   GET /api/sessions/:id/canopy
 *     → per-session aggregate from the sessions row + the per-Read tool-call
 *       list with canopy_injection_tokens.
 *
 *   GET /api/sessions/:id/canopy/tool-calls/:tcId/blob
 *     → replays the injection blob the agent saw at PreToolUse time.
 *       Regenerates by looking up the canopy_entries row for the activity's
 *       file_path. Stable as long as the file's mechanical anatomy hasn't
 *       changed since the call ran. Returns the raw blob string under
 *       `blob`; UI renders verbatim for full transparency.
 *
 *   GET /api/canopy/rollup?since=&until=
 *     → cross-session aggregate: total tokens saved, average per session,
 *       skip ratio. Optional epoch-seconds time bounds.
 *
 * The blob endpoint depends on Track B's compose helper. Because Track B
 * lands in parallel, the import is dynamic and tolerated as missing — the
 * endpoint surfaces a clear `compose_unavailable` reason instead of 500'ing
 * when the helper isn't on main yet. Once Track B merges the import
 * resolves naturally and the fallback path goes cold.
 */

import type { RouteHandler, RouteResponse } from '../router.js';
import { getSession } from '@myco/db/queries/sessions.js';
import {
  listCanopyReads,
  getCanopyToolCallContext,
  rollupCanopy,
} from '@myco/db/queries/canopy.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { getDatabase } from '@myco/db/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function notFound(reason: string): RouteResponse {
  return { status: 404, body: { error: 'not_found', reason } };
}

function badRequest(reason: string): RouteResponse {
  return { status: 400, body: { error: 'bad_request', reason } };
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

/**
 * Try to load Track B's composeBlob helper. Returns null when the module
 * is unavailable (Track B not merged yet) so callers can degrade
 * gracefully instead of throwing. Cached after first lookup.
 */
let composeBlobLoader: Promise<((entry: CanopyEntry) => string) | null> | null = null;

function loadComposeBlob(): Promise<((entry: CanopyEntry) => string) | null> {
  if (composeBlobLoader) return composeBlobLoader;
  composeBlobLoader = (async () => {
    try {
      const mod = (await import('@myco/canopy/inject/compose.js' as string)) as {
        composeBlob?: (entry: CanopyEntry) => string;
      };
      return typeof mod.composeBlob === 'function' ? mod.composeBlob : null;
    } catch {
      return null;
    }
  })();
  return composeBlobLoader;
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

  if (!ctx.project_id) {
    return {
      body: {
        session_id: sessionId,
        activity_id: ctx.activity_id,
        file_path: ctx.file_path,
        injection_tokens: ctx.injection_tokens,
        blob: null,
        reason: 'no_project_root',
      },
    };
  }

  const entry = findCanopyEntry(ctx.project_id, ctx.file_path);
  if (!entry) {
    return {
      body: {
        session_id: sessionId,
        activity_id: ctx.activity_id,
        file_path: ctx.file_path,
        injection_tokens: ctx.injection_tokens,
        blob: null,
        reason: 'entry_missing',
      },
    };
  }

  const composeBlob = await loadComposeBlob();
  if (!composeBlob) {
    return {
      body: {
        session_id: sessionId,
        activity_id: ctx.activity_id,
        file_path: ctx.file_path,
        injection_tokens: ctx.injection_tokens,
        blob: null,
        reason: 'compose_unavailable',
      },
    };
  }

  return {
    body: {
      session_id: sessionId,
      activity_id: ctx.activity_id,
      file_path: ctx.file_path,
      injection_tokens: ctx.injection_tokens,
      blob: composeBlob(entry),
      reason: null,
    },
  };
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
 * Track B's canopy-inject endpoints register separately via their own
 * file; the two registrations are non-overlapping so order doesn't matter.
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
