/**
 * The run control plane over HTTP.
 *
 * The agent runs as a process inside a container, which is not a Worker and
 * holds no bindings, so this is how it reaches the store at all. The atomicity
 * stays in `core/runs.ts`: these handlers decide only how a request is asked for
 * and answered.
 *
 * `mutateState` cannot cross this boundary as one call — its argument is a
 * JavaScript callback. What crosses is the compare-and-swap it is built from:
 * the caller reads, computes, and offers the value it computed against as
 * `expected`. A write whose `expected` no longer matches is answered
 * `applied: false`, and the caller retries FROM THE READ. The decision still
 * happens in one statement here; only the loop is the caller's.
 *
 * Every response keys on `persisted`, the route's declared shape, which answers
 * whether the server accepted and acted on the request. The domain outcome —
 * `claimed`, `applied` — sits inside it. Collapsing the two would make
 * `claimed: false` mean both "another run holds this task" and "your request was
 * refused", which a caller cannot tell apart.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext, RouteContext } from '../context.js';
import { RUN_UPDATE_COLUMNS, applyRunUpdate, claimRun, getRun, isTerminalRunStatus, listAgents, markRunReplaced, type RunInsert, type RunUpdate, upsertAgent } from '../core/runs.js';
import { PROJECT_CAPABILITIES, type ProjectCapability } from '../core/settings.js';
import type { RunAdmissionGate, RunRow } from '../core/runs.js';
import { releaseRun } from '../core/release.js';
import { MAX_REPORT_DETAILS_CHARS as MAX_DETAILS_CHARS, MAX_REPORT_SUMMARY_CHARS as MAX_SUMMARY_CHARS, recordReport, runCloseRefusal } from '../core/run-postconditions.js';
import { recordShape, shapeRunError, strictId, strictName, strictRunId } from '@goondocks/myco-shared/run-text';
import { closeErrorCode, type RunErrorCode } from '../core/reader-codes.js';
import { HARNESS_MEMBER_ID, requeueReplaced, STALE_CREDENTIAL_REFUSAL } from '../core/harness.js';
import { refusal, type Refusal } from '../telemetry.js';
import { refused } from '../ingest/events.js';
import { badRequest, ok } from './scope.js';

/** The longest a task name or state key may be, matching the identifier bound the ingest envelope applies. */
const MAX_ID_CHARS = 192;
/** The largest state value this surface accepts, bounding one row against a caller that would grow it without limit. */
export const MAX_STATE_BYTES = 256 * 1024;

const BAD_BODY: Refusal = refusal('body is not an object', 'parse');

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_ID_CHARS): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= max ? v : null;
const strOrNull = (v: unknown, max = MAX_ID_CHARS): string | null | undefined =>
  v === undefined || v === null ? null : str(v, max) ?? undefined;
const int = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) ? v : null);
/** An identifier, null where none is given, or undefined where what is given is not one. */
const idOrNull = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : strictId(v) ?? undefined);
/** A name, null where none is given, or undefined where what is given is not one. */
const nameOrNull = (v: unknown): string | null | undefined => (v === undefined || v === null ? null : strictName(v) ?? undefined);

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Claim a run of a task: one row per run id, exactly once.
 *
 * `dispatchedBy` is taken from the authenticated credential and never from the
 * body: a caller that could name its own dispatcher could attribute its work to
 * another member.
 */
export async function handleClaimRun(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));

  const id = strictRunId(body.id);
  const agentId = strictName(body.agentId);
  const task = strictName(body.task);
  // The claim guards the run id alone; a field that once named an age floor is refused rather than ignored.
  if (body.maxAgeSeconds !== undefined) return Response.json(refused(ctx, refusal('claim takes no maxAgeSeconds', 'parse')));
  // A claim names the capability its task needs or declares capture-driven work.
  // Every claim must declare its admission.
  const admission: RunAdmissionGate | null =
    body.capability === undefined && body.captureDriven === true
      ? { kind: 'capture' }
      : (PROJECT_CAPABILITIES as readonly string[]).includes(body.capability as string)
        ? { kind: 'capability', capability: body.capability as ProjectCapability }
        : null;
  // An instruction is the Deployment's own, written at dispatch; no runtime sends one.
  if (body.instruction != null) return Response.json(refused(ctx, refusal('a claim carries no instruction: the Deployment writes a run\'s instruction when it dispatches it', 'field_retired')));
  const startedAt = int(body.startedAt) ?? ctx.now;
  const harness = nameOrNull(body.harness);
  const provider = nameOrNull(body.provider);
  const model = idOrNull(body.model);
  const runContext = body.runContext == null ? null : typeof body.runContext === 'string' && body.runContext.length <= MAX_STATE_BYTES ? recordShape(body.runContext, MAX_STATE_BYTES) ?? undefined : undefined;
  if (id === null || agentId === null || task === null || admission === null
    || harness === undefined || provider === undefined || model === undefined || runContext === undefined) {
    return Response.json(refused(ctx, refusal('claim requires an id, agentId and task each an identifier, either a known capability or captureDriven, and a runContext that is a JSON object', 'parse')));
  }

  const row: RunInsert = {
    id, agentId, task, instruction: null, harness, provider, model,
    dryRun: body.dryRun === true, startedAt, runContext, dispatchedBy: ctx.tokenId,
  };
  // The runtime member claims only a run the server dispatched under this credential.
  const embedding = task === 'embedding-reconcile';
  const outcome = await claimRun(env.db, { projectId: ctx.projectId }, row, {
    taskName: task, admission: embedding ? { kind: 'embedding' } : admission,
    dispatchedOnly: embedding || ctx.memberId === HARNESS_MEMBER_ID,
    ...(embedding ? { embeddingConfigured: env.vectors !== undefined && (await env.embeddingProvider?.()) != null } : {}),
  }, ctx.now);
  if (outcome.claimed) return Response.json({ persisted: true, claimed: true, runId: id });
  // A Project not admitted to the capability is a settled answer, not contention:
  // it names the capability so a caller reports what to enable rather than retrying.
  if (outcome.notAdmitted !== undefined) {
    return Response.json({ persisted: true, claimed: false, notAdmitted: outcome.notAdmitted });
  }
  // No provider configured is settled the same way: an operator supplies one, or
  // this task does not run. A caller retrying would never see it clear.
  if (outcome.noProvider === true) {
    return Response.json({ persisted: true, claimed: false, noProvider: true });
  }
  return Response.json({ persisted: true, claimed: false, running: outcome.running });
}

/**
 * Register the agent identity this Deployment runs under.
 *
 * `agents` is a Deployment definition, not Project data — one agent configuration
 * serves every Project the Deployment holds — so it is declared by the owner
 * rather than by the member that dispatches a run. An unregistered agent leaves
 * the run control plane with no identity to reference, and every claim fails a
 * foreign key — which a caller sees as a retryable 503 for a condition that
 * never clears.
 *
 * Idempotent: the installer and a later settings change both run the same write.
 */
export async function handleRegisterAgent(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const id = ctx.params.agentId;
  let body: unknown;
  try {
    body = await ctx.request.json();
  } catch {
    return badRequest('body is not json');
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return badRequest('body is not an object');
  const fields = body as Record<string, unknown>;
  const name = typeof fields.name === 'string' && fields.name.length > 0 && fields.name.length <= 192 ? fields.name : null;
  if (name === null) return badRequest('name is required');
  const optional = (key: string): string | null | undefined => {
    const v = fields[key];
    if (v === undefined || v === null) return null;
    return typeof v === 'string' && v.length <= 4096 ? v : undefined;
  };
  const provider = optional('provider');
  const model = optional('model');
  if (provider === undefined || model === undefined) return badRequest('provider and model must be strings');

  await upsertAgent(env.db, { id, name, provider, model, enabled: fields.enabled !== false }, ctx.now);
  return ok({ registered: true, id });
}

/** Every agent identity this Deployment holds. */
export async function handleAgents(env: ServerEnv, _ctx: OwnerContext): Promise<Response> {
  return ok({ agents: await listAgents(env.db) });
}

/**
 * Release what a dispatched run holds once it lands terminal: the container
 * hold ends so the instance drains, and the dispatch-minted credential is
 * revoked — it exists only for its run. Keyed on the run's own `dispatched_by`,
 * so a runtime writing a sibling run's status keeps its credential, and only
 * the credential that launched a container can end that container's hold.
 */
async function releaseDispatchedRun(env: ServerEnv, ctx: RouteContext, runId: string, status: unknown): Promise<void> {
  if (ctx.memberId !== HARNESS_MEMBER_ID) return;
  if (!isTerminalRunStatus(status)) return;
  const scope = { projectId: ctx.projectId };
  const run = await getRun(env.db, scope, runId);
  if (run === null || run.dispatchedBy !== ctx.tokenId) return;
  await releaseRun(env, scope, run, ctx.now);
}

/**
 * Record that a deployment ended this run, and stand one fresh run of the same
 * task in its place.
 *
 * The run's context belongs to the dispatcher and a runtime may not set it.
 * `replaced` is the single exception: a runtime that the platform is taking
 * away adds that one word through the failure it posts, and adds nothing else.
 * The word is what keeps the failed row out of the task's per-day count and
 * what names the successor's predecessor on the run the queue then holds.
 *
 * Only the runtime the dispatch minted a credential FOR may say it, keyed on
 * the run's own `dispatched_by` exactly as the release is. The word starts a
 * run on the Deployment's money: any other member holding a run id would turn
 * one failure into a dispatch nobody asked for. A caller that is not that
 * runtime marks nothing and queues nothing; its status update still stands, and
 * it is answered as the update route answers any other.
 */
async function recordReplacedRun(env: ServerEnv, ctx: RouteContext, runId: string): Promise<void> {
  const scope = { projectId: ctx.projectId };
  const run = await getRun(env.db, scope, runId);
  if (run === null || run.dispatchedBy !== ctx.tokenId) return;
  if (!(await markRunReplaced(env.db, scope, runId))) return;
  await requeueReplaced(env, { run, projectId: ctx.projectId, serverUrl: ctx.origin, actor: ctx.memberId }, ctx.now);
}

/** Whether a failure body asks for the one context word a runtime may add. */
const asksReplaced = (body: Record<string, unknown>, status: unknown): boolean => body.replaced === true && status === 'failed';

/** The answer a status change gets on a run that has already ended under a DIFFERENT ending: nothing moved, and the row's own ending stands. */
const TERMINAL_ANSWER = { persisted: true, changed: 0, applied: false, reason: 'terminal' } as const;
/** The answer a status change gets on a run already carrying that very status: nothing moved, and nothing needs to. */
const SETTLED_ANSWER = { persisted: true, changed: 0, applied: true } as const;

/**
 * What a status write answers on a run that has already ended, or nothing when
 * the run is still open.
 *
 * A repeat of the ending the row carries is the same close arriving twice — a
 * retried request, or a runtime offering its terminal status the second time the
 * update surface allows it — and it is answered as applied: the row says what
 * the caller asked it to say. A DIFFERENT ending is the race, and it is refused
 * by name.
 */
function endedAnswer(status: string | undefined, posted: unknown): Response | null {
  if (!isTerminalRunStatus(status)) return null;
  return Response.json(status === posted ? SETTLED_ANSWER : TERMINAL_ANSWER);
}

/**
 * What a terminal write answers when the caller is not the credential the run
 * is running under, or nothing when it is.
 *
 * Ending a run requires holding the credential its row names, exactly as
 * claiming it does. A launch answered too late is re-queued and offered again
 * under a fresh credential, so an earlier attempt's runtime — or the supervisor
 * closing for it — reaches this surface holding one the row has moved past; the
 * work its successor is doing is what the refusal protects. Every route that
 * writes a terminal status funnels through here, which
 * `tests/meta/queued-run-release-chokepoint.test.ts` holds.
 */
function foreignCredentialAnswer(ctx: RouteContext, before: RunRow | null): Response | null {
  if (ctx.memberId !== HARNESS_MEMBER_ID || before === null) return null;
  if (before.dispatchedBy === ctx.tokenId) return null;
  return Response.json(refused(ctx, refusal(STALE_CREDENTIAL_REFUSAL, 'refused')));
}

/** Either the refusal a write is answered with, or how many rows it moved. */
type RunWrite = { refused: Response } | { changed: number };

/**
 * Write a run's status as the caller, and release what the run held.
 *
 * The guard and the write are one act here, which is what keeps them together:
 * no route in this file reaches `applyRunUpdate` or `recordReplacedRun` on its
 * own, and `tests/meta/queued-run-release-chokepoint.test.ts` holds that. A
 * route that wrote a run terminal beside this one would be a route the
 * credential rule does not reach.
 */
async function endRunAsCaller(
  env: ServerEnv, ctx: RouteContext, runId: string, before: RunRow | null,
  update: RunUpdate, options: { replaced?: boolean; errorCode?: RunErrorCode } = {},
): Promise<RunWrite> {
  const foreign = foreignCredentialAnswer(ctx, before);
  if (foreign !== null) return { refused: foreign };
  const scope = { projectId: ctx.projectId };
  const changed = await applyRunUpdate(env.db, scope, runId, update, undefined, options.errorCode);
  if (changed === 1) {
    await releaseDispatchedRun(env, ctx, runId, update.status);
    if (options.replaced === true) await recordReplacedRun(env, ctx, runId);
  }
  return { changed };
}

/**
 * The columns a run's own update may set: those the in-process runtime writes when a run ends
 * (`packages/myco/src/agent/runtime/server-runner.ts`, its terminal status with `buildRunUsageUpdate`'s accounting, and
 * `recordRunFailure`) and the embedding run writes (`core/embedding/run.ts`). Every other column of the store is retired
 * on this route and refused by name.
 */
export const ROUTE_UPDATE_COLUMNS = [
  'status', 'completed_at', 'tokens_used', 'error', 'usage_data', 'cost_usd', 'actual_cost_usd', 'estimated_cost_usd', 'cost_source', 'cost_data',
] as const;
const NUMERIC_COLUMNS: ReadonlySet<string> = new Set(['completed_at', 'tokens_used', 'cost_usd', 'actual_cost_usd', 'estimated_cost_usd']);

/**
 * An update as this route stores it, or null where a value is outside its column's shape: an error kept as a coded
 * reason (`shapeRunError`), usage and cost data as structured records (`recordShape`), a cost source as an identifier,
 * a number as a number. Never the words a caller sent.
 */
function routeUpdate(update: Record<string, unknown>, harness: string | null): RunUpdate | null {
  const out: Record<string, unknown> = {};
  for (const [column, value] of Object.entries(update)) {
    if (value === null || column === 'status') { out[column] = value; continue; }
    if (NUMERIC_COLUMNS.has(column)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return null;
      out[column] = value;
    } else if (column === 'error') {
      if (typeof value !== 'string') return null;
      out[column] = shapeRunError(value, harness);
    } else if (column === 'cost_source') {
      const source = strictName(value);
      if (source === null) return null;
      out[column] = source;
    } else {
      const record = typeof value === 'string' && value.length <= MAX_STATE_BYTES ? recordShape(value, MAX_STATE_BYTES) : null;
      if (record === null) return null;
      out[column] = record;
    }
  }
  return out as RunUpdate;
}

/**
 * Apply a partial update to one run.
 *
 * A column outside `RUN_UPDATE_COLUMNS` is a refusal rather than a silent
 * ignore: a caller that believes it moved a run to another Project must be told
 * it did not, and an ignored field reads exactly like an applied one.
 *
 * A run closing as completed is held to what its task owes
 * (`core/run-postconditions.ts`): a close the evidence does not support is
 * recorded as a failure with what is missing, and the caller is told its update
 * did not land as asked.
 *
 * A run that has already ended keeps the ending it has. The store refuses the
 * status change in its own WHERE clause; this route reads the row back on a
 * write that moved nothing and answers `terminal`, so a container posting a
 * second ending learns the row is closed rather than reading the refusal as a
 * run in another Project. Posting the ending the row already carries is applied
 * rather than refused — a retry must be safe. An update carrying no status still
 * applies to a terminal row.
 */
export async function handleUpdateRun(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const update = body.update;
  if (runId === null || typeof update !== 'object' || update === null || Array.isArray(update)) {
    return Response.json(refused(ctx, refusal('update requires runId and an update object', 'parse')));
  }
  const settable = new Set<string>(RUN_UPDATE_COLUMNS);
  const rejected = Object.keys(update).filter((k) => !settable.has(k));
  if (rejected.length > 0) {
    return Response.json(refused(ctx, refusal(`update names columns it may not set: ${rejected.sort().join(', ')}`, 'refused')));
  }
  const retired = Object.keys(update).filter((k) => !(ROUTE_UPDATE_COLUMNS as readonly string[]).includes(k));
  if (retired.length > 0) {
    return Response.json(refused(ctx, refusal(`update names columns no runtime sets in 2.0: ${retired.sort().join(', ')}`, 'field_retired')));
  }
  const scope = { projectId: ctx.projectId };
  const guarded = 'status' in update;
  const row = await getRun(env.db, scope, runId);
  const before = guarded ? row : null;
  const runUpdate = routeUpdate(update as Record<string, unknown>, row?.harness ?? null);
  if (runUpdate === null) {
    return Response.json(refused(ctx, refusal('update holds a value outside its column\'s shape: an error is text, usage and cost data are JSON objects, a cost source an identifier, and the rest numbers', 'invalid_field')));
  }
  // Before anything else this route answers: a caller holding a credential the
  // row does not name learns that, rather than learning what the row ended as.
  const foreign = guarded ? foreignCredentialAnswer(ctx, before) : null;
  if (foreign !== null) return foreign;
  const settled = endedAnswer(before?.status, runUpdate.status);
  if (settled !== null) return settled;
  if (runUpdate.status === 'completed') {
    const missing = before === null ? null : await runCloseRefusal(env.db, scope, before);
    if (missing !== null) {
      const written = await endRunAsCaller(env, ctx, runId, before, { ...runUpdate, status: 'failed', completed_at: ctx.now, error: missing } as RunUpdate, { errorCode: closeErrorCode(missing) });
      if ('refused' in written) return written.refused;
      const raced = written.changed === 0 ? endedAnswer((await getRun(env.db, scope, runId))?.status, 'failed') : null;
      if (raced !== null) return raced;
      return Response.json({ persisted: true, changed: written.changed, applied: false, reason: 'postcondition' });
    }
  }
  const written = await endRunAsCaller(env, ctx, runId, guarded ? before : null, runUpdate, { replaced: asksReplaced(body, runUpdate.status) });
  if ('refused' in written) return written.refused;
  const changed = written.changed;
  if (changed === 1) return Response.json({ persisted: true, changed, applied: true });
  const raced = guarded ? endedAnswer((await getRun(env.db, scope, runId))?.status, runUpdate.status) : null;
  if (raced !== null) return raced;
  // A write that moved nothing says so: reporting a run as ended requires this
  // route to say the write landed.
  return Response.json({ persisted: true, changed, applied: false });
}

/**
 * Record one report against a run. The run row is the tenancy anchor;
 * `agentId` is the reporter's label and is not held to the run's own agent —
 * attribution of the WRITE stays with the authenticated credential.
 */
export async function handleWriteReport(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = strictId(body.runId);
  const agentId = strictName(body.agentId);
  const action = strictName(body.action);
  const summary = str(body.summary, MAX_SUMMARY_CHARS);
  const details = strOrNull(body.details, MAX_DETAILS_CHARS);
  if (runId === null || agentId === null || action === null || summary === null || details === undefined) {
    return Response.json(refused(ctx, refusal('a report requires a runId, agentId and action each an identifier, and a summary within bounds', 'parse')));
  }
  const recorded = await recordReport(env.db, { projectId: ctx.projectId }, { runId, agentId, action, summary, details, audit: body.audit, createdAt: ctx.now });
  if (!recorded.recorded) {
    return Response.json(refused(ctx, refusal(recorded.reason === 'unaccepted' ? recorded.error : 'report names a run this Project does not hold, or an agent this Deployment does not know', 'parse')));
  }
  return Response.json({ persisted: true, recorded: true, ...(recorded.auditError === null ? {} : { auditError: recorded.auditError }) });
}

/**
 * The run routes no 2.0 path sends, each refused with `route_retired` and what replaced it. The in-process runtime
 * claims, ends and reports a run (`server-runner.ts`: `/runs/claim`, `/runs/update`, `/runs/report`) and nothing else
 * over these; the routes below served the 1.4 executor's own store.
 */
export const RETIRED_RUN_ROUTES: Readonly<Record<string, string>> = {
  '/runs/get': 'a run is read on the dashboard and by `myco_agent`',
  '/runs/failed': 'a run ends through /runs/update',
  '/runs/resume-admission': 'a failed run is never resumed in 2.0; a fresh run is dispatched',
  '/runs/supersede': 'a failed run is never resumed in 2.0, so none is superseded',
  '/runs/reports': 'a run\'s reports are read on the dashboard and by `myco_agent`',
  '/runs/events': 'a run\'s calls are recorded by the Deployment as the run makes them',
};

/** A run route no 2.0 path sends, refused with what replaced it. */
export function retiredRunRoute(path: keyof typeof RETIRED_RUN_ROUTES & string): (env: ServerEnv, ctx: RouteContext) => Promise<Response> {
  const why = RETIRED_RUN_ROUTES[path]!;
  return async (_env, ctx) => Response.json(refused(ctx, refusal(`${path} is retired: ${why}`, 'route_retired')));
}
