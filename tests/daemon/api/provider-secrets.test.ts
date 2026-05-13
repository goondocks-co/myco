import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'bun:test';
import {
  handleDeleteProviderSecret,
  handleGetProviderSecrets,
  handlePutProviderSecret,
} from '@myco/daemon/api/provider-secrets.js';
import { OPENAI_API_KEY_ENV } from '@myco/cli/providers/openai-embeddings.js';
import { GITHUB_TOKEN_ENV } from '@myco/release-provenance/github.js';
import type { MycoRequestContext } from '@myco/tools/request-context.js';

describe('provider secret handlers', () => {
  let vaultDir: string;
  let mycoHome: string;
  const originalMycoHome = process.env.MYCO_HOME;

  afterEach(() => {
    if (vaultDir && fs.existsSync(vaultDir)) {
      fs.rmSync(vaultDir, { recursive: true, force: true });
    }
    if (mycoHome && fs.existsSync(mycoHome)) {
      fs.rmSync(mycoHome, { recursive: true, force: true });
    }
    if (originalMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = originalMycoHome;
    }
    delete process.env[OPENAI_API_KEY_ENV];
    delete process.env.OPENAI_API_KEY;
    delete process.env[GITHUB_TOKEN_ENV];
  });

  it('stores OpenAI keys in machine secrets.env and exposes masked status', async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provider-secret-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    process.env.MYCO_HOME = mycoHome;

    const putResult = await handlePutProviderSecret(vaultDir, {
      body: { api_key: 'sk-openai-secret-value' },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    expect(putResult.status ?? 200).toBe(200);
    expect(process.env[OPENAI_API_KEY_ENV]).toBe('sk-openai-secret-value');
    expect(process.env.OPENAI_API_KEY).toBe('sk-openai-secret-value');
    expect(readSecretFile(mycoHome)).toContain(`${OPENAI_API_KEY_ENV}=sk-openai-secret-value`);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);

    const getResult = await handleGetProviderSecrets(vaultDir);
    const openai = (getResult.body as { secrets: { openai: { configured: boolean; maskedValue: string | null; source: string } } }).secrets.openai;
    expect(openai.configured).toBe(true);
    expect(openai.maskedValue).toMatch(/^sk-opena/);
    expect(openai.source).toBe('machine');
  });

  it('deletes stored keys and clears process env', async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provider-secret-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    process.env.MYCO_HOME = mycoHome;
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
    expect(fs.existsSync(path.join(mycoHome, 'secrets.env'))).toBe(false);
  });

  it('stores GitHub tokens at machine scope even when a Grove is selected', async () => {
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provider-secret-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    process.env.MYCO_HOME = mycoHome;
    const requestContext = testRequestContext(vaultDir, 'grove_test');

    const putResult = await handlePutProviderSecret(vaultDir, {
      body: { secret: 'ghp_release_provenance_secret' },
      params: { provider: 'github' },
      query: {},
      pathname: '/api/providers/secrets/github',
      requestContext,
    });

    expect(putResult.status ?? 200).toBe(200);
    expect(process.env[GITHUB_TOKEN_ENV]).toBe('ghp_release_provenance_secret');
    expect(readSecretFile(mycoHome)).toContain(`${GITHUB_TOKEN_ENV}=ghp_release_provenance_secret`);
    expect(fs.existsSync(path.join(vaultDir, 'secrets.env'))).toBe(false);

    const getResult = await handleGetProviderSecrets(vaultDir, {
      body: undefined,
      params: {},
      query: {},
      pathname: '/api/providers/secrets',
      requestContext,
    });
    const github = (getResult.body as { secrets: { github: { configured: boolean; source: string; defaultScope: string; availableScopes: string[] } } }).secrets.github;
    expect(github.configured).toBe(true);
    expect(github.source).toBe('machine');
    expect(github.defaultScope).toBe('machine');
    expect(github.availableScopes).toEqual(['machine']);
  });
});

function readSecretFile(dir: string): string {
  return fs.readFileSync(path.join(dir, 'secrets.env'), 'utf-8');
}

function testRequestContext(vaultDir: string, groveId: string): MycoRequestContext {
  return {
    projectRoot: path.dirname(vaultDir),
    projectVaultDir: vaultDir,
    projectId: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as MycoRequestContext['projectId'],
    groveId,
    databasePath: path.join(vaultDir, 'myco.db'),
    machineId: 'test-machine',
    sessionId: null,
    source: 'explicit',
  };
}
