import { readRunFields } from './run-fields.js';
import type { ServerEnv } from '../core/adapters.js';
import type { RouteContext } from '../context.js';
import { CONTROL_TASKS, heldRun } from './run-admission.js';
import { advanceEmbedding } from '../core/embedding/step.js';
import { refused } from '../ingest/events.js';
import { refusal } from '../telemetry.js';

/** Only the credential holding a live embedding run may advance its project's index. */
export async function handleEmbeddingStep(env: ServerEnv, ctx: RouteContext): Promise<Response> {
  const body = readRunFields(ctx.body, '/runs/embedding-step');
  if (body === null || body.runId === null) return Response.json(refused(ctx, refusal('embedding step requires runId', 'parse')));
  const runId = body.runId;
  const run = await heldRun(env, ctx, runId, CONTROL_TASKS['/runs/embedding-step']!);
  if (run === null) return Response.json({ persisted: true, held: false });
  if (run.dryRun === 1) return Response.json({ persisted: true, held: true, phase: 'settled', processed: 0 });
  return Response.json({ persisted: true, held: true, ...await advanceEmbedding(env, ctx.projectId, ctx.now) });
}
