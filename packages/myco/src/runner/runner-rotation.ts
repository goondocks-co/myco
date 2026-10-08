/**
 * Runner credential rotation.
 *
 * The client mints every successor bearer and writes it to the runner record
 * as the pending candidate BEFORE sending it, under the runner lock. A reply
 * lost in transit leaves the candidate pending, and the next attempt sends the
 * same one: the Deployment answers it idempotently. The predecessor stays the
 * record's token until the Deployment confirms the successor, so a runner that
 * never hears back keeps working on the credential it has.
 */
import { MEMBER_TOKEN_REFRESH_WINDOW_MS } from '../member/constants.js';
import type { RefreshStatus } from '../member/refresh.js';
import type { FetchLike, Outcome } from '../member/transport.js';
import {
  newRunnerBearer, publishRunnerRecord, readRunnerRecord, stagePending, withRunnerLock,
  type RunnerLock, type RunnerRecord,
} from './runner-registry.js';
import { postRunnerRoute, RUNNER_ROTATE_PATH } from './runner-routes.js';

/** How long a non-forced renewal stays quiet after the Deployment could not be reached. */
export const RETRY_BACKOFF_MS = 30_000;

const REFRESH_TOO_EARLY = 'refresh_too_early';
const LINEAGE_EXPIRED = 'lineage_expired';

export interface RotationOptions {
  mycoHome?: string;
  fetch?: FetchLike;
  now?: () => number;
  /** Send the rotation whether or not the window is open. */
  force?: boolean;
}

export interface RotationReport {
  status: RefreshStatus;
  /** The record as it stands after the attempt; null where none is held. */
  record: RunnerRecord | null;
  /** What the Deployment or the transport said, for statuses that need words. */
  detail?: string;
}

/** Whether the credential's window is open: a pending candidate is always due; otherwise the announced `refreshAfter`, else the last quarter of the TTL. A credential with neither is due, and one send teaches it the window. */
export function rotationDue(record: Pick<RunnerRecord, 'pending' | 'refreshAfter' | 'tokenExpiresAt'>, now: number): boolean {
  if (record.pending?.kind === 'rotate') return true;
  if (record.refreshAfter !== undefined) return now >= record.refreshAfter;
  if (record.tokenExpiresAt !== undefined) return record.tokenExpiresAt - now <= MEMBER_TOKEN_REFRESH_WINDOW_MS;
  return true;
}

function rotatedWindow(body: Record<string, unknown>): { credentialId: string; expiresAt: number; refreshAfter: number } | null {
  if (body.rotated !== true) return null;
  if (typeof body.credentialId !== 'string' || typeof body.expiresAt !== 'number' || typeof body.refreshAfter !== 'number') return null;
  return { credentialId: body.credentialId, expiresAt: body.expiresAt, refreshAfter: body.refreshAfter };
}

function withoutPending(record: RunnerRecord): RunnerRecord {
  const kept: RunnerRecord = { ...record };
  delete kept.pending;
  return kept;
}

/** Settle one answered rotation into the record and the status it earns. */
function settle(lock: RunnerLock, held: RunnerRecord & { token: string }, candidate: string, outcome: Outcome): RotationReport {
  const finish = (status: RefreshStatus, next: RunnerRecord, detail?: string): RotationReport => {
    publishRunnerRecord(lock, next);
    return { status, record: next, ...(detail === undefined ? {} : { detail }) };
  };
  switch (outcome.class) {
    case 'acked': {
      const window = rotatedWindow(outcome.body);
      if (window !== null) {
        return finish('refreshed', { ...withoutPending(held), token: candidate, tokenId: window.credentialId, tokenExpiresAt: window.expiresAt, refreshAfter: window.refreshAfter });
      }
      if (outcome.body.rotated === false && outcome.body.code === REFRESH_TOO_EARLY && typeof outcome.body.refreshAfter === 'number') {
        return finish('too-early', { ...withoutPending(held), refreshAfter: outcome.body.refreshAfter });
      }
      return { status: 'retry', record: held, detail: 'the Deployment answered the rotation in a shape this runner does not read' };
    }
    case 'refused':
      return finish(outcome.code === LINEAGE_EXPIRED ? 'lineage-expired' : 'terminal', withoutPending(held), `${outcome.code}${outcome.reason === '' ? '' : `: ${outcome.reason}`}`);
    case 'unauthorized':
      return finish('unauthorized', withoutPending(held), outcome.replayed === true ? 'this runner\'s credential was used from two places and has been revoked' : 'the Deployment does not accept this runner\'s credential');
    case 'route_missing':
      return { status: 'route-missing', record: held, detail: 'the Deployment serves no runner routes at this address' };
    case 'protocol':
      return { status: 'protocol', record: held, detail: `the Deployment speaks member protocol ${outcome.serverProtocol ?? '?'}` };
    default:
      return { status: 'retry', record: held, detail: outcome.class === 'retry' ? outcome.detail : outcome.class };
  }
}

/**
 * Rotate the credential the runner record holds for `serverUrl` when its window
 * is open, or with `force` whether or not it is. Another process holding the
 * runner lock answers `busy`.
 */
export async function rotateRunnerCredential(serverUrl: string, options: RotationOptions = {}): Promise<RotationReport> {
  const now = options.now ?? Date.now;
  const before = readRunnerRecord(serverUrl, options.mycoHome);
  if (before === null || before.token === undefined) return { status: 'no-entry', record: before };
  if (options.force !== true && !rotationDue(before, now())) return { status: 'not-due', record: before };

  const locked = await withRunnerLock(serverUrl, async (lock): Promise<RotationReport> => {
    // The winner of a race has already published the successor this attempt would have sent.
    const held = readRunnerRecord(serverUrl, lock.mycoHome);
    if (held === null || held.token === undefined) return { status: 'no-entry', record: held };
    if (held.token !== before.token || (options.force !== true && !rotationDue(held, now()))) return { status: 'not-due', record: held };
    // A replacement registration holds the record's pending slot; the acknowledged credential rotates once it settles.
    if (held.pending?.kind === 'register') return { status: 'not-due', record: held, detail: 'a replacement registration is pending' };
    const staged = held.pending?.kind === 'rotate' ? held : stagePending(lock, {
      kind: 'rotate', candidate: newRunnerBearer(), startedAt: now(),
      ...(held.tokenId === undefined ? {} : { predecessorTokenId: held.tokenId }),
    }, held.name);
    const candidate = staged.pending!.candidate;
    const outcome = await postRunnerRoute(serverUrl, held.token, RUNNER_ROTATE_PATH, { candidate }, options.fetch);
    return settle(lock, { ...staged, token: held.token }, candidate, outcome);
  }, options.mycoHome);
  return locked.held ? locked.value : { status: 'busy', record: before };
}

/**
 * The renewal a claim loop calls before each request (`force` false) and after a
 * refusal (`force` true). A non-forced renewal that could not reach the
 * Deployment stays quiet for `RETRY_BACKOFF_MS`. `notify` is told of every
 * outcome that needs words.
 */
export function runnerRenewer(serverUrl: string, options: RotationOptions & { notify?: (line: string) => void } = {}): (force: boolean) => Promise<RefreshStatus> {
  const now = options.now ?? Date.now;
  let quietUntil = 0;
  return async (force) => {
    if (!force && now() < quietUntil) return 'not-due';
    const report = await rotateRunnerCredential(serverUrl, { ...options, force });
    if (report.status === 'retry') quietUntil = now() + RETRY_BACKOFF_MS;
    if (report.detail !== undefined && report.status !== 'too-early') options.notify?.(`credential rotation ${report.status}: ${report.detail}`);
    return report.status;
  };
}
