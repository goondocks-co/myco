/** Each agent's manifest declares its stored-key slot, accepted kinds and environment variables. */
import { RUNNER_HARNESSES } from './runner-harnesses.generated.js';
import type { SecretSlotName } from './secret-slots.js';

export type HarnessProvider = (typeof RUNNER_HARNESSES)[number]['credential']['provider'];
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
