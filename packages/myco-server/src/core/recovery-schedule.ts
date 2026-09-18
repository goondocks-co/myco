/**
 * What "Back up every" means, and what an owner is told about it.
 *
 * Reads the interval, decides whether an attempt is due, and describes the state: whether automatic recovery is
 * configured, when the next attempt is due, what the last one did, and what recovery data exists.
 *
 * A staging is never described as a recovery: a complete staging becomes recoverable only when an operator
 * materializes and verifies it, and `available` says so. The schedule holds no state of its own — the attempt
 * the producer records is its whole history — so a duplicate wake admits nothing twice and a restart keeps the
 * cadence.
 */
import type { ServerEnv } from './adapters.js';
import { leafValues } from './settings.js';
import type { ProducerRefusal, RecoveryProducerStatus } from './recovery-producer.js';

/** The setting an owner edits as "Back up every", in hours. */
export const INTERVAL_SETTING = 'backup.auto_interval_hours';

export { SCHEDULE_JOB } from './jobs.js';

const HOUR_MS = 60 * 60 * 1000;
/** The hours the dashboard's own control offers; a stored value outside them is clamped rather than obeyed. */
const INTERVAL_MIN_HOURS = 1;
const INTERVAL_MAX_HOURS = 720;

/** The stages an attempt rests in: it advances no further, whatever it reached. */
const RESTING = ['complete', 'failed'] as const;

/** What recovery data this Deployment has, in the only terms that are true of a staging. */
export type RecoveryAvailability =
  /** No attempt has staged anything. */
  | { state: 'none' }
  /** An attempt is staging now, or stopped part-way: nothing here is recoverable. */
  | { state: 'incomplete'; attempt: number; stage: string }
  /**
   * A staging holds the export and every object its rows name. It is still not a recovery artifact: an operator
   * materializes and verifies it into one.
   */
  | { state: 'staged'; attempt: number; prefix: string; needs: string };

/** What the last attempt did, as an owner reads it. */
export interface LatestAttempt {
  attempt: number;
  stage: string;
  startedAt: number | null;
  /** The producer's own refusal classifier, where the attempt failed. */
  failure: ProducerRefusal | null;
}

/** Everything an owner is told about automatic recovery. */
export interface RecoverySchedule {
  /** False when no producer runs here, so nothing automatic is possible whatever the setting says. */
  supported: boolean;
  /** False when the interval is unset or not a usable number of hours: nothing is scheduled, and that is explicit. */
  configured: boolean;
  intervalHours: number | null;
  /**
   * False when this Deployment cannot admit an attempt at all — a binding or credential its recovery
   * configuration names is absent. An owner sees the safe reason, and no attempt is started while it holds.
   */
  ready: boolean;
  /** When the next attempt becomes due, or null when nothing is scheduled. */
  dueAt: number | null;
  due: boolean;
  latest: LatestAttempt | null;
  available: RecoveryAvailability;
  /** Why automatic recovery is doing nothing, when it is doing nothing. */
  idleBecause: string | null;
}

/**
 * The interval, or null when automatic recovery is off.
 *
 * Off is the default and is never inferred from a Deployment's other settings: an absent, zero, negative or
 * unreadable value schedules nothing at all: no Deployment exports merely by existing.
 */
export async function scheduledIntervalHours(env: Pick<ServerEnv, 'db'>): Promise<number | null> {
  const held = (await leafValues(env.db, [INTERVAL_SETTING])).get(INTERVAL_SETTING);
  if (held === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(held); } catch { return null; }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed < INTERVAL_MIN_HOURS) return null;
  return Math.min(INTERVAL_MAX_HOURS, Math.floor(parsed));
}

/**
 * Whether a due configured attempt is waiting, for the engine's own depth assertion.
 *
 * Reads the interval first and stops there when automatic recovery is off, so a Deployment that schedules
 * nothing pays one query for its deepest state. A Deployment that does schedule one is held no deeper than
 * sleep while an attempt is due, which is where the job that admits it runs.
 */
export async function recoveryAttemptDue(env: ServerEnv, now: number): Promise<boolean> {
  if (env.recovery === undefined) return false;
  if (await scheduledIntervalHours(env) === null) return false;
  return (await recoveryScheduleOf(env, now)).due;
}

/** What the producer's status says the latest attempt did. */
export function latestOf(status: RecoveryProducerStatus): LatestAttempt | null {
  if (status.attempt === null) return null;
  return {
    attempt: status.attempt,
    stage: status.stage,
    startedAt: status.startedAt ?? null,
    failure: status.error,
  };
}

/** What recovery data exists, from the attempt the producer holds. */
export function availabilityOf(status: RecoveryProducerStatus): RecoveryAvailability {
  if (status.attempt === null || status.staged === null) return { state: 'none' };
  if (status.stage !== 'complete') return { state: 'incomplete', attempt: status.attempt, stage: status.stage };
  return {
    state: 'staged',
    attempt: status.attempt,
    prefix: status.staged.prefix,
    needs: 'an operator materializes this staging into a verified recovery artifact; a staging alone is not one',
  };
}

/**
 * Whether an attempt is due, and everything an owner is told about the schedule.
 *
 * Due is decided from the last attempt's own start, which the producer records durably: one interval after it,
 * a new attempt is due. An attempt that is still advancing is never due: it already holds the hold.
 * A Deployment that has never attempted one is due immediately, so enabling the setting takes effect at the next
 * wake rather than one interval later.
 *
 * A failed attempt moves that start too, which is the bound on retries: a failure waits the same interval as a
 * success rather than being retried at every wake. The failure itself stays visible in `latest`.
 */
export async function recoveryScheduleOf(env: ServerEnv, now: number, held?: RecoveryProducerStatus): Promise<RecoverySchedule> {
  const supported = env.recovery !== undefined;
  const intervalHours = await scheduledIntervalHours(env);
  // A caller that already read the producer hands that reading in: one response never reads it twice.
  const status = env.recovery === undefined ? null : held ?? await env.recovery.status();
  const latest = status === null ? null : latestOf(status);
  const available = status === null ? { state: 'none' as const } : availabilityOf(status);
  const readiness = env.recovery?.admission ?? { ready: false as const, reason: 'no producer' };
  const ready = readiness.ready;
  const idle = { supported, intervalHours, ready, dueAt: null, due: false, latest, available };

  if (!supported) {
    return { ...idle, configured: false, idleBecause: 'this Deployment runs no hosted recovery producer, so nothing automatic can run here' };
  }
  if (intervalHours === null) {
    return { ...idle, configured: false, intervalHours: null, idleBecause: 'automatic recovery is off: set "Back up every" to schedule it' };
  }
  // Configured by the owner and unable to run: the producer's own words say why, and no attempt is started.
  if (!ready) {
    return { ...idle, configured: true, idleBecause: `automatic recovery cannot run: ${readiness.ready ? '' : readiness.reason}` };
  }

  const advancing = latest !== null && !(RESTING as readonly string[]).includes(latest.stage);
  if (advancing) {
    return { ...idle, configured: true, idleBecause: `attempt ${latest!.attempt} is still ${latest!.stage}; the next one is due an interval after it starts` };
  }
  const startedAt = latest?.startedAt ?? null;
  const dueAt = startedAt === null ? now : startedAt + intervalHours * HOUR_MS;
  return { ...idle, configured: true, dueAt, due: dueAt <= now, idleBecause: null };
}
