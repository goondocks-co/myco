/**
 * The one way a hosted recovery attempt is admitted, for the owner who asks and the clock that is due.
 *
 * Admission is a sequence with a hold in the middle of it: the schema is captured while the Deployment still
 * answers, a hold is opened before any export runs, and only then does the producer take the attempt. It answers
 * a typed outcome: the HTTP handler turns those into responses, and the scheduled job into counts and telemetry.
 *
 * Nothing here chooses an account, a database or a credential: those are the Deployment's own bindings behind
 * `env.recovery`. Nothing here calls the clock either — a caller wakes the Deployment if it has a wake.
 */
import type { ServerEnv } from './adapters.js';
import { captureSchema, exportedTables, recoverableVirtualTables } from './recovery-schema.js';
import { capturedDefinitions, type RecoveryProducerStatus, type TableDefinitions } from './recovery-producer.js';
import { openHoldForAdmission } from './recovery-hold.js';
import { within } from './recovery-inventory.js';
import { classify, emit } from '../telemetry.js';

/** How long an admission may take to answer: its staging writes are bounded inside the producer, well within this. */
export const ADMISSION_MS = 120_000;

/**
 * Who an attempt records as having started it.
 *
 * A member admits one from the dashboard. The schedule admits one on an elapsed interval and carries no member:
 * nothing invents an identity for it, and `SCHEDULED_BY` is the value the staging records instead.
 */
export type AdmissionActor = { kind: 'member'; id: string } | { kind: 'schedule' };

/** What the staging records for an attempt the interval admitted. It is not a member id and never resolves to one. */
export const SCHEDULED_BY = 'schedule';

export const actorLabel = (actor: AdmissionActor): string => (actor.kind === 'member' ? actor.id : SCHEDULED_BY);

/**
 * Every way admission ends: `refused` and `unavailable` are this Deployment's own answer, `running` is an attempt
 * already advancing, and `unanswered` leaves a hold the release job settles later against the attempts.
 */
export type AdmissionOutcome =
  | { outcome: 'unavailable' }
  | { outcome: 'refused'; message: string }
  | { outcome: 'configuration-unavailable'; message: string }
  | { outcome: 'hold-unverified' }
  | { outcome: 'running'; status: RecoveryProducerStatus }
  | { outcome: 'unanswered' }
  | { outcome: 'hold-retired' }
  | { outcome: 'admitted'; status: RecoveryProducerStatus };

/** The schema an attempt is admitted against, or the refusal its own shape earns. */
async function capturedSchema(env: ServerEnv): Promise<{ text: string; tables: string[]; captured: TableDefinitions } | { message: string }> {
  const schema = await captureSchema(env.db);
  try {
    recoverableVirtualTables(schema);
  } catch (error) {
    // Refused before an export pauses the source, as the operator's own backup refuses it.
    return { message: error instanceof Error ? error.message : String(error) };
  }
  const tables = exportedTables(schema);
  if (tables.length === 0) return { message: 'this Deployment holds no ordinary tables to recover' };
  return { text: JSON.stringify(schema), tables, captured: capturedDefinitions(schema) };
}

/**
 * Admit one attempt: capture the schema first, then hand the producer the tables that schema names.
 *
 * At most one attempt advances at a time, and that is decided in the database rather than here: the hold this
 * opens is the producer's, one open hold per holder, so a second admission finds the first one's attempt and
 * answers `running`. A duplicate wake, or an owner pressing twice, therefore admits nothing new.
 */
export async function admitRecoveryExport(env: ServerEnv, now: number, actor: AdmissionActor): Promise<AdmissionOutcome> {
  if (env.recovery === undefined) return { outcome: 'unavailable' };
  const captured = await capturedSchema(env);
  if ('message' in captured) return { outcome: 'refused', message: captured.message };

  // The hold opens before the export is admitted, so nothing the snapshot names is released while the attempt
  // runs. A producer that cannot record this Deployment's configuration opens none, while an attempt already
  // running is still answered.
  const readiness = env.recovery.admission;
  const hold = await openHoldForAdmission(env, now, readiness.ready);
  if ('refused' in hold) {
    return { outcome: 'configuration-unavailable', message: readiness.ready ? 'the recovery configuration is unavailable' : readiness.reason };
  }
  if ('held' in hold) {
    if (hold.held === 'unverified') return { outcome: 'hold-unverified' };
    return { outcome: 'running', status: await env.recovery.status() };
  }

  // Bounded: an admission that does not answer keeps its hold, and the release job settles it later against the
  // attempts.
  const recovery = env.recovery;
  const status = await within(() => recovery.admit({
    holdToken: hold.token,
    tables: captured.tables,
    schema: captured.text,
    captured: captured.captured,
    startedBy: actorLabel(actor),
  }), ADMISSION_MS, () => Date.now()).catch((error: unknown) => {
    emit({ kind: 'recovery_admission_unanswered', error_class: classify(error) });
    return null;
  });
  if (status === null) return { outcome: 'unanswered' };
  if (status.holdRetired === true) return { outcome: 'hold-retired' };
  return { outcome: 'admitted', status };
}
