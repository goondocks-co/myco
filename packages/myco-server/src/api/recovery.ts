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
import { captureSchema, exportedTables, recoverableVirtualTables } from '../core/recovery-schema.js';
import { capturedDefinitions, type RecoveryProducerStatus, type TableDefinitions } from '../core/recovery-producer.js';
import { badRequest, ok } from './scope.js';
import { openHoldForAdmission } from '../core/recovery-hold.js';
import { within } from '../core/recovery-inventory.js';
import { classify, emit } from '../telemetry.js';

/** How long an admission may take to answer: its staging writes are bounded inside the producer, well within this. */
const ADMISSION_MS = 120_000;

/** What an owner is told: the attempt's progress, and plainly that no staging, complete or not, is recoverable yet. */
const answer = (status: RecoveryProducerStatus): Response => ok({
  ...status,
  recoverable: false,
  usable: 'a staging becomes recoverable only when an operator materializes it into a verified artifact; a complete staging is not yet one',
});

const unavailable = (): Response => badRequest('this Deployment runs no hosted recovery producer');

async function capturedSchema(env: ServerEnv): Promise<{ text: string; tables: string[]; captured: TableDefinitions } | Response> {
  const schema = await captureSchema(env.db);
  try {
    recoverableVirtualTables(schema);
  } catch (error) {
    // Refused before an export pauses the source, as the operator's own backup refuses it.
    return badRequest(error instanceof Error ? error.message : String(error));
  }
  const tables = exportedTables(schema);
  if (tables.length === 0) return badRequest('this Deployment holds no ordinary tables to recover');
  return { text: JSON.stringify(schema), tables, captured: capturedDefinitions(schema) };
}

/** Admit one attempt: capture the schema first, then hand the producer the tables that schema names. */
export async function handleStartRecoveryExport(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.recovery === undefined) return unavailable();
  const captured = await capturedSchema(env);
  if (captured instanceof Response) return captured;
  // The hold opens before the export is admitted, so nothing the snapshot names is released while the attempt runs.
  const hold = await openHoldForAdmission(env, ctx.now);
  if ('held' in hold) {
    if (hold.held === 'unverified') {
      return Response.json({ error: 'recovery_hold_unverified', message: 'a recovery hold is open and its attempt could not be read; try again shortly' }, { status: 503 });
    }
    return answer(await env.recovery.status());
  }
  // Bounded: an admission that does not answer keeps its hold, and the release job settles it later against the attempts.
  const recovery = env.recovery;
  const status = await within(() => recovery.admit({
    holdToken: hold.token,
    tables: captured.tables,
    schema: captured.text,
    captured: captured.captured,
    configuration: { startedBy: ctx.member.id },
    credentialsRequired: [],
  }), ADMISSION_MS, Date.now).catch((error: unknown) => {
    // An admission that failed or never answered keeps its hold: the release job settles it against the attempts.
    emit({ kind: 'recovery_admission_unanswered', error_class: classify(error) });
    return null;
  });
  if (status === null) {
    return Response.json({ error: 'recovery_admission_unanswered', message: 'the export admission failed or did not answer in time; its hold is settled by a later wake, and a status read shows whether it was admitted' }, { status: 503 });
  }
  if (status.holdRetired === true) {
    return Response.json({ error: 'recovery_hold_retired', message: 'the recovery hold for this admission was already settled; start the export again' }, { status: 409 });
  }
  // The wake the Deployment already has: an admitted attempt is continued at the next wake, and a sleeping
  // Deployment waits for its cron floor without one. The producer never calls the clock itself.
  await env.wake?.().catch(() => undefined);
  return answer(status);
}

/**
 * The attempt's progress. Nothing is re-read from the Deployment here: whether the exported bytes match the schema
 * the attempt captured is decided in the producer's own work, against those bytes, and a later legitimate migration
 * must never invalidate a snapshot that is whole as taken.
 */
export async function handleRecoveryExportStatus(env: ServerEnv, _ctx: OwnerContext): Promise<Response> {
  if (env.recovery === undefined) return unavailable();
  return answer(await env.recovery.status());
}
