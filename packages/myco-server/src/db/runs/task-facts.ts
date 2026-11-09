import { IN_FLIGHT_RUN_STATUSES } from '../run-statuses.js';
import type { PreparedStatement, RelationalStore } from '../../core/adapters.js';
import { lastTaskEntryQueries, taskEntriesSql } from './claim.js';
import { read as defineRead, type BindValue, type Statement } from '../index.js';
import { prepareBound } from '../kernel/statement.js';
import { shapedStatements } from './statement-shapes.js';

const taskFactsRead = shapedStatements<Statement<BindValue[], Record<string, unknown>, 'read'>>();

/** The key `taskRunFacts` answers a Project and task under. */
export const taskFactsKey = (projectId: string, task: string): string => `${projectId}\u0000${task}`;

/** Latest entries, live admission and the rolling window use separate indexed questions for each eligible Project. */
export function taskRunFacts(
  db: RelationalStore,
  tasks: readonly string[],
  sinceMs: number,
  actor: string,
  projectId?: string | readonly string[],
): {
  statement: PreparedStatement;
  read: (rows: ReadonlyArray<Record<string, unknown>>) => Map<string, TaskRunFacts>;
} {
  const latest = lastTaskEntryQueries({ projectId: '' }, '', actor, { project: 'p.project_id', task: 't.value' });
  const projects =
    projectId === undefined
      ? ''
      : typeof projectId === 'string'
        ? 'AND p.project_id = ?'
        : 'AND p.project_id IN (SELECT value FROM json_each(?))';
  const scopeShape = projectId === undefined ? 'AllProjects' : typeof projectId === 'string' ? 'OneProject' : 'ProjectSet';
  const definition = taskFactsRead(`${scopeShape}${latest.length}`, shape => defineRead<BindValue[], Record<string, unknown>>({ name: `runs.taskFacts${shape}`, sql:
    `SELECT p.project_id AS projectId,t.value AS task,
    EXISTS(SELECT 1 FROM agent_runs WHERE project_id=p.project_id AND task=t.value AND ${IN_FLIGHT_RUN_STATUSES}) AS live,
    (SELECT MAX(at) FROM (${latest.map(({ sql }) => 'SELECT * FROM (' + sql + ')').join(' UNION ALL ')})) AS lastEntryAt,
    (${taskEntriesSql('p.project_id', 't.value', actor)}) AS entriesSince
    FROM projects p CROSS JOIN json_each(?) t WHERE 1=1 ${projects}
      AND EXISTS(SELECT 1 FROM agent_runs WHERE project_id=p.project_id AND task=t.value LIMIT 1)` }));
  const statement = prepareBound(db, definition.bind(
    ...latest.flatMap(({ binds }) => binds as BindValue[]),
    sinceMs,
    actor,
    JSON.stringify(tasks),
    ...(projectId === undefined ? [] : [typeof projectId === 'string' ? projectId : JSON.stringify(projectId)]),
  ));
  const read = (rows: ReadonlyArray<Record<string, unknown>>): Map<string, TaskRunFacts> =>
    new Map(
      rows.map((row) => [
        taskFactsKey(String(row.projectId), String(row.task)),
        {
          live: Number(row.live) === 1,
          lastEntryAt: row.lastEntryAt === null ? null : Number(row.lastEntryAt),
          entriesSince: Number(row.entriesSince ?? 0),
        },
      ]),
    );
  return { statement, read };
}

/** What the clock's schedule reads of one Project's runs of one task. */
export interface TaskRunFacts {
  /** A run of the task is live: pending, running or queued, as `hasLiveTaskRun` reads it. */
  live: boolean;
  /** When the actor last entered one, as `lastTaskEntryAt` reads it. */
  lastEntryAt: number | null;
  /** The actor's entries from the window's start on, as `taskEntriesSince` counts them. */
  entriesSince: number;
}
