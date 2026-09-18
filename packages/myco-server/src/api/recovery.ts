/**
 * The hosted recovery producer's owner surface: start one export attempt, and read what it staged.
 *
 * The schema is captured here, before any export runs, while the Deployment's database still answers: it stops
 * answering queries for as long as its export runs. Nothing a caller sends chooses the account, the database or the credential: those come from
 * the Deployment's own bindings behind `env.recovery`. What this answers is a staging's progress, never a
 * recoverable artifact: a complete staging holds the export and every object its rows name, and becomes recoverable
 * only when an operator materializes it into a verified artifact.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import type { RecoveryProducerStatus } from '../core/recovery-producer.js';
import { admitRecoveryExport, type AdmissionOutcome } from '../core/recovery-admission.js';
import { recoveryScheduleOf, type RecoverySchedule } from '../core/recovery-schedule.js';
import { badRequest, ok } from './scope.js';
import { openOperatorHold } from '../core/recovery-hold.js';
import { within } from '../core/recovery-inventory.js';
import { classify, emit } from '../telemetry.js';

/**
 * What an owner is told: the attempt's progress, plainly that no staging, complete or not, is recoverable yet, and any
 * operator backup holding this Deployment's objects. That hold defers deletion while it is open, so storage grows by
 * what deletion would have freed until the operator's artifact completes or it gives the attempt up.
 */
const answer = (status: RecoveryProducerStatus, operatorHold: OperatorHoldReport, schedule: ScheduleReport): Response => ok({
  ...status,
  recoverable: false,
  usable: 'a staging becomes recoverable only when an operator materializes it into a verified artifact; a complete staging is not yet one',
  operatorHold,
  schedule,
});

/**
 * What automatic recovery is doing, or that it could not be read.
 *
 * The schedule is read from this Deployment's own settings, and a running export pauses that database. The
 * producer's answer is already in hand by then, so an unreadable schedule says so and never decides the response.
 */
type ScheduleReport = RecoverySchedule | { unreadable: string };

/** How long the schedule read may take before the answer says it is unreadable. */
const SCHEDULE_MS = 5_000;

const scheduleOf = async (env: ServerEnv, now: number, status: RecoveryProducerStatus): Promise<ScheduleReport> => {
  try {
    return await within(() => recoveryScheduleOf(env, now, status), SCHEDULE_MS, Date.now);
  } catch (error) {
    emit({ kind: 'recovery_schedule_unreadable', error_class: classify(error) });
    return { unreadable: 'whether automatic recovery is configured could not be read; a running export pauses its database' };
  }
};

/**
 * An operator backup's hold as an owner reads it: its acquisition instant, and what it means while it is open. It is the one
 * part of this answer that comes from the Deployment's database rather than the producer, so it is bounded and never
 * decides the answer: a database that cannot be read while an export has it paused says so, and never says that no
 * backup holds this Deployment.
 */
type OperatorHoldReport =
  | { open: true; acquiredAt: number; defers: string }
  | { open: false }
  | { open: 'unknown'; reason: string };

/** How long the hold read may take before the answer says it is unknown; the producer's answer is already in hand. */
const OPERATOR_HOLD_MS = 5_000;

const operatorHoldOf = async (env: ServerEnv): Promise<OperatorHoldReport> => {
  try {
    const held = await within(() => openOperatorHold(env), OPERATOR_HOLD_MS, Date.now);
    return held === null
      ? { open: false }
      : { open: true, acquiredAt: held.acquiredAt, defers: 'an operator backup holds every object this Deployment registers: deletions are recorded and deferred, and storage grows by what they would have freed, until that backup completes or is given up' };
  } catch (error) {
    emit({ kind: 'recovery_operator_hold_unreadable', error_class: classify(error) });
    return { open: 'unknown', reason: 'whether an operator backup holds this Deployment could not be read; a running export pauses its database' };
  }
};

const unavailable = (): Response => badRequest('this Deployment runs no hosted recovery producer');

/**
 * What each admission outcome is, as an owner's request: the same statuses and envelopes this route has always
 * answered. The sequence itself belongs to `admitRecoveryExport`, which the schedule uses too.
 */
function responseFor(outcome: AdmissionOutcome): Response | null {
  switch (outcome.outcome) {
    case 'unavailable': return unavailable();
    case 'refused': return badRequest(outcome.message);
    case 'configuration-unavailable':
      return Response.json({ error: 'recovery_configuration_unavailable', message: outcome.message }, { status: 503 });
    case 'hold-unverified':
      return Response.json({ error: 'recovery_hold_unverified', message: 'a recovery hold is open and its attempt could not be read; try again shortly' }, { status: 503 });
    case 'unanswered':
      return Response.json({ error: 'recovery_admission_unanswered', message: 'the export admission failed or did not answer in time; its hold is settled by a later wake, and a status read shows whether it was admitted' }, { status: 503 });
    case 'hold-retired':
      return Response.json({ error: 'recovery_hold_retired', message: 'the recovery hold for this admission was already settled; start the export again' }, { status: 409 });
    // An attempt already running, or one just admitted, is answered with its own status.
    default: return null;
  }
}

/** Admit one attempt, through the owner both this route and the schedule use. */
export async function handleStartRecoveryExport(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.recovery === undefined) return unavailable();
  const admitted = await admitRecoveryExport(env, ctx.now, { kind: 'member', id: ctx.member.id });
  const refusal = responseFor(admitted);
  if (refusal !== null) return refusal;
  if (admitted.outcome === 'admitted') {
    // The wake the Deployment already has: an admitted attempt is continued at the next wake, and a sleeping
    // Deployment waits for its cron floor without one. The producer never calls the clock itself.
    await env.wake?.().catch(() => undefined);
  }
  const status = (admitted as { status: RecoveryProducerStatus }).status;
  return answer(status, await operatorHoldOf(env), await scheduleOf(env, ctx.now, status));
}

/**
 * The attempt's progress, and what automatic recovery is doing. Nothing is re-read from the Deployment here:
 * whether the exported bytes match the schema the attempt captured is decided in the producer's own work, against
 * those bytes, and a later legitimate migration must never invalidate a snapshot that is whole as taken.
 */
export async function handleRecoveryExportStatus(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.recovery === undefined) return unavailable();
  const status = await env.recovery.status();
  return answer(status, await operatorHoldOf(env), await scheduleOf(env, ctx.now, status));
}
