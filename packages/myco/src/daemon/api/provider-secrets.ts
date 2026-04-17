import { deleteSecrets, readSecrets, writeSecret } from '@myco/config/secrets.js';
import { OPENAI_API_KEY_ENV } from '../../cli/providers/openai-embeddings.js';
import { OPENROUTER_API_KEY_ENV } from '../../cli/providers/openrouter.js';
import type { RouteRequest, RouteResponse } from '../router.js';

const SECRET_PREVIEW_PREFIX_CHARS = 8;
const SECRET_PREVIEW_SUFFIX_CHARS = 4;

type SecretProvider = 'openai' | 'openrouter';

interface SecretInfo {
  configured: boolean;
  envKey: string;
  maskedValue: string | null;
  source: 'vault' | 'env' | 'none';
}

const SECRET_ENV_BY_PROVIDER: Record<SecretProvider, string> = {
  openai: OPENAI_API_KEY_ENV,
  openrouter: OPENROUTER_API_KEY_ENV,
};

function isSecretProvider(value: string): value is SecretProvider {
  return value === 'openai' || value === 'openrouter';
}

function maskSecret(secret: string): string {
  if (secret.length <= SECRET_PREVIEW_PREFIX_CHARS + SECRET_PREVIEW_SUFFIX_CHARS) {
    return '*'.repeat(secret.length);
  }
  return `${secret.slice(0, SECRET_PREVIEW_PREFIX_CHARS)}${'*'.repeat(secret.length - SECRET_PREVIEW_PREFIX_CHARS - SECRET_PREVIEW_SUFFIX_CHARS)}${secret.slice(-SECRET_PREVIEW_SUFFIX_CHARS)}`;
}

function buildSecretInfo(
  provider: SecretProvider,
  storedSecrets: Record<string, string>,
): SecretInfo {
  const envKey = SECRET_ENV_BY_PROVIDER[provider];
  const storedValue = storedSecrets[envKey];
  const envValue = process.env[envKey];
  const effectiveValue = storedValue ?? envValue;

  return {
    configured: Boolean(effectiveValue),
    envKey,
    maskedValue: effectiveValue ? maskSecret(effectiveValue) : null,
    source: storedValue ? 'vault' : envValue ? 'env' : 'none',
  };
}

function getSecretInfo(vaultDir: string, provider: SecretProvider): SecretInfo {
  return buildSecretInfo(provider, readSecrets(vaultDir));
}

export async function handleGetProviderSecrets(vaultDir: string): Promise<RouteResponse> {
  const storedSecrets = readSecrets(vaultDir);
  return {
    body: {
      secrets: {
        openai: buildSecretInfo('openai', storedSecrets),
        openrouter: buildSecretInfo('openrouter', storedSecrets),
      },
    },
  };
}

export async function handlePutProviderSecret(vaultDir: string, req: RouteRequest): Promise<RouteResponse> {
  const provider = req.params.provider;
  const body = req.body as { api_key?: string } | undefined;

  if (!provider || !isSecretProvider(provider)) {
    return { status: 400, body: { error: 'provider must be one of: openai, openrouter' } };
  }
  if (!body?.api_key?.trim()) {
    return { status: 400, body: { error: 'api_key is required' } };
  }

  const envKey = SECRET_ENV_BY_PROVIDER[provider];
  const apiKey = body.api_key.trim();
  writeSecret(vaultDir, envKey, apiKey);
  process.env[envKey] = apiKey;
  if (provider === 'openai') {
    process.env.OPENAI_API_KEY = apiKey;
  }

  return {
    body: {
      provider,
      secret: getSecretInfo(vaultDir, provider),
    },
  };
}

export async function handleDeleteProviderSecret(vaultDir: string, req: RouteRequest): Promise<RouteResponse> {
  const provider = req.params.provider;
  if (!provider || !isSecretProvider(provider)) {
    return { status: 400, body: { error: 'provider must be one of: openai, openrouter' } };
  }

  const envKey = SECRET_ENV_BY_PROVIDER[provider];
  deleteSecrets(vaultDir, [envKey]);
  delete process.env[envKey];
  if (provider === 'openai') {
    delete process.env.OPENAI_API_KEY;
  }

  return {
    body: {
      provider,
      secret: getSecretInfo(vaultDir, provider),
    },
  };
}
