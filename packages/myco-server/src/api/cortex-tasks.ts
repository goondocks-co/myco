/**
 * What a Cortex run reads and writes.
 *
 * A `cortex-instructions` run holds no vault. It reads the prompt the server
 * built for it, the Project's recent sessions and its current digest, and it
 * writes back the one artifact it owes. Each route admits exactly one caller:
 * the harness credential that dispatched a live run of such a task
 * (`heldRun`). A plain member, another task, a finished run, or another
 * credential of the harness is answered `held: false`.
 *
 * **The hash the artifact is filed under comes off the run row, never the
 * body.** The server built the material and recorded its hash in the run's
 * context at dispatch; a run that could name its own hash could file stale
 * instructions as current and every later dispatch would read the Project as
 * unmoved.
 *
 * A dry run reads everything and writes nothing: the write answers
 * `written: false`, and the run still records its report, so the close gate
 * reads what actually happened.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { heldRun } from './run-admission.js';
import { digestForTier, listDigests } from '../core/digests.js';
import { upsertCortexInstructions, runInstruction, type RunRow } from '../core/runs.js';
import { DIGEST_TIERS } from '../core/recall.js';
import { CORTEX_INSTRUCTIONS_TASK, DIGEST_READ_TASKS, INSTRUCTED_TASKS, SESSION_LIST_TASKS } from '../core/task-inputs.js';
import { preview } from '../core/cortex-input.js';
import { listSessions } from '../read/sessions.js';
import { MAX_STATE_BYTES } from './runs.js';
import { refused } from '../ingest/events.js';
import { refusal, type Refusal } from '../telemetry.js';

const MAX_ID_CHARS = 192;
/** How many sessions one page of the run's own session list carries. */
export const RUN_SESSIONS_DEFAULT_LIMIT = 5;
export const RUN_SESSIONS_MAX_LIMIT = 50;
/** How much of a session's summary one row carries. */
export const RUN_SESSION_SUMMARY_CHARS = 360;

const BAD_BODY: Refusal = refusal('body is not an object', 'parse');
/** The answer every route here gives a caller that holds no Cortex run. */
const UNHELD = { persisted: true, held: false } as const;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown, max = MAX_ID_CHARS): string | null => (typeof v === 'string' && v.length > 0 && v.length <= max ? v : null);

function parseBody(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** The hash of the material the server built this run's prompt from, as its context records it. */
export function inputHashOf(run: RunRow): string | null {
  if (run.runContext === null) return null;
  try {
    const parsed: unknown = JSON.parse(run.runContext);
    const value = isRecord(parsed) ? parsed.input_hash : undefined;
    return typeof value === 'string' && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

/** The prompt the server built for this run. */
export async function handleRunInstruction(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('an instruction requires runId', 'parse')));
  const run = await heldRun(env, ctx, runId, INSTRUCTED_TASKS);
  if (run === null) return Response.json(UNHELD);
  return Response.json({ persisted: true, held: true, instruction: await runInstruction(env.db, { projectId: ctx.projectId }, runId) });
}

/**
 * The artifact a `cortex-instructions` run writes: the Project's session-start
 * instructions, filed under the hash of the material the server handed it.
 */
export async function handleInstructionsWrite(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const content = str(body.content, MAX_STATE_BYTES);
  if (runId === null || content === null) {
    return Response.json(refused(ctx, refusal(`instructions require runId and content of 1 to ${MAX_STATE_BYTES} characters`, 'parse')));
  }
  const run = await heldRun(env, ctx, runId, [CORTEX_INSTRUCTIONS_TASK]);
  if (run === null) return Response.json({ ...UNHELD, written: false });

  const inputHash = inputHashOf(run);
  // A run dispatched with no recorded hash cannot file the artifact: the hash is
  // what every later dispatch compares its own build against.
  if (inputHash === null || run.dryRun === 1) return Response.json({ persisted: true, held: true, written: false });

  await upsertCortexInstructions(env.db, { projectId: ctx.projectId }, {
    agentId: run.agentId,
    content,
    inputHash,
    generatedAt: ctx.now,
    sourceRunId: runId,
  });
  return Response.json({ persisted: true, held: true, written: true });
}

/** The Project's settled sessions, newest first: what a run needs to name a hotspot by title. */
export async function handleRunSessions(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('sessions requires runId', 'parse')));
  const run = await heldRun(env, ctx, runId, SESSION_LIST_TASKS);
  if (run === null) return Response.json(UNHELD);

  const asked = typeof body.limit === 'number' && Number.isSafeInteger(body.limit) ? body.limit : RUN_SESSIONS_DEFAULT_LIMIT;
  const limit = Math.min(Math.max(asked, 1), RUN_SESSIONS_MAX_LIMIT);
  const page = await listSessions(env.db, { projectId: ctx.projectId }, { limit, state: 'ended' });
  return Response.json({
    persisted: true,
    held: true,
    sessions: page.rows.map((row) => ({
      id: row.sessionId,
      label: row.label,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      title: row.title,
      summary: preview(row.summary, RUN_SESSION_SUMMARY_CHARS),
    })),
  });
}

/** The Project's digest: one tier in full, or what each tier holds when the caller names none. */
export async function handleRunDigest(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  if (runId === null) return Response.json(refused(ctx, refusal('a digest read requires runId', 'parse')));
  const run = await heldRun(env, ctx, runId, DIGEST_READ_TASKS);
  if (run === null) return Response.json(UNHELD);

  const rows = await listDigests(env.db, { projectId: ctx.projectId });
  const tier = typeof body.tier === 'number' && DIGEST_TIERS.includes(body.tier) ? body.tier : null;
  if (tier === null) {
    return Response.json({
      persisted: true,
      held: true,
      tiers: rows.map((row) => ({ tier: row.tier, generatedAt: row.generatedAt, contentLength: row.content.length })),
    });
  }
  const chosen = digestForTier(rows, tier);
  return Response.json({
    persisted: true,
    held: true,
    digest: chosen === null ? null : { tier: chosen.row.tier, content: chosen.row.content, generatedAt: chosen.row.generatedAt },
  });
}
