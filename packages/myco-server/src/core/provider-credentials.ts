import type { RelationalStore, SecretWrappingKey } from './adapters.js';
import type { SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import { deploymentSecretStore } from './secrets.js';

/** Fixed-provider clients open only their own Deployment credential slot. */
export function openProviderCredential(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<string | null> {
  return deploymentSecretStore(db, key).get(provider);
}

/**
 * The key a harness's runs read from the slot `HARNESS_CREDENTIALS` names for it, and from no other: an empty slot
 * answers null, and the run uses the worker's own login.
 */
export function openHarnessCredential(db: RelationalStore, key: SecretWrappingKey, slot: SecretSlotName): Promise<string | null> {
  return deploymentSecretStore(db, key).get(slot);
}
