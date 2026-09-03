/**
 * An owner's wake: run the Deployment's housekeeping now and answer what it did.
 *
 * The same tick a target's own timer delivers, asked for by a person — the
 * button on the Operations page and the parity harness both drive it here.
 */
import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { runTick } from '../core/tick.js';
import { emit } from '../telemetry.js';
import { ok } from './scope.js';

export async function handleWake(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const report = await runTick(env, ctx.now);
  emit({ kind: 'wake_requested', actor: ctx.member.id, state: report.state });
  return ok(report);
}
