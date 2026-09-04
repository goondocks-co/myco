/**
 * What a titling run reads and writes.
 *
 * A `title-summary` run holds no vault; it reaches the session it was
 * dispatched for over these two routes. Both admit exactly one caller: the
 * harness credential that dispatched a live run of that task whose recorded
 * context names the session in the request. A plain member, another task, a
 * finished run, or a run bound to another session is refused — the credential
 * a dispatch mints is scoped to its run, and these routes are where that scope
 * is enforced.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import type { RunRow } from '../core/runs.js';
import { heldRun } from './run-admission.js';
import { cleanSummary, cleanTitle, sessionMaterial, SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, TITLING_TASK, titlingParamsOf, type TitlingParams } from '../core/titling.js';
import { getSession, overwriteTitle, sessionCounts, writeTitle } from '../read/sessions.js';
import { refused } from '../ingest/events.js';
import { emit, refusal, type Refusal } from '../telemetry.js';

const MAX_ID_CHARS = 192;
const BAD_BODY: Refusal = refusal('body is not an object', 'parse');

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

/**
 * The titling run the caller holds for the session, or null: a live run of this
 * task under this credential (`heldRun`), bound to the session in the request.
 * The session predicate is the titling routes' own — a run titling one session
 * reads and writes that session alone.
 */
async function heldTitlingRun(env: ServerEnv, ctx: RouteContext, runId: string, sessionId: string): Promise<{ run: RunRow; params: TitlingParams } | null> {
  const run = await heldRun(env, ctx, runId, [TITLING_TASK]);
  if (run === null) return null;
  const params = titlingParamsOf(run.runContext);
  if (params === null || params.session_id !== sessionId) return null;
  return { run, params };
}

/**
 * The material a titling run reads: the session's facts, its current title and
 * summary, and its prompts with the start of each response — the opening alone
 * at a session's end, the opening and the close on an owner's ask, as the
 * dispatch recorded. Answered in the shape the task's tool has always read.
 */
export async function handleSessionMaterial(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const sessionId = str(body.sessionId);
  if (runId === null || sessionId === null) return Response.json(refused(ctx, refusal('material requires runId and sessionId', 'parse')));
  const held = await heldTitlingRun(env, ctx, runId, sessionId);
  if (held === null) return Response.json({ persisted: true, held: false });

  const scope = { projectId: ctx.projectId };
  const session = await getSession(env.db, scope, sessionId);
  if (session === null) return Response.json({ persisted: true, held: false });
  const counts = await sessionCounts(env.db, scope, sessionId);
  const material = await sessionMaterial(env.db, ctx.projectId, sessionId, held.params.mode);
  return Response.json({
    persisted: true,
    held: true,
    material: {
      session_id: sessionId,
      status: session.endedAt === null ? 'active' : 'completed',
      agent: session.agent,
      branch: session.branch,
      prompt_count: counts.prompts,
      ...(session.title === null ? {} : { current_title: session.title }),
      ...(session.summary === null ? {} : { current_summary: session.summary }),
      ...(held.params.mode === 'owner' ? { note: 'The batches are the session\'s earliest and latest prompts in order; the middle is omitted.' } : {}),
      batches: material.map((line, i) => ({ prompt_number: i + 1, user_prompt: line.prompt, response_excerpt: line.response })),
    },
  });
}

/**
 * The write a titling run makes: at a session's end only where no title
 * exists, on an owner's ask over whatever is there — the mode the dispatch
 * recorded, never the caller's word. A title or summary outside its bound is
 * refused so the run can offer another; a title that landed from elsewhere in
 * the meantime answers `written: false`.
 */
export async function handleSessionTitle(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = parseBody(ctx.body);
  if (!body) return Response.json(refused(ctx, BAD_BODY));
  const runId = str(body.runId);
  const sessionId = str(body.sessionId);
  if (runId === null || sessionId === null) return Response.json(refused(ctx, refusal('a title requires runId and sessionId', 'parse')));
  const held = await heldTitlingRun(env, ctx, runId, sessionId);
  if (held === null) return Response.json({ persisted: true, held: false, written: false });

  const title = typeof body.title === 'string' ? cleanTitle(body.title) : null;
  const summary = typeof body.summary === 'string' ? cleanSummary(body.summary) : null;
  if (title === null || summary === null) {
    return Response.json(refused(ctx, refusal(`a title is 1 to ${TITLE_MAX_CHARS} characters and a summary 1 to ${SUMMARY_MAX_CHARS}; both are required`, 'parse')));
  }

  const written = held.params.mode === 'owner'
    ? await overwriteTitle(env.db, ctx.projectId, sessionId, title, summary, held.params.by ?? null)
    : await writeTitle(env.db, ctx.projectId, sessionId, title, summary);
  if (written) emit({ kind: 'session_titled', projectId: ctx.projectId, sessionId, mode: held.params.mode, runId });
  return Response.json({ persisted: true, held: true, written });
}
