/**
 * The Runs page's hourly history is kept for `RUN_HOUR_RETENTION_MS`: the finished-run facts and counts, each runner's
 * check-ins, and the runs that waited. The wake drops what is older a bounded page at a time, in one commit, all cut at
 * the same whole hour, so a kept hour keeps every count it had.
 */
import type { RelationalStore } from '../../core/adapters.js';
import { commit } from '../index.js';
import { pruneContactHours } from '../runners/contact-hours.js';
import { HOUR_MS, pruneRunHourStatements } from './run-hours.js';
import { pruneWaitHours } from './wait-hours.js';

/**
 * Drop up to `limit` rows of each table from before the start of the hour holding `before`, oldest first: how many went,
 * and whether more wait.
 */
export async function pruneRunHours(db: RelationalStore, before: number, limit: number): Promise<{ changed: number; more: boolean }> {
  const boundary = before - (before % HOUR_MS);
  const results = await commit(db, ...pruneRunHourStatements(boundary, limit), pruneContactHours(boundary, limit), pruneWaitHours(boundary, limit));
  return { changed: results.reduce((n, result) => n + result.results.length, 0), more: results.some((result) => result.results.length === limit) };
}
