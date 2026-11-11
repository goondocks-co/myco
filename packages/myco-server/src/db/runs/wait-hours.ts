/**
 * Waits in the queue, counted by the hour each began and the hour it ended: `run_wait_hour(left_hour, entered_hour,
 * project_id, taken, waits)`. The unit is one wait: one stay of a run in the queue, from when it entered to when it
 * left. A run that goes back to the queue waits again, and each stay counts once, so a counter never claims distinct runs.
 *
 * A stay begins when the run is queued: at `queued_at` for its first stay, and at `queue_entered_at`, which every write
 * that puts a run back in the queue sets, for a later one. It ends when the run leaves the queue for any reason: a machine
 * takes it (`taken` 1), or it expires, is cancelled, skipped or deleted unclaimed (`taken` 0). The triggers here count it
 * in the statement that moves the run out of the queue, so the count rides the queue owner's own writes. A run created
 * as it is claimed (pulled work) never stays in the queue and is not counted.
 *
 * From these counters alone, the waits that overlapped a whole-hour span [from, to) are the stays that began before `to`
 * and ended at or after `from`: both ends are whole hours, so the count is exact. Kept as long as the run counts and
 * dropped by the same wake, a bounded page at a time, by the hour each stay ended.
 */
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { trigger, type Trigger } from '../ddl.js';
import { read, write, type Bound } from '../index.js';
import type { ProjectSet } from '../../read/scope.js';
import { SQL_NOW_MS } from '../../core/run-deadline.js';
import { HOUR_MS } from './run-hours.js';
import { queueEnteredSql } from './queue-stay.js';

const hourOf = (instant: string) => `CAST(${instant}/${HOUR_MS} AS INTEGER)*${HOUR_MS}`;
const KEY = 'left_hour,entered_hour,project_id,taken';
/** Statuses a run leaves the queue for when a machine or launcher takes it. */
const TAKEN = "('running','pending')";

/** Count the stay `OLD` held, ended at `left` and taken or not. */
const countStay = (left: string, taken: string) => `INSERT INTO run_wait_hour(${KEY},waits)
    SELECT ${hourOf(`MAX(${left},${queueEnteredSql('OLD')})`)},${hourOf(queueEnteredSql('OLD'))},OLD.project_id,${taken},1 WHERE ${queueEnteredSql('OLD')} IS NOT NULL
    ON CONFLICT(${KEY}) DO UPDATE SET waits=waits+1`;

function waitHourTriggers(): Trigger[] {
  // A run taken leaves the queue as it starts; any other exit as it ends; the server's clock where it recorded neither.
  const left = `CASE WHEN NEW.status IN ${TAKEN} THEN COALESCE(NEW.started_at,${SQL_NOW_MS}) ELSE COALESCE(NEW.completed_at,${SQL_NOW_MS}) END`;
  return [
    trigger('run_wait_hour_leave', 'agent_runs', 'UPDATE OF status', countStay(left, `CASE WHEN NEW.status IN ${TAKEN} THEN 1 ELSE 0 END`),
      "OLD.status='queued' AND NEW.status<>'queued'"),
    trigger('run_wait_hour_delete', 'agent_runs', 'DELETE', countStay(SQL_NOW_MS, '0'), "OLD.status='queued'"),
  ];
}

/** The counters, led by the hour a stay ended so a window and the retention both seek them, and the triggers. */
export function waitHourSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS run_wait_hour(left_hour INTEGER NOT NULL,entered_hour INTEGER NOT NULL,
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),taken INTEGER NOT NULL CHECK (taken IN (0,1)),waits INTEGER NOT NULL,PRIMARY KEY(${KEY})) WITHOUT ROWID`,
    ...waitHourTriggers().map(({ sql }) => sql),
  ];
}

/** How many stays in the queue of the visible Projects began in one hour and ended in another, taken by a machine or not. */
export interface WaitHourRow { left_hour: number; entered_hour: number; taken: number; waits: number }
/** Queued work still waiting under one Project, task and origin: since its oldest was queued, and how many wait. */
export interface StillWaitingRow { since: number; runs: number }

const visible = (all: boolean, column: string) => all
  ? `?1 IS NOT NULL AND EXISTS(SELECT 1 FROM projects vp WHERE vp.project_id=${column} AND vp.archived_at IS NULL)`
  : `${column} IN (SELECT value FROM json_each(?1))`;
const ended = [true, false].map((all) => read<[projects: string, since: number, until: number], WaitHourRow>({ name: `waitHours.window${all ? 'All' : 'Named'}`,
  sql: `SELECT left_hour,entered_hour,taken,SUM(waits) AS waits FROM run_wait_hour w WHERE left_hour>=?2 AND left_hour<?3 AND ${visible(all, 'w.project_id')}
    GROUP BY left_hour,entered_hour,taken` }));
/**
 * Every waiting head across Projects through the partial index of heads with queued work; a named set seeks each of
 * its Projects by the heads' Project-leading key, so unrelated Projects' queues are never read.
 */
const waiting = [
  read<[projects: string], StillWaitingRow>({ name: 'waitHours.stillWaitingAll', sql: `SELECT oldest_queued_at AS since,queued_count AS runs
    FROM task_runtime t INDEXED BY idx_task_runtime_task WHERE queued_count>0 AND oldest_queued_at IS NOT NULL AND ${visible(true, 't.project_id')}` }),
  read<[projects: string], StillWaitingRow>({ name: 'waitHours.stillWaitingNamed', sql: `SELECT t.oldest_queued_at AS since,t.queued_count AS runs
    FROM json_each(?1) p CROSS JOIN task_runtime t ON t.project_id=p.value WHERE t.queued_count>0 AND t.oldest_queued_at IS NOT NULL` }),
];

/**
 * The stays in the queue of the visible Projects that ended in [since, until), by the hours they began and ended and
 * whether a machine took them, and the queued work still waiting now, one row per Project, task and origin, from the
 * queue's own counters.
 */
export function waitHourReads(set: ProjectSet, projects: string, since: number, until: number): [Bound<WaitHourRow, 'read'>, Bound<StillWaitingRow, 'read'>] {
  const index = set.all ? 0 : 1;
  return [ended[index]!.bind(projects, since, until), waiting[index]!.bind(projects)];
}

const expired = write<[before: number, limit: number], { gone: number }>({ name: 'waitHours.prune', sql: `DELETE FROM run_wait_hour WHERE (${KEY}) IN
  (SELECT ${KEY} FROM run_wait_hour WHERE left_hour<?1 ORDER BY left_hour LIMIT ?2) RETURNING 1 AS gone` });

/** Up to `limit` wait counts of stays that ended before the whole hour `boundary`, oldest first. */
export const pruneWaitHours = (boundary: number, limit: number) => expired.bind(boundary, limit);
