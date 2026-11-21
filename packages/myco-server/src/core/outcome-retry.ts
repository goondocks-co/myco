/**
 * Whether Myco takes a failed outcome again by itself, decided by the same admission the work it failed in passes:
 * a pulled stage's switch, its task's admission in the Project and its own subject eligibility, now or later; a
 * scheduled task's own wake decision (`laterWakeTakes`). Default-deny: anything those owners do not positively take
 * again is not retrying, so a person sees it.
 */
import type { ServerEnv } from './adapters.js';
import { taskAcceptedSql } from '../db/runs/task-acceptance.js';
import { subjectsRetrying, type RetryTerm } from '../db/runs/outcome-retry.js';
import { PULLED_STAGES } from './pulled-stages.js';
import { scheduleLeaves, scheduledTasks } from './schedule-rules.js';
import { laterWakeTakes, readScheduleFacts } from './scheduled-tasks.js';
import { sessions_listProjects as listProjects } from '../read/catalog/sessions.js';

/** Each pulled stage that can say whether it takes a failed subject again, as one term of the batched read. */
const PULLED_TERMS: readonly RetryTerm[] = PULLED_STAGES.flatMap((stage) => stage.retries === undefined ? [] : [{
  task: stage.task,
  sql: `(${stage.switchedOn}) AND ${taskAcceptedSql('r.project_id', stage.task)} AND ${stage.retries('r.project_id', 'r.subject', '?2')}`,
}]);

/** The failed runs, as `projectId/runId`, that their work takes again by itself at `now`. */
export async function failuresRetrying(env: ServerEnv, failures: readonly { projectId: string; task: string; runId: string }[], now: number): Promise<Set<string>> {
  const retrying = await subjectsRetrying(env.db, failures.map(({ projectId, runId }) => ({ projectId, runId })), PULLED_TERMS, now);
  const leaves = await scheduleLeaves(env);
  const schedules = new Map(scheduledTasks(leaves.overrides).map((row) => [row.task, row.schedule]));
  const scheduled = failures.filter((failure) => schedules.has(failure.task));
  if (scheduled.length === 0) return retrying;
  const facts = await readScheduleFacts(env, [...new Set(scheduled.map((failure) => failure.task))], now, [...new Set(scheduled.map((failure) => failure.projectId))]);
  const activity = new Map((await listProjects(env.db)).map((project) => [project.projectId, project.lastActivityAt]));
  for (const failure of scheduled) {
    if (await laterWakeTakes(env, failure.projectId, activity.get(failure.projectId) ?? null, failure.task, schedules.get(failure.task)!, leaves, now, facts)) retrying.add(`${failure.projectId}/${failure.runId}`);
  }
  return retrying;
}

/** Repository failures with whether a later scheduled run tries again: never for a settings failure, which needs a person. */
export async function repositoryFailuresRetrying<T extends { projectId: string; task: string; runId: string; backoff: boolean }>(env: ServerEnv, streaks: readonly T[], now: number): Promise<Array<T & { retrying: boolean }>> {
  const retrying = await failuresRetrying(env, streaks.filter((streak) => !streak.backoff), now);
  return streaks.map((streak) => ({ ...streak, retrying: retrying.has(`${streak.projectId}/${streak.runId}`) }));
}
