/**
 * Which provider each harness authenticates against, and the variable it reads
 * its credential under.
 *
 * A harness is not a provider: `claude` reads Anthropic's variables and `agy`
 * reads Google's, and handing one the other's key is a failure that looks like
 * a bad credential rather than like a wrong table. The server opens a
 * Deployment secret by this, and the worker's manifest declares the same ids,
 * so the two cannot name different harnesses.
 *
 * Each harness declares its own in its manifest's `runner.credential`. A harness
 * with none has no Deployment credential to inject and runs under its own login,
 * which is the ordinary case on a machine a person uses.
 *
 * A harness reads the Deployment secret slot named here and no other
 * (`secret-slots.ts`): a shared provider slot, or a slot of its own its manifest
 * declares (a key stored for embeddings is not a login for every run of a
 * harness that reads OpenAI's variables, #1212). A harness whose slot is null,
 * or empty, runs under the worker machine's own login.
 */
import { RUNNER_HARNESSES } from './runner-harnesses.generated.js';
import type { SecretSlotName } from './secret-slots.js';

export type HarnessProvider = 'anthropic' | 'openai' | 'google';
export type HarnessCredentialKind = 'api-key' | 'subscription';
const SUBSCRIPTION_TOKEN_PREFIX = 'sk-ant-oat';

export interface HarnessCredential {
  provider: HarnessProvider;
  /** The Deployment secret slot the harness's runs read, or null where the Deployment holds none for it. */
  slot: SecretSlotName | null;
  /** The variables the harness reads, in the order a value is matched to one. */
  variables: readonly string[];
  /** Credential kinds this harness can use from its Deployment slot. Omitted means API keys only. */
  accepts?: readonly HarnessCredentialKind[];
}

/** Each harness's credential, from its manifest's `runner.credential` (`runner-harnesses.generated.ts`), in the order a worker ranks them. */
export const HARNESS_CREDENTIALS: Readonly<Record<string, HarnessCredential>> = Object.fromEntries(
  RUNNER_HARNESSES.map((harness) => [harness.id, harness.credential as HarnessCredential]),
);

/** The environment a harness can use for this credential; unsupported kinds inject nothing. */
export function credentialEnvFor(harness: string, key: string): Record<string, string> {
  const declared = HARNESS_CREDENTIALS[harness];
  if (declared === undefined || declared.slot === null || key.length === 0) return {};
  const kind = credentialKind(key);
  if (!(declared.accepts ?? ['api-key']).includes(kind)) return {};
  const variable = kind === 'subscription' ? declared.variables[0] : declared.variables.at(-1);
  return variable === undefined ? {} : { [variable]: key };
}

const credentialKind = (key: string): HarnessCredentialKind => key.startsWith(SUBSCRIPTION_TOKEN_PREFIX) ? 'subscription' : 'api-key';

/** A retained provider runtime uses the same credential-kind declaration as its driver. */
export function providerCredentialEnv(provider: HarnessProvider, key: string): Record<string, string> {
  const kind = credentialKind(key);
  const harness = Object.entries(HARNESS_CREDENTIALS).find(([, declared]) => declared.provider === provider && (declared.accepts ?? ['api-key']).includes(kind));
  return harness === undefined ? {} : credentialEnvFor(harness[0], key);
}
