/**
 * `myco_run_sessions`: settled sessions as material, and this run's own session.
 *
 * `list` reads full-fidelity sessions only. Everything that assembles material
 * for a model reads the full-fidelity set; a person browsing history reads the
 * other. A session whose transcript is known to be incomplete is material a run
 * would reason over as if it were whole.
 *
 * `material` and `title` take no session argument. The session is the one the
 * dispatch named, resolved from the run row before any handler runs, so there
 * is no id for a caller to get wrong and no check to forget. The titling mode
 * is the dispatch's too: at a session's end a title is written only where none
 * exists, on an owner's ask over whatever is there.
 */
import { listSessions, getSession, overwriteTitle, sessionCounts, writeTitle } from '../../read/sessions.js';
import { cleanSummary, cleanTitle, sessionMaterial, SUMMARY_MAX_CHARS, TITLE_MAX_CHARS, titlingParamsOf } from '../../core/titling.js';
import { preview } from '../../core/run-material.js';
import { recordRunWrite } from '../../core/runs.js';
import { TITLE_WRITE_TOOL } from '../../core/tool-catalogue.js';
import { emit } from '../../telemetry.js';
import { assertSessionMaterialReady } from '../../read/material-readiness.js';
import { failure, runOf, type ToolContext } from '../context.js';
import type { ToolInput } from '../validate.js';

const int = (v: unknown): number | undefined => (typeof v === 'number' && Number.isSafeInteger(v) ? v : undefined);


export async function handleRunSessions(input: ToolInput, ctx: ToolContext): Promise<unknown> {
  const run = runOf(ctx, 'myco_run_sessions');
  const scope = { projectId: ctx.projectId };
  const { db } = ctx.env;
  const { window } = run;

  if (input.op === 'list') {
    const limit = Math.min(Math.max(int(input.limit) ?? window.sessionPage, 1), window.sessionPage);
    const page = await listSessions(db, scope, { limit, state: 'ended' });
    return {
      sessions: page.rows.map((row) => ({
        id: row.sessionId,
        label: preview(row.label, window.sessionLabelChars),
        started_at: row.startedAt,
        ended_at: row.endedAt,
        title: preview(row.title, window.sessionTitleChars),
        summary: preview(row.summary, window.sessionSummaryChars),
      })),
    };
  }

  const sessionId = run.sessionId;
  if (sessionId === null) return failure('this run names no session');
  const params = titlingParamsOf(run.runContext);
  if (params === null) return failure('this run names no session');
  const session = await getSession(db, scope, sessionId);
  if (session === null) return failure('Session not found');

  if (input.op === 'material') {
    const counts = await sessionCounts(db, scope, sessionId);
    const material = await sessionMaterial(db, ctx.projectId, sessionId, params.mode);
    return {
      session_id: sessionId,
      status: session.endedAt === null ? 'active' : 'completed',
      agent: session.agent,
      branch: session.branch,
      prompt_count: counts.prompts,
      ...(session.title === null ? {} : { current_title: session.title }),
      ...(session.summary === null ? {} : { current_summary: session.summary }),
      ...(params.mode === 'owner' ? { note: 'The batches are the session\'s earliest and latest prompts in order; the middle is omitted.' } : {}),
      batches: material.map((line, i) => ({ prompt_number: i + 1, user_prompt: line.prompt, response_excerpt: line.response })),
    };
  }

  const title = typeof input.title === 'string' ? cleanTitle(input.title) : null;
  const summary = typeof input.summary === 'string' ? cleanSummary(input.summary) : null;
  if (title === null || summary === null) {
    return failure(`a title is 1 to ${TITLE_MAX_CHARS} characters and a summary 1 to ${SUMMARY_MAX_CHARS}; both are required`);
  }
  const written = params.mode === 'owner'
    ? await overwriteTitle(db, ctx.projectId, sessionId, title, summary, params.by ?? null)
    : await writeTitle(db, ctx.projectId, sessionId, title, summary);
  if (!written) await assertSessionMaterialReady(db, ctx.projectId, sessionId);
  // A write that took is the run's own record of doing its work, and the only
  // thing keyed to THIS run: the session row carries no run of its own, and a
  // title standing from an earlier run reads the same as one this run wrote.
  // A `claim` write over a title that already stands takes nothing and records
  // nothing, which is what the close rule then reads.
  if (written) {
    await recordRunWrite(db, scope, { runId: run.runId, toolName: TITLE_WRITE_TOOL, op: 'title', recordedAt: ctx.now, detail: { session_id: sessionId } });
    emit({ kind: 'session_titled', projectId: ctx.projectId, sessionId, mode: params.mode, runId: run.runId });
  }
  return { session_id: sessionId, written };
}
