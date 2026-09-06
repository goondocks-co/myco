import type { RelationalStore, SecretWrappingKey } from './adapters.js';
import { deploymentSecretStore } from './secrets.js';

/** Fixed-provider clients open only their own Deployment credential slot. */
export function openProviderCredential(db: RelationalStore, key: SecretWrappingKey, provider: 'anthropic' | 'openai' | 'openrouter'): Promise<string | null> {
  return deploymentSecretStore(db, key).get(provider);
}
