import { fleetWaits } from '../db/runs/fleet.js';
import { redactSecrets } from '@goondocks/myco-shared/redact-secrets';
/**
 * Agent runs, read through the product surface.
 *
 * The member routes under `/runs` serve the harness that drives a run; these
 * serve the people who read what it did. An empty page is a project that has
 * run nothing, and 404 is a project this caller may not see — never the
 * other way round.
 */
import { isAdmin } from '../auth/roles.js';
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { RunBodyUnavailable, RunNotFound, listReportsWithBodies, runInstructionBody } from '../db/runs/bodies.js';
import { getRunCalls, getRunDetail, getRunSteps, listRuns } from '../read/runs.js';
import { runReads } from '../db/runs/reads.js';
import { badRequest, instantParam, notFound, ok, resolveProjectScope } from './scope.js';
import { RUN_CANCEL_POLICY, authorizeHttp } from '../auth/http-authorization.js';
import type { RunDetail } from '../read/runs.js';
import { paging } from './sessions.js';
import { MAX_SESSION_ID_CHARS } from '../core/spore-input-contract.js';

/** The run detail with the caller's cancellation decision. */
export type DashboardRunDetail = Omit<RunDetail, 'run'> & { run: RunDetail['run'] & { canCancel: boolean; cancelReason: string | null } };

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

/** The longest subject a claim writes: a session's learning or card subject, its prefix and the longest session id. */
const MAX_SUBJECT_CHARS = 'session:'.length + MAX_SESSION_ID_CHARS;

/** A filter value from the query, absent when not given, or a refusal when it exceeds `max` characters. */
function filterParam(url: URL, name: string, max = MAX_ID_CHARS): string | undefined | Response {
  const raw = url.searchParams.get(name);
  if (raw === null) return undefined;
  if (raw.length === 0 || raw.length > max) return badRequest(`${name} must be 1 to ${max} characters`);
  return raw;
}

/** The widest window a subject filter reads: the runs of one task in it are walked until a page of that subject fills. */
export const SUBJECT_WINDOW_MS = 86_400_000;

/**
 * The subject filter: `subject=<value>`, or `noSubject=1` for runs that name none. It reads one task's runs inside a
 * window of at most `SUBJECT_WINDOW_MS`, so the runs it passes over are bounded by that task's runs in one day.
 */
function subjectParam(url: URL, task: string | undefined, since: number | undefined, until: number | undefined): string | null | undefined | Response {
  const named = filterParam(url, 'subject', MAX_SUBJECT_CHARS);
  if (named instanceof Response) return named;
  const none = url.searchParams.get('noSubject');
  if (none !== null && none !== '1') return badRequest('noSubject must be 1 when given');
  if (named === undefined && none === null) return undefined;
  if (named !== undefined && none !== null) return badRequest('give subject or noSubject=1, not both');
  if (task === undefined || since === undefined || until === undefined || until - since > SUBJECT_WINDOW_MS)
    return badRequest(`a subject filter needs task, since and until at most ${SUBJECT_WINDOW_MS} ms apart; got ${task === undefined ? 'no task' : `task ${task}`}, ${since === undefined || until === undefined ? 'no full window' : `a window of ${until - since} ms`}`);
  return named ?? null;
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
  const since = instantParam(ctx.url, 'since');
  if (since instanceof Response) return since;
  const until = instantParam(ctx.url, 'until');
  if (until instanceof Response) return until;
  if (since !== undefined && until !== undefined && since >= until) return badRequest('since must be before until');
  const order = ctx.url.searchParams.get('order') ?? 'newest';
  if (order !== 'newest' && order !== 'oldest') return badRequest(`order must be newest or oldest, not ${JSON.stringify(order.slice(0, 40))}`);
  if (order === 'oldest' && since === undefined) return badRequest('order=oldest reads a window: give since (and optionally until)');
  const subject = subjectParam(ctx.url, task, since, until);
  if (subject instanceof Response) return subject;
  const answer = await listRuns(env.db, scope, ctx.now, ctx.member.id, { ...page, status, task, since, until, order, subject, includeSignIn: isAdmin(ctx.member.role) });
  const waits = await fleetWaits(env, answer.rows.filter(row => row.status === 'queued').map(row => row.task), ctx.now, isAdmin(ctx.member.role));
  return ok({ ...answer, rows: answer.rows.map(row => row.status === 'queued' ? { ...row, fleetWait: waits.get(row.task) } : row) });
}

/** One run with its phases and reports, the sessions it read and the spores it wrote. A run under another project answers 404, the same as one that never existed. */
export async function handleProjectRun(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const runId = runIdParam(ctx.params.runId ?? '');
  if (runId === null) return notFound();
  const callsUrl = new URL(ctx.url);
  callsUrl.search = '';
  const callsLimit = ctx.url.searchParams.get('callsLimit');
  const callsCursor = ctx.url.searchParams.get('callsCursor');
  if (callsLimit !== null) callsUrl.searchParams.set('limit', callsLimit);
  if (callsCursor !== null) callsUrl.searchParams.set('cursor', callsCursor);
  const calls = paging(callsUrl);
  if (calls instanceof Response) return calls;
  const detail = await getRunDetail(env.db, scope, runId, ctx.now, ctx.member.id, { ...calls, includeSignIn: isAdmin(ctx.member.role) });
  if (detail === null) return notFound();
  const canCancel = await authorizeHttp(env, RUN_CANCEL_POLICY, { memberId: ctx.member.id }, { params: { projectId: scope.projectId, runId } });
  const waits = await fleetWaits(env, detail.run.status === 'queued' ? [detail.run.task] : [], ctx.now, isAdmin(ctx.member.role));
  const answer: DashboardRunDetail = { ...detail, run: { ...detail.run, ...(detail.run.status === 'queued' ? { fleetWait: waits.get(detail.run.task) } : {}), canCancel,
    cancelReason: canCancel ? null : 'Only the member who requested this run or an administrator can cancel it.' } };
  try {
    const instruction = answer.run.instruction ?? await runInstructionBody(env, scope, runId);
    const reports = await listReportsWithBodies(env, scope, runId);
    return ok({ ...answer, run: { ...answer.run, instruction: instruction === null ? null : redactSecrets(instruction) }, reports: reports.reports, reportsHasMore: reports.hasMore, ...await runReads(env.db, scope, runId), projectId: scope.projectId });
  } catch (error) {
    if (error instanceof RunNotFound) return notFound();
    if (error instanceof RunBodyUnavailable) return Response.json({ error: error.code, retryable: error.retryable, message: error.message }, { status: 503 });
    throw error;
  }
}

/** One page of admitted calls, without the run's instructions, reports or current artifacts. */
export async function handleProjectRunCalls(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const runId = runIdParam(ctx.params.runId ?? '');
  if (runId === null) return notFound();
  const calls = paging(ctx.url);
  if (calls instanceof Response) return calls;
  const answer = await getRunCalls(env.db, scope, runId, calls);
  return answer === null ? notFound() : ok(answer);
}

/** One page of the step log one attempt's worker observed — the latest attempt unless `attempt` names another — in step order. */
export async function handleProjectRunSteps(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const scope = await resolveProjectScope(env.db, ctx.member, ctx.params.projectId);
  if (scope === null) return notFound();
  const runId = runIdParam(ctx.params.runId ?? '');
  if (runId === null) return notFound();
  const steps = paging(ctx.url);
  if (steps instanceof Response) return steps;
  const attempt = filterParam(ctx.url, 'attempt');
  if (attempt instanceof Response) return attempt;
  const answer = await getRunSteps(env.db, scope, runId, attempt, steps);
  return answer === null ? notFound() : ok(answer);
}
