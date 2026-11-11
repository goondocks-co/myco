import type { RelationalStore } from '../../core/adapters.js';
import { SERVER_STATE_PREFIX } from '../../constants.js';
import { commit, read, readSet, write } from '../index.js';

const KEY_PREFIX = `${SERVER_STATE_PREFIX}pulled-budget:`;
/** A claim's budget refusal stays current for a minute; a refused poll renews it once it is half that old, or at once when what it holds changed. */
export const PULLED_BUDGET_HOLD_MS = 60_000;
export interface PulledBudgetHold { level: number; task: string; requiredUsd: number; at: number }
const key = (level: number) => `${KEY_PREFIX}${level}`;
const keys = (levels: readonly number[]) => JSON.stringify([...new Set(levels)].map(key));

const record = write<[key: string, level: number, task: string, required: number, now: number]>({
  name: 'pull.budgetHold', sql: `INSERT INTO schema_meta(key,value) VALUES(?1,json_object('level',?2,'task',?3,'requiredUsd',?4,'at',?5))
    ON CONFLICT(key) DO UPDATE SET value=excluded.value WHERE json_extract(schema_meta.value,'$.at')<=?5
      AND (json_extract(schema_meta.value,'$.at')<=?5-${PULLED_BUDGET_HOLD_MS / 2} OR json_extract(schema_meta.value,'$.task') IS NOT ?3
        OR json_extract(schema_meta.value,'$.requiredUsd') IS NOT ?4)`,
});
const current = read<[keys: string, floor: number, now: number], PulledBudgetHold>({
  name: 'pull.currentBudgetHold', sql: `SELECT json_extract(value,'$.level') AS level,json_extract(value,'$.task') AS task,
      json_extract(value,'$.requiredUsd') AS requiredUsd,json_extract(value,'$.at') AS at
    FROM schema_meta WHERE key IN (SELECT value FROM json_each(?1)) AND json_extract(value,'$.at') BETWEEN ?2 AND ?3
    ORDER BY level,at DESC LIMIT 1`,
});
const clear = write<[keys: string, level: number, now: number, project: string, run: string, attempt: string]>({
  name: 'pull.clearBudgetHolds', sql: `DELETE FROM schema_meta WHERE key IN (SELECT value FROM json_each(?1))
    AND json_extract(value,'$.level')>=?2 AND json_extract(value,'$.at')<=?3
    AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=?4 AND id=?5 AND dispatched_by=?6 AND status='running')`,
});

/** One latest refusal per stage level; an older concurrent poll cannot replace a newer observation. */
export async function recordPulledBudgetHold(db: RelationalStore, hold: PulledBudgetHold): Promise<void> {
  await commit(db, record.bind(key(hold.level), hold.level, hold.task, hold.requiredUsd, hold.at));
}

/** The highest-priority current refusal across the registered stage levels. */
export async function currentPulledBudgetHold(db: RelationalStore, input: { levels: readonly number[]; now: number }): Promise<PulledBudgetHold | null> {
  const [rows] = await readSet(db, current.bind(keys(input.levels), input.now - PULLED_BUDGET_HOLD_MS, input.now));
  return rows[0] ?? null;
}

/** The successful attempt clears observed holds at its level and below inside its claim transaction. */
export function clearPulledBudgetHolds(input: { levels: readonly number[]; level: number; now: number; projectId: string; runId: string; attemptId: string }) {
  return clear.bind(keys(input.levels), input.level, input.now, input.projectId, input.runId, input.attemptId);
}
