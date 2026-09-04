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
import {
  applyRunUpdate, claimRun, DISPATCHER_OWNED_COLUMNS, getRun, getState, insertReport, isTerminalRunStatus, listAgents,
  listReports, markRunReplaced, mutateState, projectAdmission, recordRunEvents, RUN_UPDATE_COLUMNS,
  supersedeEquivalentResumableRuns, upsertAgent,
  type RunInsert, type RunUpdate, type RunEventRowInsert,
} from '../core/runs.js';
import { PROJECT_CAPABILITIES, type ProjectCapability } from '../core/settings.js';
import type { RunAdmissionGate } from '../core/runs.js';
import { admitResume, classifyFailure, type FailureObservation } from '../core/resume.js';

/** The failure classes a harness may report; anything else is refused rather than mapped to a default. */
const ERROR_CLASSES = ['session-expired', 'postcondition-unsatisfiable', 'other'] as const;
import { releaseRun } from '../core/release.js';
import { runCloseRefusal } from '../core/run-postconditions.js';
import { HARNESS_MEMBER_ID, requeueReplaced } from '../core/harness.js';
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

  const id = str(body.id);
  const agentId = str(body.agentId);
  const task = str(body.task);
  // The claim guards the run id alone; a field that once named an age floor is refused rather than ignored.
  if (body.maxAgeSeconds !== undefined) return Response.json(refused(ctx, refusal('claim takes no maxAgeSeconds', 'parse')));
  // A claim names the capability its task needs, or declares the task
  // capture-driven and gated on a provider instead. Neither may be omitted:
  // a claim that named nothing would run under no admission at all.
  const admission: RunAdmissionGate | null =
    body.capability === undefined && body.captureDriven === true
      ? { kind: 'provider' }
      : (PROJECT_CAPABILITIES as readonly string[]).includes(body.capability as string)
        ? { kind: 'capability', capability: body.capability as ProjectCapability }
        : null;
  const startedAt = int(body.startedAt) ?? ctx.now;
  const instruction = strOrNull(body.instruction, MAX_STATE_BYTES);
  const harness = strOrNull(body.harness);
  const provider = strOrNull(body.provider);
  const model = strOrNull(body.model);
  const runContext = strOrNull(body.runContext, MAX_STATE_BYTES);
  if (id === null || agentId === null || task === null || admission === null
    || instruction === undefined || harness === undefined || provider === undefined
    || model === undefined || runContext === undefined) {
    return Response.json(refused(ctx, refusal('claim requires id, agentId, task, and either a known capability or captureDriven', 'parse')));
  }

  const row: RunInsert = {
    id, agentId, task, instruction, harness, provider, model,
    dryRun: body.dryRun === true, startedAt, runContext, dispatchedBy: ctx.tokenId,
  };
  // The runtime member claims only a run the server dispatched under this credential.
  const outcome = await claimRun(env.db, { projectId: ctx.projectId }, row, { taskName: task, admission, dispatchedOnly: ctx.memberId === HARNESS_MEMBER_ID }, ctx.now);
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

/** Read one agent state value. */
export async function handleReadState(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const agentId = str(body.agentId);
  const key = str(body.key);
  if (agentId === null || key === null) return Response.json(refused(ctx, refusal('read requires agentId and key', 'parse')));

  const row = await getState(env.db, { projectId: ctx.projectId }, agentId, key);
  return Response.json({ persisted: true, value: row?.value ?? null, updatedAt: row?.updatedAt ?? null });
}

/**
 * Write one agent state value, guarded by the value the caller computed against.
 *
 * `expected` absent means the caller read no value; `applied: false` reports that
 * another writer moved it in between, and is the caller's signal to read again
 * rather than an error.
 */
export async function handleWriteState(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const agentId = str(body.agentId);
  const key = str(body.key);
  const value = str(body.value, MAX_STATE_BYTES);
  const expected = strOrNull(body.expected, MAX_STATE_BYTES);
  if (agentId === null || key === null || value === null || expected === undefined) {
    return Response.json(refused(ctx, refusal('write requires agentId, key and a value within the state bound', 'parse')));
  }

  // One attempt: the caller holds the read this write is guarded by, so retrying
  // here would recompute nothing and would overwrite the value it just lost to.
  let applied = false;
  await mutateState(env.db, { projectId: ctx.projectId }, agentId, key, (current) => {
    applied = current === expected;
    return applied ? value : null;
  }, ctx.now);

  return Response.json({ persisted: true, applied });
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

/** Read one run. */
export async function handleGetRun(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('get requires runId', 'parse')));
  return Response.json({ persisted: true, run: await getRun(env.db, { projectId: ctx.projectId }, runId) });
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
 */
async function recordReplacedRun(env: ServerEnv, ctx: RouteContext, runId: string): Promise<void> {
  const scope = { projectId: ctx.projectId };
  if (!(await markRunReplaced(env.db, scope, runId))) return;
  const run = await getRun(env.db, scope, runId);
  if (run === null) return;
  await requeueReplaced(env, { run, projectId: ctx.projectId, serverUrl: ctx.origin, actor: ctx.memberId }, ctx.now);
}

/** Whether a failure body asks for the one context word a runtime may add. */
const asksReplaced = (body: Record<string, unknown>, status: unknown): boolean => body.replaced === true && status === 'failed';

/** The answer a status change gets on a run that has already ended under a DIFFERENT ending: nothing moved, and the row's own ending stands. */
const TERMINAL_ANSWER = { persisted: true, changed: 0, applied: false, reason: 'terminal' } as const;
/** The answer a status change gets on a run already carrying that very status: nothing moved, and nothing needs to. */
const SETTLED_ANSWER = { persisted: true, changed: 0 } as const;

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
  const runUpdate = update as RunUpdate;
  const scope = { projectId: ctx.projectId };
  // On a run the server dispatched, the context and the dry-run flag are the
  // dispatcher's own record of what it decided, and the task routes read both
  // off the row. A runtime moving either would file its own hash as the
  // Project's current one, or turn a dry run into a writing one — and the
  // refusal names the columns rather than dropping them, so a caller learns
  // what it may not set instead of watching a write silently do less.
  const claimed = DISPATCHER_OWNED_COLUMNS.filter((c) => c in runUpdate);
  if (claimed.length > 0 && (await getRun(env.db, scope, runId))?.dispatchedBy != null) {
    return Response.json(refused(ctx, refusal(`a dispatched run's ${claimed.join(' and ')} belong to the dispatcher and may not be updated`, 'refused')));
  }
  const guarded = 'status' in runUpdate;
  const before = guarded ? await getRun(env.db, scope, runId) : null;
  const settled = endedAnswer(before?.status, runUpdate.status);
  if (settled !== null) return settled;
  if (runUpdate.status === 'completed') {
    const missing = before === null ? null : await runCloseRefusal(env.db, scope, before);
    if (missing !== null) {
      const failed = await applyRunUpdate(env.db, scope, runId, { ...runUpdate, status: 'failed', completed_at: ctx.now, error: missing } as RunUpdate);
      if (failed === 1) await releaseDispatchedRun(env, ctx, runId, 'failed');
      const raced = failed === 0 ? endedAnswer((await getRun(env.db, scope, runId))?.status, 'failed') : null;
      if (raced !== null) return raced;
      return Response.json({ persisted: true, changed: failed, applied: false, reason: 'postcondition' });
    }
  }
  const changed = await applyRunUpdate(env.db, scope, runId, runUpdate);
  if (changed === 1) {
    await releaseDispatchedRun(env, ctx, runId, runUpdate.status);
    if (asksReplaced(body, runUpdate.status)) await recordReplacedRun(env, ctx, runId);
    return Response.json({ persisted: true, changed });
  }
  const raced = guarded ? endedAnswer((await getRun(env.db, scope, runId))?.status, runUpdate.status) : null;
  if (raced !== null) return raced;
  return Response.json({ persisted: true, changed });
}

/** Retire the resumability of failed runs equivalent to this one. */
export async function handleSupersedeRuns(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const excludeRunId = str(body.excludeRunId);
  const agentId = str(body.agentId);
  const taskName = str(body.taskName);
  if (excludeRunId === null || agentId === null || taskName === null || typeof body.dryRun !== 'boolean') {
    return Response.json(refused(ctx, refusal('supersede requires excludeRunId, agentId, taskName and dryRun', 'parse')));
  }
  const superseded = await supersedeEquivalentResumableRuns(
    env.db, { projectId: ctx.projectId }, excludeRunId, { agentId, taskName, dryRun: body.dryRun });
  return Response.json({ persisted: true, superseded });
}

/** Every report a run recorded, in the order they were written. */
const EVENT_TYPES = ['pre_tool_use', 'post_tool_use', 'phase_start', 'phase_end'] as const;
const EVENT_OUTCOMES = ['success', 'error'] as const;
/** The most events one request may carry; a burst larger than this is split by the caller. */
export const MAX_EVENTS_PER_REQUEST = 32;
const MAX_SUMMARY_CHARS = 4_096;
const MAX_DETAILS_CHARS = 65_536;
const MAX_PAYLOAD_CHARS = 16_384;

/**
 * Record one report against a run. The run row is the tenancy anchor;
 * `agentId` is the reporter's label and is not held to the run's own agent —
 * attribution of the WRITE stays with the authenticated credential.
 */
export async function handleWriteReport(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const agentId = str(body.agentId);
  const action = str(body.action);
  const summary = str(body.summary, MAX_SUMMARY_CHARS);
  const details = strOrNull(body.details, MAX_DETAILS_CHARS);
  if (runId === null || agentId === null || action === null || summary === null || details === undefined) {
    return Response.json(refused(ctx, refusal('a report requires runId, agentId, action and summary within bounds', 'parse')));
  }
  const recorded = await insertReport(env.db, { projectId: ctx.projectId }, { runId, agentId, action, summary, details, createdAt: ctx.now });
  if (!recorded) return Response.json(refused(ctx, refusal('report names a run this Project does not hold, or an agent this Deployment does not know', 'parse')));
  return Response.json({ persisted: true, recorded: true });
}

/** Record a burst of run events. Rows are validated one by one; a burst with any malformed row is refused whole. */
export async function handleRecordRunEvents(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const raw = body.events;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_EVENTS_PER_REQUEST) {
    return Response.json(refused(ctx, refusal(`events must be 1..${MAX_EVENTS_PER_REQUEST} entries`, 'parse')));
  }
  const events: RunEventRowInsert[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) return Response.json(refused(ctx, BAD_BODY));
    const runId = str(entry.runId);
    const eventType = (EVENT_TYPES as readonly string[]).includes(entry.eventType as string) ? (entry.eventType as string) : null;
    const outcome = entry.outcome === undefined || entry.outcome === null ? null
      : (EVENT_OUTCOMES as readonly string[]).includes(entry.outcome as string) ? (entry.outcome as string) : undefined;
    const phaseName = strOrNull(entry.phaseName);
    const toolName = strOrNull(entry.toolName);
    // Truncated, never refused: the largest tool payloads are exactly the
    // events an audit log most needs, and the sender's catch swallows a refusal.
    const payload = entry.payload === undefined || entry.payload === null ? null
      : typeof entry.payload === 'string' ? entry.payload.slice(0, MAX_PAYLOAD_CHARS) : undefined;
    const durationMs = entry.durationMs === undefined || entry.durationMs === null ? null : int(entry.durationMs);
    // Epoch milliseconds, like every server timestamp; a malformed value is a
    // refusal, not a silent substitution.
    const recordedAt = entry.recordedAt === undefined ? ctx.now : int(entry.recordedAt);
    if (runId === null || eventType === null || outcome === undefined || phaseName === undefined || toolName === undefined || payload === undefined || durationMs === undefined || recordedAt === null) {
      return Response.json(refused(ctx, refusal('an event requires runId and a known eventType, with bounded optional fields', 'parse')));
    }
    events.push({ runId, phaseName, eventType, toolName, outcome, durationMs, payload, recordedAt });
  }
  const recorded = await recordRunEvents(env.db, { projectId: ctx.projectId }, events);
  return Response.json({ persisted: true, recorded });
}

export async function handleRunReports(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('reports requires runId', 'parse')));
  return Response.json({ persisted: true, reports: await listReports(env.db, { projectId: ctx.projectId }, runId) });
}

/** Whether this Project is admitted to a capability, answered without attempting a run. */
export async function handleRunAdmission(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const capability = (PROJECT_CAPABILITIES as readonly string[]).includes(body.capability as string)
    ? (body.capability as ProjectCapability) : null;
  if (capability === null) return Response.json(refused(ctx, refusal('admission requires a known capability', 'parse')));
  const admission = await projectAdmission(env.db, { projectId: ctx.projectId }, capability);
  return Response.json({ persisted: true, ...admission });
}

/**
 * Record how a run failed, and what that means for resuming it.
 *
 * The caller reports what it OBSERVED — whether this attempt is a resume,
 * whether a checkpoint carried a session reference, whether any turn ran, and
 * how the harness classified the error — and the server decides the class. A caller that sent its own verdict
 * could mark a poisoned session resumable and re-enter the loop the guard
 * exists to close.
 */
export async function handleRecordFailure(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const errorMessage = strOrNull(body.error, MAX_STATE_BYTES);
  const errorClass = ERROR_CLASSES.includes(body.errorClass as (typeof ERROR_CLASSES)[number])
    ? (body.errorClass as FailureObservation['errorClass']) : null;
  if (runId === null || errorClass === null || errorMessage === undefined) {
    return Response.json(refused(ctx, refusal('a failure requires runId and a known errorClass', 'parse')));
  }

  const decision = classifyFailure({
    wasResume: body.wasResume === true,
    hadPriorSession: body.hadPriorSession === true,
    recordedAnyTurns: body.recordedAnyTurns === true,
    errorClass,
  });
  const update: Record<string, unknown> = {
    status: 'failed',
    completed_at: ctx.now,
    error: errorMessage,
    resumable: decision.resumable ? 1 : 0,
    resume_status: decision.status,
  };
  // A poisoned session id is discarded with the same write that records the
  // failure: leaving it for a follow-up call is a window where a wake could
  // reuse it.
  if (decision.clearCheckpoints) update.checkpoints = null;

  // The write is guarded on the row not already being terminal, and a run that
  // ended under another status answers the same refusal the update route gives:
  // `changed: 0` alone reads exactly like a run in another Project.
  const scope = { projectId: ctx.projectId };
  const ended = endedAnswer((await getRun(env.db, scope, runId))?.status, 'failed');
  if (ended !== null) return ended;
  const changed = await applyRunUpdate(env.db, scope, runId, update as RunUpdate);
  if (changed === 1) {
    await releaseDispatchedRun(env, ctx, runId, 'failed');
    if (body.replaced === true) await recordReplacedRun(env, ctx, runId);
  }
  const raced = changed === 0 ? endedAnswer((await getRun(env.db, scope, runId))?.status, 'failed') : null;
  if (raced !== null) return raced;
  return Response.json({ persisted: true, changed, ...decision });
}

/** Whether a failed run may be resumed now, consuming a retry when it may. */
export async function handleAdmitResume(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('resume admission requires runId', 'parse')));

  const scope = { projectId: ctx.projectId };
  const run = await getRun(env.db, scope, runId);
  if (run === null) return Response.json({ persisted: true, admit: false, status: 'absent' });
  if (run.resumable !== 1) {
    return Response.json({ persisted: true, admit: false, status: run.resumeStatus ?? 'not_resumable' });
  }

  const outcome = await admitResume(env.db, scope, {
    id: run.id, agentId: run.agentId, task: run.task ?? '', dryRun: run.dryRun === 1,
    startedAt: run.startedAt, resumeAttempts: run.resumeAttempts,
  });
  return Response.json({ persisted: true, ...outcome });
}
