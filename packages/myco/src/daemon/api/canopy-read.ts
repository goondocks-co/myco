// Read-side daemon HTTP endpoints for the Canopy UI.

import type { RouteHandler, RouteRequest, RouteResponse } from '../router.js';
import { getSession } from '@myco/db/queries/sessions.js';
import { projectScopeFromRequestContext } from '@myco/tools/request-context.js';
import { CANOPY_ENTRIES_ORDER_BY, getCanopyToolCallContext, rollupCanopy } from '@myco/db/queries/canopy.js';
import { getSessionMycoToolCallCounts } from '@myco/db/queries/myco-tool-usage.js';
import type { CanopyEntry } from '@myco/db/schema.js';
import { getDatabase } from '@myco/db/client.js';
import { errorBody } from './error-envelope.js';
import { composeBlob } from '@myco/canopy/inject/compose.js';
import { relativizeForLookup } from './canopy-inject.js';
import { readCanopyMap } from '@myco/canopy/map/store.js';

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

  const session = getSession(sessionId, projectScopeFromRequestContext(req.requestContext));
  if (!session) return notFound('session');

  // Per-(tool, op) Myco tool-call counts, sourced from
  // `session_myco_tool_calls` (materialized at Stop from `activities`).
  // UI consumers read specific tools via `getMycoToolCallCount` from
  // `use-canopy.ts`.
  const mycoToolCalls = getSessionMycoToolCallCounts(sessionId);

  // Flat shape with column-name parity (see SessionCanopyAggregate in
  // packages/myco/ui/src/hooks/use-canopy.ts). Pre-feature sessions return
  // every canopy_* field as NULL; the UI hides the tile when that happens.
  return {
    body: {
      canopy_injections_offered: session.canopy_injections_offered,
      canopy_injection_total_tokens: session.canopy_injection_total_tokens,
      canopy_skips_after_injection: session.canopy_skips_after_injection,
      canopy_reads_after_injection: session.canopy_reads_after_injection,
      canopy_tokens_saved: session.canopy_tokens_saved,
      canopy_redundant_reads: session.canopy_redundant_reads,
      myco_tool_calls: mycoToolCalls,
    },
  };
};

export const handleGetCanopyToolCallBlob: RouteHandler = async (req) => {
  const sessionId = req.params.id;
  const tcIdRaw = req.params.tcId;
  if (!sessionId || !tcIdRaw) return badRequest('missing_param');
  const tcId = Number(tcIdRaw);
  if (!Number.isFinite(tcId)) return badRequest('invalid_tc_id');

  // Scope MUST come from request context: the previous null-scope read joined
  // activities → sessions across the entire Grove DB and let a caller fetch
  // a sibling project's source-code blob given only a session id + tcId.
  const scope = projectScopeFromRequestContext(req.requestContext);
  const ctx = getCanopyToolCallContext(scope, sessionId, tcId);
  if (!ctx) return notFound('tool_call');

  // The blob is regenerated from the canopy_entries row at request time so
  // the popover renders byte-for-byte what composeBlob() would produce
  // today. If the file's mechanical anatomy has advanced since the call,
  // the popover shows the current blob, not a stale snapshot — design
  // choice per the spec, and the same path the agent would now see.
  if (!ctx.project_id) return notFound('project_id_missing');
  const lookupPath = ctx.project_root
    ? relativizeForLookup(ctx.file_path, ctx.project_root)
    : ctx.file_path;
  const entry = findCanopyEntry(ctx.project_id, lookupPath);
  if (!entry) return notFound('entry_missing');

  return { body: { blob: composeBlob(entry) } };
};

export const handleGetCanopyRollup: RouteHandler = async (req) => {
  const since = parseEpochSeconds(req.query.since);
  const until = parseEpochSeconds(req.query.until);

  // Scope MUST come from the request context: an unscoped rollup aggregates
  // sessions across every project in the Grove DB.
  const scope = projectScopeFromRequestContext(req.requestContext);
  const r = rollupCanopy(scope, { since, until });
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

/** Allowed sort columns for `/canopy/entries`. Anything outside this list is
 *  rejected at the API boundary so we never interpolate user input into the
 *  ORDER BY clause. */
export const CANOPY_ENTRIES_SORT_BY = [
  'path',
  'language',
  'embedded',
  'llm_updated_at',
  'token_estimate',
] as const;
export type CanopyEntriesSortBy = (typeof CANOPY_ENTRIES_SORT_BY)[number];

export const CANOPY_ENTRIES_SORT_DIR = ['asc', 'desc'] as const;
export type CanopyEntriesSortDir = (typeof CANOPY_ENTRIES_SORT_DIR)[number];

export interface CanopyEntriesListArgs {
  project_id: string;
  limit?: number;
  offset?: number;
  language?: string;
  described?: boolean;
  embedded?: boolean;
  path_prefix?: string;
  /** Free-text substring match across `path` AND `llm_description`. */
  q?: string;
  sort_by?: CanopyEntriesSortBy;
  sort_dir?: CanopyEntriesSortDir;
}

/**
 * Escape SQL LIKE wildcards so users can search for literal `_`, `%`, and `\`.
 * Pairs with `ESCAPE '\\'` in the LIKE clause.
 */
function escapeLikePattern(input: string): string {
  return input.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
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
  // This site composes the canonical project_id scope with optional
  // language/embedded/path_prefix/q filters; the described===true branch
  // overlaps with describedCanopyEntriesPredicate() in @myco/db/queries/canopy.js,
  // but the rest of the matrix is structurally distinct enough that a unified
  // helper would leak abstraction.
  const where: string[] = ['project_id = ?'];
  const params: unknown[] = [args.project_id];
  if (args.language !== undefined)    { where.push('language = ?');                params.push(args.language); }
  if (args.described === true)        { where.push('llm_description IS NOT NULL'); }
  if (args.described === false)       { where.push('llm_description IS NULL'); }
  if (args.embedded === true)         { where.push('embedded = 1'); }
  if (args.embedded === false)        { where.push('embedded = 0'); }
  if (args.path_prefix !== undefined) {
    where.push("path LIKE ? ESCAPE '\\'");
    params.push(`${escapeLikePattern(args.path_prefix)}%`);
  }
  if (args.q !== undefined && args.q !== '') {
    const pattern = `%${escapeLikePattern(args.q)}%`;
    where.push("(path LIKE ? ESCAPE '\\' OR llm_description LIKE ? ESCAPE '\\')");
    params.push(pattern, pattern);
  }

  // Validate sort_by against the allowlist. Anything else is a 400 at the
  // route layer; passing through directly would let user input reach the SQL.
  const sortBy: CanopyEntriesSortBy = args.sort_by ?? 'path';
  if (!CANOPY_ENTRIES_SORT_BY.includes(sortBy)) {
    throw new Error(`invalid sort_by: ${args.sort_by}`);
  }
  const sortDir: CanopyEntriesSortDir = args.sort_dir ?? 'asc';
  if (!CANOPY_ENTRIES_SORT_DIR.includes(sortDir)) {
    throw new Error(`invalid sort_dir: ${args.sort_dir}`);
  }
  const sqlDir = sortDir === 'desc' ? 'DESC' : 'ASC';
  // Path is always the tiebreaker so pagination is stable within a sort key.
  // When the primary sort already IS path, we use the canonical multi-column
  // tiebreaker chain from CANOPY_ENTRIES_ORDER_BY.
  const orderBy = sortBy === 'path'
    ? CANOPY_ENTRIES_ORDER_BY.replace(/\bpath\s+ASC\b/, `path ${sqlDir}`)
    : `${sortBy} ${sqlDir}, path ASC`;

  const limit = args.limit ?? 50;
  const offset = args.offset ?? 0;
  const rows = db.prepare(
    `SELECT * FROM canopy_entries
      WHERE ${where.join(' AND ')}
      ORDER BY ${orderBy}
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

/**
 * Runner contract for handleCanopyEntryRedescribe. The route registration
 * supplies a real implementation that builds a single-row canopy-describe
 * instruction (params.canopy_entry_path = path) and dispatches via the agent
 * executor — same shape as runCanopyMapTask. Tests inject a stub so they
 * don't need to stand up the executor.
 */
export interface CanopyEntryRedescribeTaskRunner {
  runner: (input: {
    task: 'canopy-describe';
    params: { canopy_entry_path: string };
    project_id: string;
  }) => Promise<{ run_id: string }>;
}

/**
 * Enqueue a single-row canopy-describe run for the given path. We confirm
 * the row exists before dispatching so the caller gets a clean 404 instead
 * of an opaque agent failure when the path is wrong.
 */
export async function handleCanopyEntryRedescribe(
  args: { project_id: string; path: string },
  deps: CanopyEntryRedescribeTaskRunner,
): Promise<{ ok: true; run_id: string }> {
  const row = findCanopyEntry(args.project_id, args.path);
  if (!row) throw new Error(`Canopy entry not found: ${args.path}`);
  const { run_id } = await deps.runner({
    task: 'canopy-describe',
    // The single-row instruction builder uses the row's `path` as its
    // canopy_entry_path is the row path used by map-phase source.args templating.
    params: { canopy_entry_path: args.path },
    project_id: args.project_id,
  });
  return { ok: true, run_id };
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
 * Build the route adapters that bind handlers to the request project_id.
 * The daemon still supplies the resolver, but the adapters pass the current
 * request through so Grove-aware UI/API calls do not fall back to the daemon's
 * startup project after a project switch.
 */
function makeEntriesRouteHandlers(deps: {
  resolveProjectId: (req: RouteRequest) => string;
  /**
   * Optional runner for per-entry `/redescribe`. Tests that don't need the
   * action route (list/get/reembed only) can omit this; the redescribe
   * route is registered only when the runner is supplied.
   */
  runCanopyDescribeTask?: CanopyEntryRedescribeTaskRunner['runner'];
}) {
  const listHandler: RouteHandler = async (req) => {
    const sortByRaw = parseStringQuery(req.query.sort_by);
    if (sortByRaw !== undefined && !(CANOPY_ENTRIES_SORT_BY as readonly string[]).includes(sortByRaw)) {
      return badRequest(`invalid sort_by: ${sortByRaw}`);
    }
    const sortDirRaw = parseStringQuery(req.query.sort_dir);
    if (sortDirRaw !== undefined && !(CANOPY_ENTRIES_SORT_DIR as readonly string[]).includes(sortDirRaw)) {
      return badRequest(`invalid sort_dir: ${sortDirRaw}`);
    }
    const args: CanopyEntriesListArgs = {
      project_id: deps.resolveProjectId(req),
      limit:       parseIntQuery(req.query.limit),
      offset:      parseIntQuery(req.query.offset),
      language:    parseStringQuery(req.query.language),
      described:   parseBooleanQuery(req.query.described),
      embedded:    parseBooleanQuery(req.query.embedded),
      path_prefix: parseStringQuery(req.query.path_prefix),
      q:           parseStringQuery(req.query.q),
      sort_by:     sortByRaw as CanopyEntriesSortBy | undefined,
      sort_dir:    sortDirRaw as CanopyEntriesSortDir | undefined,
    };
    return { body: await handleCanopyEntriesList(args) };
  };

  // The entry path may contain '/', which the param router can't capture in
  // a single segment. We mount the get/reembed/redescribe routes as
  // `/api/canopy/entries/*` prefix routes and recover the rest of the URL
  // from the pathname. The action suffix list is checked in the get handler
  // so a wrong-method GET surfaces as a clear 404 instead of an opaque lookup
  // miss.
  const reembedSuffix = '/reembed';
  const redescribeSuffix = '/redescribe';
  const actionSuffixes = [reembedSuffix, redescribeSuffix];
  const getHandler: RouteHandler = async (req) => {
    const path = extractEntryPath(req.pathname, '/api/canopy/entries/');
    if (!path) return badRequest('missing_path');
    // Guard action suffixes explicitly. A GET to `/foo.ts/reembed` would
    // otherwise fall through to a row lookup that would 404 for the wrong
    // reason — make the wrong-method case visible to the caller.
    for (const suffix of actionSuffixes) {
      if (path.endsWith(suffix)) {
        return notFound(`Use POST for ${suffix.slice(1)} action`);
      }
    }
    try {
      const row = await handleCanopyEntryGet({ project_id: deps.resolveProjectId(req), path });
      return { body: row };
    } catch (e) {
      return notFound((e as Error).message);
    }
  };

  // Single POST handler for both action suffixes — the action lives in the
  // URL suffix so the dispatch happens here. Keeps the prefix-route
  // registration simple (one POST `/api/canopy/entries/*`).
  const actionHandler: RouteHandler = async (req) => {
    const raw = extractEntryPath(req.pathname, '/api/canopy/entries/');
    if (!raw) return badRequest('missing_path');
    if (raw.endsWith(reembedSuffix)) {
      const path = raw.slice(0, -reembedSuffix.length);
      if (!path) return badRequest('missing_path');
      try {
        return { body: await handleCanopyEntryReembed({ project_id: deps.resolveProjectId(req), path }) };
      } catch (e) {
        return notFound((e as Error).message);
      }
    }
    if (raw.endsWith(redescribeSuffix)) {
      const path = raw.slice(0, -redescribeSuffix.length);
      if (!path) return badRequest('missing_path');
      const runner = deps.runCanopyDescribeTask;
      if (!runner) return notFound('redescribe action not available');
      try {
        return {
          body: await handleCanopyEntryRedescribe(
            { project_id: deps.resolveProjectId(req), path },
            { runner },
          ),
        };
      } catch (e) {
        return notFound((e as Error).message);
      }
    }
    return badRequest('unknown_action');
  };

  return { listHandler, getHandler, actionHandler };
}

// ---------------------------------------------------------------------------
// /canopy/map — get current map / regenerate
// ---------------------------------------------------------------------------

const CANOPY_MAP_EMPTY_STATE_MESSAGE = 'No Canopy Map yet.';

export interface CanopyMapGetArgs {
  project_id: string;
  machine_id: string;
}

export interface CanopyMapGetResult {
  content: string;
  is_empty?: true;
  message?: string;
  generated_at?: number;
  token_estimate?: number;
  inputs_hash?: string;
}

export interface CanopyMapRegenerateArgs {
  project_id: string;
  machine_id: string;
  force_cold_start: boolean;
}

export interface CanopyMapRegenerateResult {
  ok: true;
  /** Present when a run was enqueued. */
  run_id?: string;
  /** True when the regenerate was a no-op — see `reason` for why. */
  skipped?: boolean;
  /**
   * Machine-readable skip reason from buildCanopyMapInstructionDetailed:
   * 'no_project_root' | 'canopy_disabled' | 'no_described_entries' |
   * 'inputs_unchanged'. Kept as a free-form string in the wire shape so
   * future skip reasons don't require a coordinated UI deploy.
   */
  reason?: string;
}

/**
 * Runner contract for handleCanopyMapRegenerate. The route registration
 * supplies a real implementation that builds the canopy-map instruction
 * and dispatches via the agent executor (mirroring the
 * /api/agent/run path); tests inject a stub so they don't need to stand
 * up the executor.
 *
 * The runner returns a skip envelope when the build short-circuits (no
 * described entries, canopy disabled, inputs unchanged) so the handler
 * can surface the reason to the UI instead of running the LLM phase
 * with no instruction — which would crash in finalizeCanopyMap because
 * runContext.canopy_map_inputs_hash never got set.
 */
export interface CanopyMapTaskRunner {
  runner: (input: {
    task: 'canopy-map';
    params: { force_cold_start: boolean };
    project_id: string;
    machine_id: string;
  }) => Promise<{ run_id: string } | { skipped: true; reason: string }>;
}

export async function handleCanopyMapGet(args: CanopyMapGetArgs): Promise<CanopyMapGetResult> {
  const row = readCanopyMap(args.project_id, args.machine_id);
  if (!row) {
    return {
      is_empty: true,
      content: '',
      message: CANOPY_MAP_EMPTY_STATE_MESSAGE,
    };
  }
  return {
    content: row.content,
    generated_at: row.generated_at,
    token_estimate: row.token_estimate,
    inputs_hash: row.inputs_hash,
  };
}

export async function handleCanopyMapRegenerate(
  args: CanopyMapRegenerateArgs,
  deps: CanopyMapTaskRunner,
): Promise<CanopyMapRegenerateResult> {
  const result = await deps.runner({
    task: 'canopy-map',
    params: { force_cold_start: args.force_cold_start === true },
    project_id: args.project_id,
    machine_id: args.machine_id,
  });
  if ('skipped' in result) {
    return { ok: true, skipped: true, reason: result.reason };
  }
  return { ok: true, run_id: result.run_id };
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
export interface CanopyReadRouteDeps {
  resolveProjectId: (req: RouteRequest) => string;
  /**
   * Optional resolver for the daemon's machine identity. Required by the
   * /canopy/map routes; when omitted, those routes are not registered.
   */
  resolveMachineId?: (req: RouteRequest) => string;
  /**
   * Optional runner for /canopy/map/regenerate. The daemon supplies an
   * implementation that builds the canopy-map instruction and dispatches
   * via the agent executor (parallel to the /api/agent/run path); tests
   * can register the get-only route by omitting this.
   */
  runCanopyMapTask?: CanopyMapTaskRunner['runner'];
  /**
   * Optional runner for per-entry `/redescribe`. Same dispatch shape as
   * runCanopyMapTask, but for canopy-describe single-row mode. Tests that
   * don't exercise the action can omit this.
   */
  runCanopyDescribeTask?: CanopyEntryRedescribeTaskRunner['runner'];
}

export function registerCanopyReadRoutes(server: {
  registerRoute(method: string, pattern: string, handler: RouteHandler): void;
}, deps?: CanopyReadRouteDeps): void {
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
    const { listHandler, getHandler, actionHandler } = makeEntriesRouteHandlers({
      resolveProjectId: deps.resolveProjectId,
      runCanopyDescribeTask: deps.runCanopyDescribeTask,
    });
    server.registerRoute('GET',  '/api/canopy/entries',    listHandler);
    // Wildcard prefix routes. The Router matches `/*` after exact and param
    // routes, and the entry-path may contain '/' which a `:path` param cannot
    // capture in a single segment. Order of registration doesn't matter — the
    // get vs action dispatch happens inside the action handler by inspecting
    // the URL suffix (`/reembed` vs `/redescribe`).
    server.registerRoute('POST', '/api/canopy/entries/*',  actionHandler);
    server.registerRoute('GET',  '/api/canopy/entries/*',  getHandler);
  }

  // /canopy/map routes need both a project_id resolver and a machine_id
  // resolver; regenerate additionally needs the task runner. The map is
  // keyed (project_id, machine_id) at write time, so reads must use the
  // same identity to avoid silently returning the empty-state envelope.
  if (deps?.resolveMachineId) {
    const resolveProjectId = deps.resolveProjectId;
    const resolveMachineId = deps.resolveMachineId;

    const getMapHandler: RouteHandler = async (req) => ({
      body: await handleCanopyMapGet({
        project_id: resolveProjectId(req),
        machine_id: resolveMachineId(req),
      }),
    });
    server.registerRoute('GET', '/api/canopy/map', getMapHandler);

    if (deps.runCanopyMapTask) {
      const runCanopyMapTask = deps.runCanopyMapTask;
      const regenerateHandler: RouteHandler = async (req) => {
        const body = (req.body ?? {}) as { force_cold_start?: unknown };
        const force_cold_start = body.force_cold_start === true;
        const result = await handleCanopyMapRegenerate(
          {
            project_id: resolveProjectId(req),
            machine_id: resolveMachineId(req),
            force_cold_start,
          },
          { runner: runCanopyMapTask },
        );
        return { body: result };
      };
      server.registerRoute('POST', '/api/canopy/map/regenerate', regenerateHandler);
    }
  }
}
