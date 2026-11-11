/**
 * Runs that waited in the queue, counted by the hour they were queued and the hour a machine took them:
 * `run_wait_hour(claimed_hour, queued_hour, project_id, runs)`. A claim writes its attempt; the trigger here adds that
 * attempt's run to its pair of hours in the same statement, so the count rides the claim and adds no write of its own.
 * A run created as it is claimed (pulled work) was never queued and is not counted.
 *
 * From these counters alone, the runs that waited at some time in a whole-hour span [from, to) are the runs queued
 * before `to` and taken at or after `from`: the queued hour bounds one side and the claimed hour the other, exactly, since
 * both ends are whole hours. A run that went back to the queue counts each later wait from when it was first queued.
 *
 * Kept as long as the run counts and dropped by the same wake, a bounded page at a time, by the hour it was taken.
 */
import { PROJECT_ID_GRAMMAR } from '../project-id.js';
import { trigger, type Trigger } from '../ddl.js';
import { read, write, type Bound } from '../index.js';
import type { ProjectSet } from '../../read/scope.js';
import { HOUR_MS } from './run-hours.js';

const hourOf = (instant: string) => `CAST(${instant}/${HOUR_MS} AS INTEGER)*${HOUR_MS}`;
const KEY = 'claimed_hour,queued_hour,project_id';

function waitHourTriggers(): Trigger[] {
  return [trigger('run_wait_hour_claim', 'agent_run_attempts', 'INSERT', `INSERT INTO run_wait_hour(${KEY},runs)
    SELECT ${hourOf('NEW.claimed_at')},${hourOf('r.queued_at')},NEW.project_id,1 FROM agent_runs r
    WHERE r.project_id=NEW.project_id AND r.id=NEW.run_id AND r.queued_at IS NOT NULL AND r.queued_at<=NEW.claimed_at
    ON CONFLICT(${KEY}) DO UPDATE SET runs=runs+1`)];
}

/** The counters, led by the hour a run was taken so a window and the retention both seek them, and the trigger. */
export function waitHourSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS run_wait_hour(claimed_hour INTEGER NOT NULL,queued_hour INTEGER NOT NULL,
      project_id TEXT NOT NULL CHECK (${PROJECT_ID_GRAMMAR}),runs INTEGER NOT NULL,PRIMARY KEY(${KEY})) WITHOUT ROWID`,
    ...waitHourTriggers().map(({ sql }) => sql),
  ];
}

/** How many runs of the visible Projects were queued in one hour and taken in another. */
export interface WaitHourRow { claimed_hour: number; queued_hour: number; runs: number }
/** Queued work still waiting under one Project, task and origin: since its oldest was queued, and how many wait. */
export interface StillWaitingRow { since: number; runs: number }

const visible = (all: boolean, column: string) => all
  ? `?1 IS NOT NULL AND EXISTS(SELECT 1 FROM projects vp WHERE vp.project_id=${column} AND vp.archived_at IS NULL)`
  : `${column} IN (SELECT value FROM json_each(?1))`;
const taken = [true, false].map((all) => read<[projects: string, since: number, until: number], WaitHourRow>({ name: `waitHours.window${all ? 'All' : 'Named'}`,
  sql: `SELECT claimed_hour,queued_hour,SUM(runs) AS runs FROM run_wait_hour w WHERE claimed_hour>=?2 AND claimed_hour<?3 AND ${visible(all, 'w.project_id')}
    GROUP BY claimed_hour,queued_hour` }));
const waiting = [true, false].map((all) => read<[projects: string], StillWaitingRow>({ name: `waitHours.stillWaiting${all ? 'All' : 'Named'}`,
  sql: `SELECT oldest_queued_at AS since,queued_count AS runs FROM task_runtime t INDEXED BY idx_task_runtime_task
    WHERE queued_count>0 AND oldest_queued_at IS NOT NULL AND ${visible(all, 't.project_id')}` }));

/**
 * The runs of the visible Projects that machines took in [since, until), by the hours they were queued and taken, and
 * the queued work still waiting now, one row per Project, task and origin, from the queue's own counters.
 */
export function waitHourReads(set: ProjectSet, projects: string, since: number, until: number): [Bound<WaitHourRow, 'read'>, Bound<StillWaitingRow, 'read'>] {
  const index = set.all ? 0 : 1;
  return [taken[index]!.bind(projects, since, until), waiting[index]!.bind(projects)];
}

const expired = write<[before: number, limit: number], { gone: number }>({ name: 'waitHours.prune', sql: `DELETE FROM run_wait_hour WHERE (${KEY}) IN
  (SELECT ${KEY} FROM run_wait_hour WHERE claimed_hour<?1 ORDER BY claimed_hour LIMIT ?2) RETURNING 1 AS gone` });

/** Up to `limit` wait counts of runs taken before the whole hour `boundary`, oldest first. */
export const pruneWaitHours = (boundary: number, limit: number) => expired.bind(boundary, limit);
