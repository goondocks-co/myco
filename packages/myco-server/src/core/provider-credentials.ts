import type { RelationalStore, SecretWrappingKey } from './adapters.js';
import type { SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import { deploymentSecretStore } from './secrets.js';

/** Fixed-provider clients open only their own Deployment credential slot. */
export function openProviderCredential(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<string | null> {
  return deploymentSecretStore(db, key).get(provider);
}

/** Whether a fixed provider's slot holds a key this server can open, read without opening it. */
export async function providerCredentialReady(db: RelationalStore, key: SecretWrappingKey, provider: 'openai' | 'openrouter'): Promise<boolean> {
  const described = await deploymentSecretStore(db, key).describe(provider);
  return described.configured && described.readable;
}

/**
 * The key a harness's runs read from the slot `HARNESS_CREDENTIALS` names for it, and from no other: an empty slot
 * answers null, and the run uses the worker's own login.
 */
export function openHarnessCredential(db: RelationalStore, key: SecretWrappingKey, slot: SecretSlotName): Promise<string | null> {
  return deploymentSecretStore(db, key).get(slot);
}
