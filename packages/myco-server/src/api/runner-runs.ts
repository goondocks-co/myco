/**
 * `GET /api/runners/{runnerId}/runs`: one runner's page of recent runs across Projects, newest claim first, with the
 * runner's name, state and last check-in.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { runnerAttempts, runnerFacts, type RunnerAttemptKey, type RunnerAttemptRow } from '../db/runners/recent-runs.js';
import { decodeCursor, encodeCursor } from '../read/scope.js';
import { badRequest, notFound, ok } from './scope.js';

/** The most runs one page of a runner's history lists, and the page it lists when none is asked for. */
export const RUNNER_RUNS_PAGE = 50;
const RUNNER_ID = /^[A-Za-z0-9._-]{1,64}$/;

/** How one claim by this runner came out: the run's own end where this was its latest claim, else handed on. */
type RunnerRunOutcome = 'running' | 'worked' | 'changed_nothing' | 'failed' | 'handed_on' | 'other';

function outcomeOf(row: RunnerAttemptRow): RunnerRunOutcome {
  if (Number(row.latest) !== 1) return 'handed_on';
  if (row.status === 'running' || row.status === 'pending') return 'running';
  if (row.status === 'failed') return 'failed';
  if (row.status === 'completed') return row.result === 'unchanged' ? 'changed_nothing' : 'worked';
  return 'other';
}

/** The claim a cursor names: its instant, then its attempt, Project and run; null for text this route never answered. */
function cursorKey(raw: string): RunnerAttemptKey | null {
  const decoded = decodeCursor(raw);
  if (decoded === null) return null;
  try {
    const key: unknown = JSON.parse(decoded.id);
    if (!Array.isArray(key) || key.length !== 3 || !key.every((part) => typeof part === 'string')) return null;
    return { claimedAt: decoded.createdAt, attemptId: key[0], projectId: key[1], runId: key[2] };
  } catch { return null; }
}

export async function handleRunnerRuns(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const runnerId = ctx.params.runnerId ?? '';
  if (!RUNNER_ID.test(runnerId)) return notFound();
  const rawLimit = ctx.url.searchParams.get('limit');
  const limit = rawLimit === null ? RUNNER_RUNS_PAGE : Number(rawLimit);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > RUNNER_RUNS_PAGE)
    return badRequest(`limit must be a whole number from 1 to ${RUNNER_RUNS_PAGE}, not ${JSON.stringify(rawLimit)}; omit it for a page of ${RUNNER_RUNS_PAGE}`);
  const rawCursor = ctx.url.searchParams.get('cursor');
  const cursor = rawCursor === null ? undefined : cursorKey(rawCursor);
  if (cursor === null) return badRequest('cursor is not one this route answered; pass the cursor of the previous page, or omit it for the newest page');
  const [runner, rows] = await Promise.all([
    runnerFacts(env.db, runnerId),
    runnerAttempts(env.db, runnerId, limit + 1, cursor),
  ]);
  if (runner === null) return notFound();
  const listed = rows.slice(0, limit);
  const last = listed.at(-1);
  const runs = listed.map((row) => ({
    attemptId: row.attempt_id, claimedAt: Number(row.claimed_at), projectId: row.project_id, projectName: row.project_name, runId: row.run_id,
    task: row.task, completedAt: row.completed_at === null ? null : Number(row.completed_at), outcome: outcomeOf(row),
  }));
  return ok({
    runner: { id: runner.id, name: runner.name, state: runner.state, lastSeenAt: runner.last_seen_at === null ? null : Number(runner.last_seen_at), version: runner.version },
    rows: runs,
    cursor: rows.length > limit && last !== undefined ? encodeCursor(last.claimed_at, JSON.stringify([last.attempt_id, last.project_id, last.run_id])) : null,
  });
}
