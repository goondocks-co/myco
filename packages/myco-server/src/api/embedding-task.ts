import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { heldRun } from './run-admission.js';
import { advanceEmbedding } from '../core/embedding/step.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';

/** Only the credential holding a live embedding run may advance its project's index. */
export async function handleEmbeddingStep(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  let body: unknown;
  try { body = JSON.parse(ctx.body); } catch { body = null; }
  const runId = body !== null && typeof body === 'object' ? (body as { runId?: unknown }).runId : undefined;
  if (typeof runId !== 'string' || runId.length === 0 || runId.length > 192) return Response.json(refused(ctx, refusal('embedding step requires runId', 'parse')));
  const run = await heldRun(env, ctx, runId, ['embedding-reconcile']);
  if (run === null) return Response.json({ persisted: true, held: false });
  if (run.dryRun === 1) return Response.json({ persisted: true, held: true, phase: 'settled', processed: 0 });
  return Response.json({ persisted: true, held: true, ...await advanceEmbedding(env, ctx.projectId, ctx.now) });
}
