import { deleteSecrets, readSecrets, writeSecret } from '@myco/config/secrets.js';
import { resolveMycoHome } from '@myco/grove/paths.js';
import { OPENAI_API_KEY_ENV } from '../../cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '../../cli/providers/openrouter.js';
import type { RouteRequest, RouteResponse } from '../router.js';
import { GITHUB_TOKEN_ENV } from '../../release-provenance/github.js';

const SECRET_PREVIEW_PREFIX_CHARS = 8;
const SECRET_PREVIEW_SUFFIX_CHARS = 4;

type SecretProvider = 'openai' | 'openrouter' | 'github';
type SecretScope = 'machine' | 'project';
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
    readScopes: ['project', 'machine'],
  },
  openrouter: {
    envKey: OPENROUTER_API_KEY_ENV,
    defaultScope: 'machine',
    availableScopes: ['machine'],
    readScopes: ['project', 'machine'],
  },
  github: {
    envKey: GITHUB_TOKEN_ENV,
    defaultScope: 'machine',
    availableScopes: ['machine'],
    readScopes: ['project', 'machine'],
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

function buildSecretInfo(
  provider: SecretProvider,
  fallbackVaultDir: string,
): SecretInfo {
  const definition = SECRET_DEFINITIONS[provider];
  const envKey = definition.envKey;
  const stored = readEffectiveStoredSecret(provider, fallbackVaultDir);
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

function getSecretInfo(
  fallbackVaultDir: string,
  provider: SecretProvider,
): SecretInfo {
  return buildSecretInfo(provider, fallbackVaultDir);
}

export async function handleGetProviderSecrets(fallbackVaultDir: string, _req?: RouteRequest): Promise<RouteResponse> {
  return {
    body: {
      secrets: {
        openai: buildSecretInfo('openai', fallbackVaultDir),
        openrouter: buildSecretInfo('openrouter', fallbackVaultDir),
        github: buildSecretInfo('github', fallbackVaultDir),
      },
    },
  };
}

export async function handlePutProviderSecret(fallbackVaultDir: string, req: RouteRequest): Promise<RouteResponse> {
  const provider = req.params.provider;
  const body = req.body as { api_key?: string; secret?: string; scope?: SecretScope } | undefined;

  if (!provider || !isSecretProvider(provider)) {
    return { status: 400, body: { error: 'provider must be one of: openai, openrouter, github' } };
  }
  const value = body?.secret ?? body?.api_key;
  if (!value?.trim()) {
    return { status: 400, body: { error: 'secret is required' } };
  }

  const scope = body?.scope ?? SECRET_DEFINITIONS[provider].defaultScope;
  const store = resolveWritableSecretStore(provider, scope, fallbackVaultDir);
  if (isRouteResponse(store)) return store;

  const envKey = SECRET_DEFINITIONS[provider].envKey;
  const secret = value.trim();
  writeSecret(store.dir, envKey, secret);
  setProcessSecret(provider, secret);

  return {
    body: {
      provider,
      secret: getSecretInfo(fallbackVaultDir, provider),
    },
  };
}

export async function handleDeleteProviderSecret(fallbackVaultDir: string, req: RouteRequest): Promise<RouteResponse> {
  const provider = req.params.provider;
  if (!provider || !isSecretProvider(provider)) {
    return { status: 400, body: { error: 'provider must be one of: openai, openrouter, github' } };
  }

  const requestedScope = req.query.scope;
  const scope = parseSecretScope(requestedScope);
  if (requestedScope !== undefined && !scope) {
    return { status: 400, body: { error: 'scope must be one of: machine, project' } };
  }
  if (scope && !SECRET_DEFINITIONS[provider].availableScopes.includes(scope)) {
    return { status: 400, body: { error: `scope ${scope} is not available for ${provider}` } };
  }

  const scopes = scope
    ? [scope]
    : [...new Set([...SECRET_DEFINITIONS[provider].availableScopes, 'project' as const])];
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  for (const targetScope of scopes) {
    const store = resolveSecretStore(targetScope, fallbackVaultDir);
    deleteSecrets(store.dir, [envKey]);
  }
  refreshProcessSecret(provider, fallbackVaultDir);

  return {
    body: {
      provider,
      secret: getSecretInfo(fallbackVaultDir, provider),
    },
  };
}

function parseSecretScope(value: unknown): SecretScope | null {
  return value === 'machine' || value === 'project' ? value : null;
}

function readEffectiveStoredSecret(
  provider: SecretProvider,
  fallbackVaultDir: string,
): { scope: SecretScope; value: string } | null {
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  let found: { scope: SecretScope; value: string } | null = null;
  for (const scope of SECRET_DEFINITIONS[provider].readScopes) {
    const store = resolveSecretStore(scope, fallbackVaultDir);
    const value = readSecrets(store.dir)[envKey];
    if (value) found = { scope, value };
  }
  return found;
}

function resolveWritableSecretStore(
  provider: SecretProvider,
  scope: SecretScope,
  fallbackVaultDir: string,
): SecretStore | RouteResponse {
  if (!SECRET_DEFINITIONS[provider].availableScopes.includes(scope)) {
    return { status: 400, body: { error: `scope ${scope} is not available for ${provider}` } };
  }
  return resolveSecretStore(scope, fallbackVaultDir);
}

function resolveSecretStore(
  scope: SecretScope,
  fallbackVaultDir: string,
): SecretStore {
  if (scope === 'project') return { scope, dir: fallbackVaultDir };
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

function refreshProcessSecret(
  provider: SecretProvider,
  fallbackVaultDir: string,
): void {
  const envKey = SECRET_DEFINITIONS[provider].envKey;
  const stored = readEffectiveStoredSecret(provider, fallbackVaultDir);
  if (stored) {
    setProcessSecret(provider, stored.value);
  } else {
    delete process.env[envKey];
    if (provider === 'openai') {
      delete process.env.OPENAI_API_KEY;
    }
  }
}
