import type { RelationalStore } from '../../core/adapters.js';
import { producedSql } from '../../read/run-outcome.js';
import { contextValue, FAILURE_REASON_KEY } from '../run-context.js';
import { read, readSet } from '../index.js';

export const FAILURE_STREAK_SHOWN = 5;
export interface OutcomePair { projectId: string; task: string }
const unresolved = read<[string, string], { id: string; at: number }>({
  name: 'runs.unresolvedFailures', sql: `SELECT r.id,COALESCE(r.completed_at,r.started_at) AS at
    FROM agent_runs r INDEXED BY idx_agent_runs_task WHERE r.project_id=?1 AND r.task=?2 AND r.status='failed'
    AND r.started_at>COALESCE((SELECT s.started_at FROM agent_runs s INDEXED BY idx_agent_runs_task
      WHERE s.project_id=?1 AND s.task=?2 AND s.status='completed' ORDER BY s.started_at DESC LIMIT 1),-1)
    AND NOT ${producedSql('r')} ORDER BY r.started_at DESC LIMIT ${FAILURE_STREAK_SHOWN + 1}`,
});
export async function unresolvedFailures(db: RelationalStore, pairs: readonly OutcomePair[]) {
  const answers = await readSet(db, ...pairs.map(pair => unresolved.bind(pair.projectId, pair.task)));
  return pairs.flatMap((pair, i) => {
    const rows = answers[i]!;
    const latest = rows[0];
    return latest ? [{ ...pair, runId: latest.id, at: latest.at, failures: Math.min(rows.length, FAILURE_STREAK_SHOWN), hasMore: rows.length > FAILURE_STREAK_SHOWN }] : [];
  });
}
const reasons = read<[string], { projectId: string; runId: string; error_code: string | null; error: string | null; reason: string | null }>({
  name: 'runs.failureReasons', sql: `SELECT r.project_id AS projectId,r.id AS runId,r.error_code,r.error,${contextValue(FAILURE_REASON_KEY)} AS reason
    FROM json_each(?) k JOIN agent_runs r ON r.project_id=json_extract(k.value,'$.projectId') AND r.id=json_extract(k.value,'$.runId')`,
});
export async function failureReasons(db: RelationalStore, runs: ReadonlyArray<{ projectId: string; runId: string }>): Promise<Map<string, string>> {
  const [rows] = await readSet(db, reasons.bind(JSON.stringify(runs)));
  return new Map(rows.map(row => [`${row.projectId}\0${row.runId}`, [row.reason, row.error, row.error_code].find(value => value?.trim()) ?? 'Myco didn’t record why.']));
}
