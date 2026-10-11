import type { RelationalStore } from './adapters.js';
import { ensureAgent, getState, mutateState } from './runs.js';
import { HARNESS_AGENT_ID } from './harness.js';
import { EXTRACTION_PAGE } from './extraction-input.js';
import { listUnprocessedPrompts } from '../read/prompts.js';

/** First-time automatic extraction admits at most two runs per rolling day until one page remains. */
export const EXTRACTION_RAMP_RUNS_PER_DAY = 2;
const RAMP_KEY = 'schedule.extract-curate.ramp';

/** A durable ramp survives its first completed run; established extraction and a caught-up Project stay uncapped here. */
export async function extractionRamp(db: RelationalStore, projectId: string, now: number): Promise<number | null> {
  const scope = { projectId };
  const held = await getState(db, scope, HARNESS_AGENT_ID, RAMP_KEY);
  if (held?.value === 'complete') return null;
  if (held !== null && held.value !== 'ramping') throw new Error('Invalid extraction ramp state');
  const established = held === null && await db.prepare('SELECT 1 AS found FROM prompt_batches WHERE project_id = ? AND processed = 1 LIMIT 1')
    .bind(projectId).first() !== null;
  const backlog = established ? 0 : (await listUnprocessedPrompts(db, scope, { limit: EXTRACTION_PAGE + 1 })).rows.length;
  const next = backlog > EXTRACTION_PAGE ? 'ramping' : 'complete';
  if (held === null || next === 'complete') {
    await ensureAgent(db, { id: HARNESS_AGENT_ID, name: HARNESS_AGENT_ID, provider: null, model: null, enabled: true }, now);
    const stored = await mutateState(db, scope, HARNESS_AGENT_ID, RAMP_KEY,
      (current) => current === 'complete' ? null : current === null || next === 'complete' ? next : null, now);
    if (!stored) throw new Error('Extraction ramp state contention');
  }
  return next === 'ramping' ? EXTRACTION_RAMP_RUNS_PER_DAY : null;
}
