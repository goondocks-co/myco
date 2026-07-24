import {
  deleteSecrets,
  readSecrets,
  writeSecret,
} from '@myco/config/secrets.js';
import { normalizeRawSecretInput } from '@myco/daemon/api/secret-input.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { OPENAI_API_KEY_ENV, OPENROUTER_API_KEY_ENV } from '@myco/providers/env.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import { GITHUB_TOKEN_ENV } from '../../release-provenance/github.js';
import {
  nativePerUserLockNamespace,
  type PerUserLockNamespace,
} from '@myco/utils/per-user-lock-namespace.js';

const SECRET_PREVIEW_PREFIX_CHARS = 8;
const SECRET_PREVIEW_SUFFIX_CHARS = 4;

type SecretProvider = 'openai' | 'openrouter' | 'github';
// These are machine-level keys stored in `~/.myco/secrets.env`. The only scope
// is 'machine'; the legacy 'project' scope was removed — project-level provider
// secrets were migrated to grove/team scope (which live in their own stores and
// are managed by other code paths), so 'project' had no live writer and its only
// remaining effect was leaking reads/deletes to the bootstrap-anchor vault.
type SecretScope = 'machine';
type SecretSource = SecretScope | 'env' | 'none';
type SecretStore = { scope: SecretScope; dir: string };

interface SecretInfo {
  configured: boolean;
  envKey: string;
  maskedValue: string | null;
  source: SecretSource;
  sourceScope: SecretScope | null;
  defaultScope: SecretScope;
  availableScopes: SecretScope[];
}

interface SecretDefinition {
  envKey: string;
  defaultScope: SecretScope;
  availableScopes: SecretScope[];
  readScopes: SecretScope[];
}

const SECRET_DEFINITIONS: Record<SecretProvider, SecretDefinition> = {
  openai: {
    envKey: OPENAI_API_KEY_ENV,
    defaultScope: 'machine',
    availableScopes: ['machine'],
    readScopes: ['machine'],
  },
  openrouter: {
    envKey: OPENROUTER_API_KEY_ENV,
    defaultScope: 'machine',
    availableScopes: ['machine'],
    readScopes: ['machine'],
  },
  github: {
    envKey: GITHUB_TOKEN_ENV,
    defaultScope: 'machine',
    availableScopes: ['machine'],
    readScopes: ['machine'],
  },
};

function isSecretProvider(value: string): value is SecretProvider {
  return value === 'openai' || value === 'openrouter' || value === 'github';
}

function maskSecret(secret: string): string {
  if (secret.length <= SECRET_PREVIEW_PREFIX_CHARS + SECRET_PREVIEW_SUFFIX_CHARS) {
    return '*'.repeat(secret.length);
  }
  return `${secret.slice(0, SECRET_PREVIEW_PREFIX_CHARS)}${'*'.repeat(secret.length - SECRET_PREVIEW_PREFIX_CHARS - SECRET_PREVIEW_SUFFIX_CHARS)}${secret.slice(-SECRET_PREVIEW_SUFFIX_CHARS)}`;
}

function buildSecretInfo(provider: SecretProvider): SecretInfo {
  const definition = SECRET_DEFINITIONS[provider];
  const envKey = definition.envKey;
  const stored = readEffectiveStoredSecret(provider);
  const envValue = process.env[envKey];
  const envOverridesStored = Boolean(envValue) && (!stored || envValue !== stored.value);
  const effectiveValue = envOverridesStored ? envValue : (stored?.value ?? envValue);
  const source: SecretSource = envOverridesStored
    ? 'env'
    : stored?.scope ?? (envValue ? 'env' : 'none');

  return {
    configured: Boolean(effectiveValue),
    envKey,
    maskedValue: effectiveValue ? maskSecret(effectiveValue) : null,
    source,
    sourceScope: stored?.scope ?? null,
    defaultScope: definition.defaultScope,
    availableScopes: definition.availableScopes,
  };
}

function getSecretInfo(provider: SecretProvider): SecretInfo {
  return buildSecretInfo(provider);
}

// These routes are intentionally machine-scoped (daemon-global), not
// tenant-scoped: they read and write `~/.myco/secrets.env`, which holds
// machine-level keys shared across every project the daemon serves. They are
// deliberately NOT wrapped in `tenantRoute` — a future CI gate should allowlist
// them as machine-scoped rather than flag them as missing tenant scoping.
export async function handleGetProviderSecrets(_req?: RouteRequest): Promise<RouteResponse> {
  return {
    body: {
      secrets: {
        openai: buildSecretInfo('openai'),
        openrouter: buildSecretInfo('openrouter'),
        github: buildSecretInfo('github'),
      },
    },
  };
}

export async function handlePutProviderSecret(
  req: RouteRequest,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): Promise<RouteResponse> {
  const provider = req.params.provider;
  const body = req.body as { api_key?: unknown; secret?: unknown; scope?: SecretScope } | undefined;

  if (!provider || !isSecretProvider(provider)) {
    return { status: 400, body: { error: 'provider must be one of: openai, openrouter, github' } };
  }
  const raw = body?.secret ?? body?.api_key;
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  const normalized = normalizeRawSecretInput(
    envKey,
    raw,
    { status: 400, body: { error: 'secret is required' } },
  );
  if (!normalized.ok) return normalized.response;

  const scope = body?.scope ?? SECRET_DEFINITIONS[provider].defaultScope;
  const store = resolveWritableSecretStore(provider, scope);
  if (isRouteResponse(store)) return store;

  const secret = normalized.value;
  writeSecret(store.dir, envKey, secret, lockNamespace);
  setProcessSecret(provider, secret);

  return {
    body: {
      provider,
      secret: getSecretInfo(provider),
    },
  };
}

export async function handleDeleteProviderSecret(
  req: RouteRequest,
  lockNamespace: PerUserLockNamespace = nativePerUserLockNamespace,
): Promise<RouteResponse> {
  const provider = req.params.provider;
  if (!provider || !isSecretProvider(provider)) {
    return { status: 400, body: { error: 'provider must be one of: openai, openrouter, github' } };
  }

  const requestedScope = req.query.scope;
  const scope = parseSecretScope(requestedScope);
  if (requestedScope !== undefined && !scope) {
    return { status: 400, body: { error: 'scope must be one of: machine' } };
  }
  if (scope && !SECRET_DEFINITIONS[provider].availableScopes.includes(scope)) {
    return { status: 400, body: { error: `scope ${scope} is not available for ${provider}` } };
  }

  const scopes = scope ? [scope] : SECRET_DEFINITIONS[provider].availableScopes;
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  for (const targetScope of scopes) {
    const store = resolveSecretStore(targetScope);
    deleteSecrets(store.dir, [envKey], lockNamespace);
  }
  refreshProcessSecret(provider);

  return {
    body: {
      provider,
      secret: getSecretInfo(provider),
    },
  };
}

function parseSecretScope(value: unknown): SecretScope | null {
  return value === 'machine' ? value : null;
}

function readEffectiveStoredSecret(
  provider: SecretProvider,
): { scope: SecretScope; value: string } | null {
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  let found: { scope: SecretScope; value: string } | null = null;
  for (const scope of SECRET_DEFINITIONS[provider].readScopes) {
    const store = resolveSecretStore(scope);
    const value = readSecrets(store.dir)[envKey];
    if (value) found = { scope, value };
  }
  return found;
}

function resolveWritableSecretStore(
  provider: SecretProvider,
  scope: SecretScope,
): SecretStore | RouteResponse {
  if (!SECRET_DEFINITIONS[provider].availableScopes.includes(scope)) {
    return { status: 400, body: { error: `scope ${scope} is not available for ${provider}` } };
  }
  return resolveSecretStore(scope);
}

function resolveSecretStore(scope: SecretScope): SecretStore {
  return { scope, dir: resolveMycoHome() };
}

function isRouteResponse(value: SecretStore | RouteResponse): value is RouteResponse {
  return typeof (value as SecretStore).dir !== 'string';
}

function setProcessSecret(provider: SecretProvider, secret: string): void {
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  process.env[envKey] = secret;
  if (provider === 'openai') {
    process.env.OPENAI_API_KEY = secret;
  }
}

function refreshProcessSecret(provider: SecretProvider): void {
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  const stored = readEffectiveStoredSecret(provider);
  if (stored) {
    setProcessSecret(provider, stored.value);
  } else {
    delete process.env[envKey];
    if (provider === 'openai') {
      delete process.env.OPENAI_API_KEY;
    }
  }
}
