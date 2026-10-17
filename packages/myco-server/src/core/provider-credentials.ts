import type { RelationalStore, SecretWrappingKey } from './adapters.js';
import type { SecretSlotName } from '@goondocks/myco-shared/secret-slots';
import { deploymentSecretStore, SecretOpenError, SecretValueError } from './secrets.js';

/** Fixed-provider clients open only their own Deployment credential slot. */
export function openProviderCredential(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<string | null> {
  return deploymentSecretStore(db, key).get(provider);
}

/** Whether a fixed provider's slot holds a key this server can open, read without opening it. */
export async function providerCredentialReady(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<boolean> {
  const described = await deploymentSecretStore(db, key).describe(provider);
  return described.configured && described.readable;
}

/** Open only the selected agent's slot; empty or unreadable credentials hold its run. */
export async function openHarnessCredential(db: RelationalStore, key: SecretWrappingKey, slot: SecretSlotName): Promise<string | null> {
  try { return await deploymentSecretStore(db, key).get(slot); }
  catch (error) {
    if (error instanceof SecretOpenError || error instanceof SecretValueError) return null;
    throw error;
  }
}
