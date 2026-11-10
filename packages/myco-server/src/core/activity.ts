/**
 * When the Deployment last saw activity, and the stamp an owner request leaves.
 *
 * Activity is what the power state follows: a capture receipt, a run starting, a
 * person on the dashboard, a runtime joining. The first two already leave rows;
 * the other two are stamped here, into the Deployment's own key-value row, at
 * most once a minute.
 *
 * A join has to count. It reaches storage without an authenticated member and
 * leaves no session and no run, so a Deployment whose only traffic is joins would
 * read as idle, fall to a depth where no job runs, and stop reclaiming the very
 * invitations those joins are spending.
 */
import type { RelationalStore } from './adapters.js';
import { rows, type Bound } from '../db/index.js';
import { latestActivityAt, stampWrite } from '../db/activity/last-activity.js';
import { AUTOMATIC_HEADER } from '@goondocks/myco-shared/live-marks';

/**
 * Whether a request is the dashboard fetching on its own (`AUTOMATIC_HEADER`): a page loading or refreshing its data
 * is fetch traffic, not a person, so it leaves no activity stamp. A person's presence arrives on its own request
 * (`PRESENCE_PATH`), sent when someone actually uses the page. The header can only withhold a stamp, never grant
 * anything, so it is trusted as sent.
 */
export function automaticRequest(request: Request): boolean {
  return request.headers.get(AUTOMATIC_HEADER) === '1';
}

/** The key under which the Deployment records the last owner request it served. */
export const LAST_REQUEST_KEY = 'last_request_at';
/** A request is stamped at most this often; the stamp is a write, and one per minute is as fresh as the tick can read. */
export const REQUEST_STAMP_INTERVAL_MS = 60_000;

/**
 * Record a request that leaves no other trace — an owner request or a join. One
 * conditional write: the row is replaced only when the stamp it holds is older
 * than the interval, so a busy dashboard and a burst of joins each cost one
 * write a minute rather than one per request.
 */
export async function stampRequest(db: RelationalStore, now: number): Promise<void> {
  await rows(db, stampRequestWrite(now));
}

/** The same conditional write, bound for a caller's commit. */
export const stampRequestWrite = (now: number): Bound<never, 'write'> => stampWrite(LAST_REQUEST_KEY, now, now - REQUEST_STAMP_INTERVAL_MS);

/** When the Deployment last saw activity — a capture receipt, a run starting, an owner request, a join — or null when it never has. */
export const lastActivityAt = (db: RelationalStore): Promise<number | null> => latestActivityAt(db, LAST_REQUEST_KEY);
