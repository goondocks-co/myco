import type { RelationalStore } from '../../core/adapters.js';
import { CARD_TASK } from '@goondocks/myco-shared/turn-card';
import { EXTRACTION_TASK } from '../../core/task-catalogue.js';
import type { PulledWait, PulledWaitScope } from '../../core/pulled-stages.js';
import { taskAcceptedSql } from '../runs/task-acceptance.js';
import { read, readSet } from '../index.js';
import { learningEligible, learningNotInFlight, stageOf } from './ready.js';

const waits = (['cards', 'learning'] as const).flatMap(kind => [false, true].map(fresh => ({
  stage: stageOf(kind, fresh),
  statement: read<[projects: string, now: number, cutoff: number], PulledWait>({
    name: `learning.waiting${stageOf(kind, fresh)}`,
    sql: `WITH candidates AS MATERIALIZED (SELECT k.value AS projectId,(SELECT l.${kind === 'cards' ? 'card' : 'learning'}_promoted_at
      FROM learning_sessions l INDEXED BY ${kind === 'cards' ? 'idx_learning_card_waiting' : 'idx_learning_stage_waiting'}
      WHERE l.project_id=k.value AND l.${kind === 'cards' ? 'card' : 'learning'}_promoted_at<=?3
        AND ${learningEligible(kind, fresh, '?2')} AND ${learningNotInFlight(kind)}
        AND ${taskAcceptedSql('l.project_id', kind === 'cards' ? CARD_TASK : EXTRACTION_TASK)}
      ORDER BY l.${kind === 'cards' ? 'card' : 'learning'}_promoted_at,l.session_id LIMIT 1) AS since FROM json_each(?1) k) SELECT * FROM candidates WHERE since IS NOT NULL`,
  }),
})));

/** Due age comes from the stage's deadline; source freshness and readiness are checked at the current instant. */
export async function learningWaiting(db: RelationalStore, stage: ReturnType<typeof stageOf>, scope: PulledWaitScope): Promise<PulledWait[]> {
  const statement = waits.find(candidate => candidate.stage === stage)!.statement;
  const [rows] = await readSet(db, statement.bind(JSON.stringify(scope.projects), scope.now, scope.cutoff));
  return rows;
}
