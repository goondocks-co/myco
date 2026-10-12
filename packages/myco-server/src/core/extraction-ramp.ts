import type { ServerEnv } from './adapters.js';
import { EXTRACTION_PAGE } from './extraction-input.js';
import { extractionHistorySessions, hasProcessedPrompts, listUnprocessedPrompts } from '../read/prompts.js';
import { schedulerState } from './scheduler-state.js';
import { scheduleFor, scheduleLeaves } from './schedule-rules.js';
import { TASK_SCHEDULE } from './jobs.js';
import { EXTRACTION_TASK } from './task-catalogue.js';

const DAY_MS = 86_400_000;
type RampState = { phase: 'complete' } | { phase: 'ramping'; startedAt: number; sessionIds: string[] };
const validRamp = (value: unknown, now: number): value is RampState => {
  if (typeof value !== 'object' || value === null || !('phase' in value)) return false;
  return value.phase === 'complete' || (value.phase === 'ramping' && 'startedAt' in value && 'sessionIds' in value
    && typeof value.startedAt === 'number' && Number.isSafeInteger(value.startedAt) && value.startedAt >= 0 && value.startedAt <= now
    && Array.isArray(value.sessionIds) && value.sessionIds.length > 0 && value.sessionIds.every(id => typeof id === 'string' && id.length > 0)
    && new Set(value.sessionIds).size === value.sessionIds.length);
};

/** First eligible history ramps until it drains or the active window expires; subsequent inflow does not extend it. */
export async function extractionRamp(env: ServerEnv, projectId: string, now: number, settings?: { activeWindowDays: number; runsPerDay: number | undefined }): Promise<number | null> {
  const { db } = env;
  const limits = settings ?? await (async () => {
    const leaves = await scheduleLeaves(env);
    return { activeWindowDays: leaves.activeWindowDays, runsPerDay: scheduleFor(EXTRACTION_TASK, TASK_SCHEDULE[EXTRACTION_TASK]!, leaves.overrides).rampRunsPerDay };
  })();
  if (limits.runsPerDay === undefined) return null;
  const state = schedulerState(db, projectId, 'extract-curate.ramp', (value): value is RampState => validRamp(value, now), now);
  const { value: held, reset } = await state.read();
  if (held?.phase === 'complete') return null;
  const scope = { projectId };
  const established = !reset && held === null && await hasProcessedPrompts(db, scope);
  const history = { receivedThrough: held?.startedAt ?? now, sessionIds: held?.sessionIds ?? (established ? [] : await extractionHistorySessions(db, scope)) };
  const backlog = established ? 0 : (await listUnprocessedPrompts(db, scope, { limit: held === null ? EXTRACTION_PAGE + 1 : 1, history })).rows.length;
  const complete = established || limits.activeWindowDays === 0 || (held === null ? backlog <= EXTRACTION_PAGE : backlog === 0 || now - held.startedAt >= limits.activeWindowDays * DAY_MS);
  const next: RampState = complete ? { phase: 'complete' } : held ?? { phase: 'ramping', startedAt: now, sessionIds: history.sessionIds };
  if (held === null || complete) await state.update(current => current?.phase === 'complete' ? current : complete ? next : current ?? next);
  return complete ? null : limits.runsPerDay;
}
