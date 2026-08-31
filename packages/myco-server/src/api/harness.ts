/**
 * The harness runtime probe: the acceptance surface for a held runtime.
 *
 * An owner asks the Deployment to start a held runtime and exchange one
 * request with it. A target without one answers a refusal naming the
 * capability, which local dev and the parity harness treat as the expected
 * answer.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { emit } from '../telemetry.js';
import { badRequest, ok, readJsonObject } from './scope.js';

export async function handleHarnessProbe(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  if (env.harnessProbe === undefined) {
    return Response.json({ error: 'harness_unavailable', message: 'this deployment has no harness runtime bound' }, { status: 409 });
  }
  const body = await readJsonObject(ctx.request);
  if (body === null) return badRequest('body must be a JSON object');
  const timeoutSeconds = typeof body.timeoutSeconds === 'number' && body.timeoutSeconds > 0 && body.timeoutSeconds <= 600 ? body.timeoutSeconds : 120;
  // One well-known runtime, reused: a fresh name per call would strand a warm
  // container per probe until its idle window ends, and the fleet is finite.
  const runId = 'probe';
  const answer = await env.harnessProbe(runId, timeoutSeconds);
  emit({ kind: 'harness_probe', runId, actor: ctx.member.id });
  return ok({ runId, timeoutSeconds, ...answer });
}
