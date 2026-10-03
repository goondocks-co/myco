import type { ServerEnv } from '../core/adapters.js';
import type { CredentialContext } from '../context.js';
import { parseProvisionedHarnessReport, recordProvisionedHarnessReport } from '../core/harness-health.js';
import { ok, parseJsonObject } from './scope.js';

/** A member reports only its own machine's provisioned harnesses. */
export async function handleProvisionedHarnessReport(env: ServerEnv, ctx: CredentialContext): Promise<Response> {
  const report = parseProvisionedHarnessReport(parseJsonObject(ctx.body));
  if (report === null) return ok({ persisted: false, code: 'invalid_field', reason: 'Send the agents set up on this machine, with one action for each that needs help' });
  await recordProvisionedHarnessReport(env.db, ctx.machineId, report, ctx.now);
  return ok({ persisted: true });
}
