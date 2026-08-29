/**
 * Agent runs, read through the product surface.
 *
 * The member routes under `/runs` serve the harness that drives a run; these
 * serve the people who read what it did. An empty page is a project that has
 * run nothing, and 404 is a project this caller may not see — never the
 * other way round.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { listReports } from '../core/runs.js';
import { getRunDetail, listRuns } from '../read/runs.js';
import { badRequest, notFound, ok, resolveProjectScope } from './scope.js';
import { paging } from './sessions.js';

/** The longest run id or filter value admitted, matching the identifier bound the run routes apply. */
const MAX_ID_CHARS = 192;

/**
 * The run id a path segment names. The harness mints UUIDs, and the claim route
 * admits any non-empty id within the identifier bound, so the segment is decoded
 * and bounded rather than matched against a narrower grammar that would list a
 * run and then never open it.
 */
function runIdParam(raw: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  return decoded.length > 0 && decoded.length <= MAX_ID_CHARS ? decoded : null;
}

/** A filter value from the query, absent when not given, or a refusal when it exceeds the identifier bound. */
function filterParam(url: URL, name: string): string | undefined | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (raw.length === 0 || raw.length > MAX_ID_CHARS) return badRequest(`${name} must be 1 to ${MAX_ID_CHARS} characters`);
  return raw;
}

export async function handleProjectRuns(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const page = paging(ctx.url);
  if (page instanceof Response) return page;
  const status = filterParam(ctx.url, 'status');
  if (status instanceof Response) return status;
  const task = filterParam(ctx.url, 'task');
  if (task instanceof Response) return task;
  return ok(await listRuns(env.db, scope, { ...page, status, task }));
}

/** One run with its phases and reports. A run under another project answers 404, the same as one that never existed. */
export async function handleProjectRun(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const runId = runIdParam(ctx.params.runId ?? '');
  if (runId === null) return notFound();
  const detail = await getRunDetail(env.db, scope, runId);
  if (detail === null) return notFound();
  return ok({ ...detail, reports: await listReports(env.db, scope, runId), projectId: scope.projectId });
}
