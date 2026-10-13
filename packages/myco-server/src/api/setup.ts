import type { ServerEnv } from '../core/adapters.js';
import type { OwnerContext } from '../context.js';
import { readSetupIdentity, readSetupProgress, type SetupIdentity, type SetupObservations } from '../read/setup.js';
import { machineScope } from './machines.js';
import { ok } from './scope.js';

export type SetupProgress = SetupObservations & SetupIdentity & { signInWorking: boolean };

/** The admitted dashboard session proves sign-in works; observations expose no account or credential material. */
export async function handleSetup(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const [observations, identity] = await Promise.all([
    readSetupProgress(env, machineScope(ctx), ctx.now),
    readSetupIdentity(env.db, ctx.member.id),
  ]);
  return ok({ ...observations, ...identity, signInWorking: true } satisfies SetupProgress);
}
