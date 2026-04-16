import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  handleDeleteProviderSecret,
  handleGetProviderSecrets,
  handlePutProviderSecret,
} from '@myco/daemon/api/provider-secrets.js';
import { OPENAI_API_KEY_ENV } from '@myco/cli/providers/openai-embeddings.js';

describe('provider secret handlers', () => {
  let vaultDir: string;

  afterEach(() => {
    if (vaultDir && fs.existsSync(vaultDir)) {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
    delete process.env[OPENAI_API_KEY_ENV];
    delete process.env.OPENAI_API_KEY;
  });

  it('stores OpenAI keys in secrets.env and exposes masked status', async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provider-secret-'));

    const putResult = await handlePutProviderSecret(vaultDir, {
      body: { api_key: 'sk-openai-secret-value' },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    expect(putResult.status ?? 200).toBe(200);
    expect(process.env[OPENAI_API_KEY_ENV]).toBe('sk-openai-secret-value');
    expect(process.env.OPENAI_API_KEY).toBe('sk-openai-secret-value');

    const getResult = await handleGetProviderSecrets(vaultDir);
    const openai = (getResult.body as { secrets: { openai: { configured: boolean; maskedValue: string | null } } }).secrets.openai;
    expect(openai.configured).toBe(true);
    expect(openai.maskedValue).toMatch(/^sk-opena/);
  });

  it('deletes stored keys and clears process env', async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provider-secret-'));
    await handlePutProviderSecret(vaultDir, {
      body: { api_key: 'sk-openai-secret-value' },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    const deleteResult = await handleDeleteProviderSecret(vaultDir, {
      body: undefined,
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    expect(deleteResult.status ?? 200).toBe(200);
    expect(process.env[OPENAI_API_KEY_ENV]).toBeUndefined();
    expect(process.env.OPENAI_API_KEY).toBeUndefined();
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);
  });
});
