import { PARSER_VERSION } from '../constants.js';
import { viewStatusCounts, viewStatusDetails, viewStatusCleanup, viewStatusFindings } from './view-store.js';
import {
  SESSION_VIEW_STATES,
  type SessionViewStatus,
  type ViewWorkStatus,
  type SessionViewState,
} from '@goondocks/myco-shared/view-status';
import type { RelationalStore } from '../core/adapters.js';
import { projectHostedConvergence, type ProjectionInput } from '../core/view-throughput.js';

export const VIEW_STATUS_DETAIL_LIMIT = 64;
export const VIEW_SAMPLE_MAX_AGE_MS = 86_400_000;
const RETIRED_VIEW_HOLD_MS = 15 * 60_000;
const CHAIN_IDLE_MS = 2000;
interface WorkSample {
  store: 'native' | 'remote' | null;
  profile: 'serial' | 'parallel' | null;
  started_at: number;
  observed_at: number | null;
  initial_bytes: number;
  offered_bytes: number;
  useful_bytes: number;
  published_bytes: number;
  published_at: number | null;
  service_ms: number;
  wake_ms: number;
  wakes: number;
  statements: number;
  round_trips: number;
  blob_calls: number;
  observation_token: string | null;
  valid: number;
  last_refusal: string | null;
}

/** Rates require a complete, fresh observation and publication-certified source progress. */
function workStatus(sample: WorkSample | null, now: number): ViewWorkStatus {
  if (sample === null) return { state: 'unavailable', reason: 'no measured rebuild sample' };
  if (sample.valid !== 1 || sample.observation_token !== null)
    return { state: 'unavailable', reason: 'rebuild measurement is incomplete' };
  if (sample.observed_at === null || sample.observed_at > now || now - sample.observed_at > VIEW_SAMPLE_MAX_AGE_MS)
    return { state: 'unavailable', reason: 'rebuild sample is absent or stale' };
  if (sample.published_at === null || sample.wakes === 0 || sample.store === null || sample.profile === null)
    return { state: 'unavailable', reason: 'no measured publication' };
  const elapsedMs = Math.max(sample.observed_at - sample.started_at, sample.wake_ms) + sample.wakes * CHAIN_IDLE_MS;
  if (elapsedMs <= 0) return { state: 'unavailable', reason: 'rebuild sample has no elapsed time' };
  const netBytes = Math.max(
    0,
    Math.min(sample.useful_bytes, sample.published_bytes) - (sample.offered_bytes - sample.initial_bytes),
  );
  return {
    state: 'measured',
    observedAt: sample.observed_at,
    store: sample.store,
    profile: sample.profile,
    initialBytes: sample.initial_bytes,
    offeredBytes: sample.offered_bytes,
    usefulBytes: sample.useful_bytes,
    publishedBytes: sample.published_bytes,
    netBytes,
    elapsedMs,
    serviceMs: sample.service_ms,
    wakeMs: sample.wake_ms,
    wakes: sample.wakes,
    statements: sample.statements,
    roundTrips: sample.round_trips,
    blobCalls: sample.blob_calls,
    rowsRead: null,
    rowsWritten: null,
    netBytesPerSecond: netBytes / (elapsedMs / 1000),
  };
}

export async function readViewStatus(
  db: RelationalStore,
  projects: readonly string[],
  now: number,
  projection?: ProjectionInput,
): Promise<SessionViewStatus> {
  const scope = JSON.stringify({ projects, parserVersion: PARSER_VERSION });
  const grouped = (await viewStatusCounts(db).bind(scope).all<{ state: SessionViewState; n: number }>()).results;
  const rows = (
    await viewStatusDetails(db).bind(scope, VIEW_STATUS_DETAIL_LIMIT).all<{
      project_id: string;
      session_id: string;
      title: string | null;
      state: SessionViewState;
      bytes_behind: number;
      build_bytes_behind: number | null;
      next_attempt_at: number | null;
      last_failure: string | null;
      service_ms: number | null;
      last_refusal: string | null;
      sample: string | null;
    }>()
  ).results;
  const cleanup = await viewStatusCleanup(db)
    .bind(now - RETIRED_VIEW_HOLD_MS, scope)
    .first<{ retired: number; abandoned: number; eligibleRetired: number }>();
  if (cleanup === null) throw new Error('view_cleanup_status_unavailable');
  const findings = (await viewStatusFindings(db).bind(scope).all<{ kind: string; count: number }>()).results;
  const counts = Object.fromEntries(
    SESSION_VIEW_STATES.map((state) => [state, grouped.find((row) => row.state === state)?.n ?? 0]),
  ) as Record<SessionViewState, number>;
  const states = rows.map(({ sample, ...row }) => ({
    ...row,
    work: workStatus(sample === null ? null : (JSON.parse(sample) as WorkSample), now),
  }));
  const total = grouped.reduce((sum, row) => sum + row.n, 0),
    complete = total <= VIEW_STATUS_DETAIL_LIMIT;
  const measured = states.flatMap((row) => (row.work.state === 'measured' ? [row.work] : []));
  const sampled = complete && states.length > 0 && measured.length === states.length;
  const validProjection =
    sampled &&
    projection !== undefined &&
    measured.every(
      (row) =>
        row.store === 'remote' &&
        row.profile === (projection.profile ?? 'serial') &&
        projection.localNet <= row.netBytesPerSecond,
    );
  return {
    observedAt: now,
    counts,
    details: { limit: VIEW_STATUS_DETAIL_LIMIT, total, complete },
    states,
    cleanup: { ...cleanup, heldRetired: cleanup.retired - cleanup.eligibleRetired },
    findings,
    unplaced: { state: 'unavailable', reason: 'effective placement requires the view reader contract' },
    coverageNotCarried: { state: 'unavailable', reason: 'exact coverage is confirmed by conversion preparation' },
    throughput: validProjection
      ? { state: 'measured', ...projectHostedConvergence(projection) }
      : {
          state: 'unavailable',
          reason: sampled
            ? 'sourced hosted projection inputs are unavailable'
            : 'no complete fresh measured rebuild sample',
        },
    preflight: { state: 'available', scope: 'owner' },
  };
}
export type ViewStatus = SessionViewStatus;
