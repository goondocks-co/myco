import type { RelationalStore, SecretWrappingKey } from './adapters.js';
import { deploymentSecretStore } from './secrets.js';

/** Fixed-provider clients open only their own Deployment credential slot. */
export function openProviderCredential(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<string | null> {
  return deploymentSecretStore(db, key).get(provider);
}

/** Whether a fixed provider's slot holds a key this server can open, read without opening it. */
export async function providerCredentialReady(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<boolean> {
  const described = await deploymentSecretStore(db, key).describe(provider);
  return described.configured && described.readable;
}

/** The optional key for the operator-selected single-turn endpoint. */
export function openCompletionCredential(db: RelationalStore, key: SecretWrappingKey): Promise<string | null> {
  return deploymentSecretStore(db, key).get('single-turn');
}
