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

describe('provider secret handlers', () => {
  let projectVaultDir: string;
  let mycoHome: string;
  const originalMycoHome = process.env.MYCO_HOME;

  afterEach(() => {
    if (projectVaultDir && fs.existsSync(projectVaultDir)) {
      fs.rmSync(projectVaultDir, { recursive: true, force: true });
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

  function setup(): void {
    // A separate project vault is created to PROVE no secret path ever resolves
    // it — these routes are machine-scoped and must only touch `~/.myco`.
    projectVaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-provider-secret-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    process.env.MYCO_HOME = mycoHome;
  }

  it('stores OpenAI keys in the machine secrets.env and never the project vault', async () => {
    setup();

    const putResult = await handlePutProviderSecret({
      body: { api_key: 'sk-openai-secret-value' },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    expect(putResult.status ?? 200).toBe(200);
    expect(process.env[OPENAI_API_KEY_ENV]).toBe('sk-openai-secret-value');
    expect(process.env.OPENAI_API_KEY).toBe('sk-openai-secret-value');
    expect(readSecretFile(mycoHome)).toContain(`${OPENAI_API_KEY_ENV}=sk-openai-secret-value`);
    // The project/anchor vault must never receive a secrets.env.
    expect(fs.existsSync(path.join(projectVaultDir, 'secrets.env'))).toBe(false);

    const getResult = await handleGetProviderSecrets();
    const openai = (getResult.body as {
      secrets: { openai: { configured: boolean; maskedValue: string | null; source: string; sourceScope: string | null } };
    }).secrets.openai;
    expect(openai.configured).toBe(true);
    expect(openai.maskedValue).toMatch(/^sk-opena/);
    expect(openai.source).toBe('machine');
    expect(openai.sourceScope).toBe('machine');
  });

  it('reads back from the machine store, never from a project vault', async () => {
    setup();

    // Plant a secret directly in the project vault. If any read path still
    // resolved the anchor vault, the GET would surface it; it must not.
    fs.writeFileSync(
      path.join(projectVaultDir, 'secrets.env'),
      `${OPENAI_API_KEY_ENV}=sk-leaked-from-project\n`,
      'utf-8',
    );

    const getResult = await handleGetProviderSecrets();
    const openai = (getResult.body as {
      secrets: { openai: { configured: boolean; source: string } };
    }).secrets.openai;
    expect(openai.configured).toBe(false);
    expect(openai.source).toBe('none');
  });

  it('deletes stored keys from the machine store only and clears process env', async () => {
    setup();
    await handlePutProviderSecret({
      body: { api_key: 'sk-openai-secret-value' },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    const deleteResult = await handleDeleteProviderSecret({
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

  it('does not delete or read a project-vault secret of the same key', async () => {
    setup();
    // A pre-existing project-vault secret must be left entirely untouched by
    // the machine-scoped DELETE fan-out (no anchor leak).
    fs.writeFileSync(
      path.join(projectVaultDir, 'secrets.env'),
      `${OPENAI_API_KEY_ENV}=sk-project-untouched\n`,
      'utf-8',
    );
    await handlePutProviderSecret({
      body: { api_key: 'sk-machine-value' },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    await handleDeleteProviderSecret({
      body: undefined,
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    // The machine store secret is gone; the project vault file is intact.
    expect(fs.existsSync(path.join(mycoHome, 'secrets.env'))).toBe(false);
    expect(readSecretFile(projectVaultDir)).toContain(`${OPENAI_API_KEY_ENV}=sk-project-untouched`);
  });

  it('stores GitHub tokens at machine scope and reports only the machine scope', async () => {
    setup();

    const putResult = await handlePutProviderSecret({
      body: { secret: 'ghp_release_provenance_secret' },
      params: { provider: 'github' },
      query: {},
      pathname: '/api/providers/secrets/github',
    });

    expect(putResult.status ?? 200).toBe(200);
    expect(process.env[GITHUB_TOKEN_ENV]).toBe('ghp_release_provenance_secret');
    expect(readSecretFile(mycoHome)).toContain(`${GITHUB_TOKEN_ENV}=ghp_release_provenance_secret`);
    expect(fs.existsSync(path.join(projectVaultDir, 'secrets.env'))).toBe(false);

    const getResult = await handleGetProviderSecrets();
    const github = (getResult.body as {
      secrets: { github: { configured: boolean; source: string; defaultScope: string; availableScopes: string[] } };
    }).secrets.github;
    expect(github.configured).toBe(true);
    expect(github.source).toBe('machine');
    expect(github.defaultScope).toBe('machine');
    expect(github.availableScopes).toEqual(['machine']);
  });

  it('reports machine as the only scope across every provider', async () => {
    setup();

    const getResult = await handleGetProviderSecrets();
    const secrets = (getResult.body as {
      secrets: Record<string, { defaultScope: string; availableScopes: string[] }>;
    }).secrets;

    for (const provider of ['openai', 'openrouter', 'github']) {
      expect(secrets[provider].defaultScope).toBe('machine');
      expect(secrets[provider].availableScopes).toEqual(['machine']);
      expect(secrets[provider].availableScopes).not.toContain('project');
    }
  });

  it('rejects a project scope on DELETE as not a valid scope', async () => {
    setup();

    const result = await handleDeleteProviderSecret({
      body: undefined,
      params: { provider: 'openai' },
      query: { scope: 'project' },
      pathname: '/api/providers/secrets/openai',
    });

    expect(result.status).toBe(400);
    expect((result.body as { error: string }).error).toContain('scope must be one of: machine');
  });
});

function readSecretFile(dir: string): string {
  return fs.readFileSync(path.join(dir, 'secrets.env'), 'utf-8');
}
