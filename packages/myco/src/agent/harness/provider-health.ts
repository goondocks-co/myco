// packages/myco/src/agent/harness/provider-health.ts
import type { ProviderConfig } from '@myco/agent/types.js';
import { OllamaBackend } from '@myco/intelligence/ollama.js';
import { LmStudioBackend } from '@myco/intelligence/lm-studio.js';

const AVAILABILITY_TTL_MS = 5_000;

interface Probeable { isAvailable(): Promise<boolean>; }
// type is ProviderConfig.type; baseUrl is ProviderConfig.baseUrl (camelCase),
// forwarded to the backend ctor as { base_url } (snake_case — must-fix #2).
type BackendFactory = (type: string, baseUrl?: string) => Probeable;

let backendFactory: BackendFactory = (type, baseUrl) =>
  type === 'ollama' ? new OllamaBackend({ base_url: baseUrl }) : new LmStudioBackend({ base_url: baseUrl });

const cache = new Map<string, { value: boolean; at: number }>();

export function __setProviderHealthBackendFactory(f: BackendFactory): void { backendFactory = f; }
export function __resetProviderHealthCache(): void { cache.clear(); }

export async function probeProviderAvailable(
  provider: ProviderConfig | undefined,
  opts?: { now?: () => number },
): Promise<boolean> {
  const now = opts?.now ?? Date.now;
  // Only local providers have a meaningful reachability probe. Cloud/unknown
  // providers are assumed reachable; a genuine cloud outage still surfaces as a
  // connection-class per-item error (Task A4) and is handled there.
  // Probe ollama/lmstudio OR any provider with an explicit baseUrl (covers an
  // openai-compatible LM Studio at a remote IP). Cloud-with-no-baseUrl → true;
  // A4's in-flight classifier is the provider-type-agnostic safety net.
  const probeable = provider && (provider.type === 'ollama' || provider.type === 'lmstudio'
    || (typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0));
  if (!probeable) return true;
  const key = `${provider.type} ${provider.baseUrl ?? ''}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < AVAILABILITY_TTL_MS) return hit.value;
  let value = false;
  try {
    value = await backendFactory(provider.type, provider.baseUrl).isAvailable();
  } catch {
    value = false;
  }
  cache.set(key, { value, at: now() });
  return value;
}
