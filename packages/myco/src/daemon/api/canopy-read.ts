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
// /canopy/entries — list / detail / reembed
// ---------------------------------------------------------------------------

export interface CanopyEntriesListArgs {
  project_id: string;
  limit?: number;
  offset?: number;
  language?: string;
  described?: boolean;
  embedded?: boolean;
  path_prefix?: string;
}

export interface CanopyEntriesListResult {
  rows: Array<Record<string, unknown>>;
  total: number;
  limit: number;
  offset: number;
}

export async function handleCanopyEntriesList(
  args: CanopyEntriesListArgs,
): Promise<CanopyEntriesListResult> {
  const db = getDatabase();
  const where: string[] = ['project_id = ?'];
  const params: unknown[] = [args.project_id];
  if (args.language !== undefined)    { where.push('language = ?');                params.push(args.language); }
  if (args.described === true)        { where.push('llm_description IS NOT NULL'); }
  if (args.described === false)       { where.push('llm_description IS NULL'); }
  if (args.embedded === true)         { where.push('embedded = 1'); }
  if (args.embedded === false)        { where.push('embedded = 0'); }
  if (args.path_prefix !== undefined) { where.push('path LIKE ?');                  params.push(`${args.path_prefix}%`); }

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const rows = db.prepare(
    `SELECT * FROM canopy_entries
      WHERE ${where.join(' AND ')}
      ORDER BY path ASC
      LIMIT ? OFFSET ?`,
  ).all(...params, limit, offset) as Array<Record<string, unknown>>;
  const total = (db.prepare(
    `SELECT COUNT(*) AS n FROM canopy_entries WHERE ${where.join(' AND ')}`,
  ).get(...params) as { n: number }).n;

  return { rows, total, limit, offset };
}

export async function handleCanopyEntryGet(
  args: { project_id: string; path: string },
): Promise<Record<string, unknown>> {
  const row = getDatabase().prepare(
    `SELECT * FROM canopy_entries WHERE project_id = ? AND path = ?`,
  ).get(args.project_id, args.path) as Record<string, unknown> | undefined;
  if (!row) throw new Error(`Canopy entry not found: ${args.path}`);
  return row;
}

export async function handleCanopyEntryReembed(
  args: { project_id: string; path: string },
): Promise<{ ok: true }> {
  const result = getDatabase().prepare(
    `UPDATE canopy_entries SET embedded = 0 WHERE project_id = ? AND path = ?`,
  ).run(args.project_id, args.path);
  if (result.changes === 0) throw new Error(`Canopy entry not found: ${args.path}`);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Route adapters for /canopy/entries
// ---------------------------------------------------------------------------

function parseIntQuery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : undefined;
}

function parseStringQuery(value: string | undefined): string | undefined {
  if (value === undefined || value === '') return undefined;
  return value;
}

function parseBooleanQuery(value: string | undefined): boolean | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'true' || value === '1') return true;
  if (value === 'false' || value === '0') return false;
  return undefined;
}

/**
 * Strip the `/api/canopy/entries/` prefix from a pathname to recover the
 * URL-encoded canopy path (which may contain `/`). Returns the decoded
 * project-relative path, or null if the pathname doesn't start with the
 * expected prefix or has no remainder.
 */
function extractEntryPath(pathname: string, prefix: string): string | null {
  if (!pathname.startsWith(prefix)) return null;
  const rest = pathname.slice(prefix.length);
  if (!rest) return null;
  try {
    return decodeURIComponent(rest);
  } catch {
    return null;
  }
}

/**
 * Build the route adapters that bind handlers to the daemon's current
 * project_id. Kept as a factory so the daemon can inject its vaultDir-derived
 * projectId at registration time — matching the createCanopyInjectHandler
 * pattern used elsewhere in this file's neighborhood.
 */
function makeEntriesRouteHandlers(deps: { resolveProjectId: () => string }) {
  const listHandler: RouteHandler = async (req) => {
    const args: CanopyEntriesListArgs = {
      project_id: deps.resolveProjectId(),
      limit:       parseIntQuery(req.query.limit),
      offset:      parseIntQuery(req.query.offset),
      language:    parseStringQuery(req.query.language),
      described:   parseBooleanQuery(req.query.described),
      embedded:    parseBooleanQuery(req.query.embedded),
      path_prefix: parseStringQuery(req.query.path_prefix),
    };
    return { body: await handleCanopyEntriesList(args) };
  };

  // The entry path may contain '/', which the param router can't capture in
  // a single segment. We mount the get/reembed routes as `/api/canopy/entries/*`
  // prefix routes and recover the rest of the URL from the pathname.
  const reembedSuffix = '/reembed';
  const getHandler: RouteHandler = async (req) => {
    const path = extractEntryPath(req.pathname, '/api/canopy/entries/');
    if (!path) return badRequest('missing_path');
    try {
      const row = await handleCanopyEntryGet({ project_id: deps.resolveProjectId(), path });
      return { body: row };
    } catch (e) {
      return notFound((e as Error).message);
    }
  };

  const reembedHandler: RouteHandler = async (req) => {
    const raw = extractEntryPath(req.pathname, '/api/canopy/entries/');
    if (!raw || !raw.endsWith(reembedSuffix)) return badRequest('missing_path');
    const path = raw.slice(0, -reembedSuffix.length);
    if (!path) return badRequest('missing_path');
    try {
      return { body: await handleCanopyEntryReembed({ project_id: deps.resolveProjectId(), path }) };
    } catch (e) {
      return notFound((e as Error).message);
    }
  };

  return { listHandler, getHandler, reembedHandler };
}

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
}, deps?: { resolveProjectId: () => string }): void {
  server.registerRoute('GET', '/api/sessions/:id/canopy', handleGetSessionCanopy);
  server.registerRoute(
    'GET',
    '/api/sessions/:id/canopy/tool-calls/:tcId/blob',
    handleGetCanopyToolCallBlob,
  );
  server.registerRoute('GET', '/api/canopy/rollup', handleGetCanopyRollup);

  // /canopy/entries routes need a project_id resolver. Existing tests register
  // canopy-read routes without deps; skip the entries routes when no resolver
  // is supplied to avoid breaking older callers.
  if (deps) {
    const { listHandler, getHandler, reembedHandler } = makeEntriesRouteHandlers(deps);
    server.registerRoute('GET',  '/api/canopy/entries',    listHandler);
    // Wildcard prefix routes. The Router matches `/*` after exact and param
    // routes, and the entry-path may contain '/' which a `:path` param cannot
    // capture in a single segment. Order of registration doesn't matter — the
    // get vs reembed dispatch happens inside extractEntryPath/the handler
    // checking for the `/reembed` suffix.
    server.registerRoute('POST', '/api/canopy/entries/*',  reembedHandler);
    server.registerRoute('GET',  '/api/canopy/entries/*',  getHandler);
  }
}
