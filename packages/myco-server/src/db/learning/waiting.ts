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
    sql: `SELECT l.project_id AS projectId,MIN(l.${kind === 'cards' ? 'card' : 'learning'}_deadline) AS since
      FROM json_each(?1) k CROSS JOIN learning_sessions l INDEXED BY ${kind === 'cards' ? 'idx_learning_card_ready' : 'idx_learning_stage_ready'} ON l.project_id=k.value
      WHERE l.${kind === 'cards' ? 'card' : 'learning'}_deadline<=?3
        AND ${learningEligible(kind, fresh, '?2')} AND ${learningNotInFlight(kind)}
        AND ${taskAcceptedSql('l.project_id', kind === 'cards' ? CARD_TASK : EXTRACTION_TASK)}
      GROUP BY l.project_id`,
  }),
})));

/** Due age comes from the stage's deadline; source freshness and readiness are checked at the current instant. */
export async function learningWaiting(db: RelationalStore, stage: ReturnType<typeof stageOf>, scope: PulledWaitScope): Promise<PulledWait[]> {
  const statement = waits.find(candidate => candidate.stage === stage)!.statement;
  const [rows] = await readSet(db, statement.bind(JSON.stringify(scope.projects), scope.now, scope.cutoff));
  return rows;
}
