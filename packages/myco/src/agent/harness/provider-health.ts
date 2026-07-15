// packages/myco/src/agent/harness/provider-health.ts
import type { ProviderConfig, ProviderType } from '@myco/agent/types.js';
import { OllamaBackend } from '@myco/intelligence/ollama.js';
import { LmStudioBackend } from '@myco/intelligence/lm-studio.js';
import { OPENAI_API_KEY_ENV, OPENROUTER_API_KEY_ENV } from '@myco/providers/env.js';

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

/** Result of a provider availability preflight. `reason` is set only for a
 *  keyless cloud provider — a local-reachability failure carries no reason,
 *  matching the pre-existing boolean semantics for that case. */
export interface ProviderAvailability {
  available: boolean;
  reason?: 'missing_key';
}

// Cloud provider types that authenticate with a stored API key. Local
// backends (ollama/lmstudio) and openai-compatible endpoints never need one
// here — they either need no auth or send a placeholder (server-mode design
// spec §5's key-exfil invariant: only these three types ever read a real
// secret out of the env). Env var names mirror the resolvers each harness
// actually reads at call time (`agent/harness/openai.ts`'s
// PROVIDER_CLIENT_CONFIG_RESOLVERS, `agent/provider.ts`'s ANTHROPIC_API_KEY)
// so this check can never drift from what a dispatch would actually use.
export const KEYED_CLOUD_PROVIDER_ENV: Partial<Record<ProviderType, string[]>> = {
  anthropic: ['ANTHROPIC_API_KEY'],
  openai: [OPENAI_API_KEY_ENV, 'OPENAI_API_KEY'],
  openrouter: [OPENROUTER_API_KEY_ENV],
};

/**
 * Missing-key reason for a resolved provider, or `undefined` when the
 * provider needs no stored key (local/openai-compatible, or a cloud
 * provider whose key is already present in `process.env` — grove secrets,
 * machine secrets, and inherited shell/launchd env are indistinguishable
 * once loaded, by design; `loadLayeredSecrets` owns precedence between
 * them). `provider` undefined means no explicit override — the claude-sdk
 * default (CLI subscription auth), which needs no key at all.
 */
export function missingKeyReason(provider: ProviderConfig | undefined): 'missing_key' | undefined {
  if (!provider) return undefined;
  const envVars = KEYED_CLOUD_PROVIDER_ENV[provider.type];
  if (!envVars) return undefined;
  const hasKey = envVars.some((name) => !!process.env[name]);
  return hasKey ? undefined : 'missing_key';
}

export async function probeProviderAvailable(
  provider: ProviderConfig | undefined,
  opts?: { now?: () => number },
): Promise<ProviderAvailability> {
  const now = opts?.now ?? Date.now;

  // Missing-key check runs BEFORE the reachability probe below and is never
  // cached — key presence is a cheap env/file-backed check, not a network
  // round-trip, so there is no reason to risk serving a stale TTL'd verdict
  // once an operator adds a key mid-schedule.
  const keyReason = missingKeyReason(provider);
  if (keyReason) return { available: false, reason: keyReason };

  // Only local providers have a meaningful reachability probe. Cloud/unknown
  // providers are assumed reachable; a genuine cloud outage still surfaces as a
  // connection-class per-item error (Task A4) and is handled there.
  // Probe ollama/lmstudio OR any provider with an explicit baseUrl (covers an
  // openai-compatible LM Studio at a remote IP). Cloud-with-no-baseUrl → true;
  // A4's in-flight classifier is the provider-type-agnostic safety net.
  const probeable = provider && (provider.type === 'ollama' || provider.type === 'lmstudio'
    || (typeof provider.baseUrl === 'string' && provider.baseUrl.length > 0));
  if (!probeable) return { available: true };
  const key = `${provider.type} ${provider.baseUrl ?? ''}`;
  const hit = cache.get(key);
  if (hit && now() - hit.at < AVAILABILITY_TTL_MS) return { available: hit.value };
  let value = false;
  try {
    value = await backendFactory(provider.type, provider.baseUrl).isAvailable();
  } catch {
    value = false;
  }
  cache.set(key, { value, at: now() });
  return { available: value };
}
