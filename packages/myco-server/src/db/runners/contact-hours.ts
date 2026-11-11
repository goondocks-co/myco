/**
 * Each runner's check-ins by the hour: `runner_contact_hour` holds, per runner and hour, how many contacts Myco recorded
 * and the first and last of them. A runner's contact row (`runner_contacts`) keeps only its latest check-in; the triggers
 * here add each recorded contact to its hour in the same statement, so the hourly history rides the existing throttled
 * contact write and adds no write of its own. A contact the throttle skips is not recorded, here or there.
 *
 * Hours older than `RUN_HOUR_RETENTION_MS`, cut at the same whole hour as the run counts, are dropped by the wake's
 * run-hour retention a bounded page at a time. History starts when this table did: there is nothing to count from before.
 */
import { trigger, type Trigger } from '../ddl.js';
import { read, write, type Bound } from '../index.js';
import { HOUR_MS } from '../runs/run-hours.js';

const hourOf = (instant: string) => `CAST(${instant}/${HOUR_MS} AS INTEGER)*${HOUR_MS}`;
const countContact = `INSERT INTO runner_contact_hour(hour,runner_id,contacts,first_seen_at,last_seen_at)
  VALUES(${hourOf('NEW.last_seen_at')},NEW.runner_id,1,NEW.last_seen_at,NEW.last_seen_at)
  ON CONFLICT(hour,runner_id) DO UPDATE SET contacts=contacts+1,first_seen_at=MIN(first_seen_at,excluded.first_seen_at),last_seen_at=MAX(last_seen_at,excluded.last_seen_at)`;

function contactHourTriggers(): Trigger[] {
  return [
    trigger('runner_contact_hour_insert', 'runner_contacts', 'INSERT', countContact),
    trigger('runner_contact_hour_update', 'runner_contacts', 'UPDATE OF last_seen_at', countContact, 'NEW.last_seen_at > OLD.last_seen_at'),
  ];
}

/** The hourly check-in table, led by the hour so a window and the retention both seek it, and its triggers. */
export function contactHourSchemaStatements(): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS runner_contact_hour(hour INTEGER NOT NULL,runner_id TEXT NOT NULL,contacts INTEGER NOT NULL,
      first_seen_at INTEGER NOT NULL,last_seen_at INTEGER NOT NULL,PRIMARY KEY(hour,runner_id)) WITHOUT ROWID`,
    ...contactHourTriggers().map(({ sql }) => sql),
  ];
}

/** One runner's check-ins in one hour. */
export interface ContactHourRow { runner_id: string; hour: number; contacts: number }

const window = read<[since: number, until: number], ContactHourRow>({ name: 'contactHours.window',
  sql: 'SELECT runner_id,hour,contacts FROM runner_contact_hour WHERE hour>=?1 AND hour<?2' });
const earliest = read<[], { hour: number | null }>({ name: 'contactHours.earliest', sql: 'SELECT MIN(hour) AS hour FROM runner_contact_hour' });

/** Every runner's check-in hours in [since, until), and the earliest hour any check-in is kept for (null when none is). */
export function contactHourReads(since: number, until: number): [Bound<ContactHourRow, 'read'>, Bound<{ hour: number | null }, 'read'>] {
  return [window.bind(since, until), earliest.bind()];
}

const expired = write<[before: number, limit: number], { gone: number }>({ name: 'contactHours.prune', sql: `DELETE FROM runner_contact_hour WHERE (hour,runner_id) IN
  (SELECT hour,runner_id FROM runner_contact_hour WHERE hour<?1 ORDER BY hour LIMIT ?2) RETURNING 1 AS gone` });

/** Up to `limit` check-in hours from before the whole hour `boundary`, oldest first. */
export const pruneContactHours = (boundary: number, limit: number) => expired.bind(boundary, limit);
