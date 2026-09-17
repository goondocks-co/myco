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
  const status = await env.recovery.admit({
    tables: captured.tables,
    schema: captured.text,
    captured: captured.captured,
    configuration: { startedBy: ctx.member.id },
    credentialsRequired: [],
  });
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
