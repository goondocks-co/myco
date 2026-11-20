import { TELEMETRY_JOB } from './jobs.js';
import type { RelationalStore } from './adapters.js';
import { telemetryWorkDue, isTelemetryWorkDue, type TelemetryWork } from '../db/telemetry/work.js';
import { cleanRevokedTelemetry } from '../db/telemetry/revocation.js';
import { pruneTelemetry } from '../db/telemetry/retention.js';
import { reconcileTelemetry } from './telemetry-matching.js';
const TELEMETRY_CLEANUP_PAGE = 64;
/** The registry admits telemetry only while a key exists and its one work flag is due. */
export function telemetryJobs(options: {
  work: TelemetryWork;
  now: number;
  jobs: readonly string[];
}): readonly string[] {
  return isTelemetryWorkDue(options.work, options.now)
    ? options.jobs
    : options.jobs.filter((name) => name !== TELEMETRY_JOB);
}
/** An idle pass reads one flag and performs no housekeeping queries or writes. */
export async function runTelemetryWork(
  db: RelationalStore,
  now: number,
): Promise<{ changed: number; more: boolean }> {
  if (!(await telemetryWorkDue(db, now))) return { changed: 0, more: false };
  const cleaned = await cleanRevokedTelemetry(db);
  const removed = await pruneTelemetry(db, now, TELEMETRY_CLEANUP_PAGE);
  const matched = await reconcileTelemetry(db, now);
  return { changed: cleaned + removed + matched, more: await telemetryWorkDue(db, now) };
}
