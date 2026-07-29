import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  handleDeleteProviderSecret as handleDeleteProviderSecretWith,
  handleGetProviderSecrets,
  handlePutProviderSecret as handlePutProviderSecretWith,
} from '@myco/daemon/api/provider-secrets.js';
import type { RouteRequest } from '@myco/daemon/router.js';
import { testPerUserLockNamespace } from '../../helpers/per-user-lock-namespace.js';

const handlePutProviderSecret = (req: RouteRequest) =>
  handlePutProviderSecretWith(req, testPerUserLockNamespace);
const handleDeleteProviderSecret = (req: RouteRequest) =>
  handleDeleteProviderSecretWith(req, testPerUserLockNamespace);
import { CLAUDE_CODE_OAUTH_TOKEN_ENV, OPENAI_API_KEY_ENV } from '@myco/providers/env.js';
import { GITHUB_TOKEN_ENV } from '@myco/release-provenance/github.js';
import { HARNESS_SESSION_DIRNAME } from '@myco/agent/harness/redirect-epoch.js';

describe('provider secret handlers', () => {
  let projectVaultDir: string;
  let mycoHome: string;
  const originalMycoHome = process.env.MYCO_HOME;
  let originalOpenAiApiKey: string | undefined;
  let originalOpenAiApiKeyAlias: string | undefined;
  // Hermetic AND non-destructive (provider-secret test discipline): dogfood
  // shells may genuinely export the Claude token — snapshot, clear, restore.
  let originalClaudeToken: string | undefined;

  beforeEach(() => {
    originalOpenAiApiKey = process.env[OPENAI_API_KEY_ENV];
    originalOpenAiApiKeyAlias = process.env.OPENAI_API_KEY;
    originalClaudeToken = process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
    delete process.env[OPENAI_API_KEY_ENV];
    delete process.env.OPENAI_API_KEY;
    delete process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
  });

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
    if (originalOpenAiApiKey === undefined) delete process.env[OPENAI_API_KEY_ENV];
    else process.env[OPENAI_API_KEY_ENV] = originalOpenAiApiKey;
    if (originalOpenAiApiKeyAlias === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = originalOpenAiApiKeyAlias;
    if (originalClaudeToken === undefined) delete process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV];
    else process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV] = originalClaudeToken;
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

  it.each([
    '\nvalid-secret',
    'valid\nINJECTED=owned',
    'valid-secret\n',
    '\rvalid-secret',
    'valid\rINJECTED=owned',
    'valid-secret\r',
    '\0valid-secret',
    'valid\0INJECTED=owned',
    'valid-secret\0',
  ])('rejects an unsafe raw OpenAI secret before mutating the store or process environment: %p', async (value) => {
    setup();
    const secretsPath = path.join(mycoHome, 'secrets.env');
    fs.writeFileSync(secretsPath, `${OPENAI_API_KEY_ENV}=stored-valid\n`);
    const before = fs.readFileSync(secretsPath);
    const sentinel = 'external-openai-sentinel';
    const aliasSentinel = 'external-openai-alias-sentinel';
    process.env[OPENAI_API_KEY_ENV] = sentinel;
    process.env.OPENAI_API_KEY = aliasSentinel;

    const result = await handlePutProviderSecret({
      body: { api_key: value },
      params: { provider: 'openai' },
      query: {},
      pathname: '/api/providers/secrets/openai',
    });

    expect(result.status).toBe(400);
    expect(result.body).toEqual({
      error: 'invalid_secret_value',
      message: 'Secret value contains unsupported characters',
    });
    expect(fs.readFileSync(secretsPath)).toEqual(before);
    expect(process.env[OPENAI_API_KEY_ENV]).toBe(sentinel);
    expect(process.env.OPENAI_API_KEY).toBe(aliasSentinel);
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

  describe('anthropic — Claude subscription token', () => {
    it('stores the token machine-scoped under CLAUDE_CODE_OAUTH_TOKEN and echoes only the mask', async () => {
      setup();

      const putResult = await handlePutProviderSecret({
        body: { api_key: 'sk-ant-oat01-subscription-token-value' },
        params: { provider: 'anthropic' },
        query: {},
        pathname: '/api/providers/secrets/anthropic',
      });

      expect(putResult.status ?? 200).toBe(200);
      expect(process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV]).toBe('sk-ant-oat01-subscription-token-value');
      expect(readSecretFile(mycoHome)).toContain(`${CLAUDE_CODE_OAUTH_TOKEN_ENV}=sk-ant-oat01-subscription-token-value`);
      expect(fs.existsSync(path.join(projectVaultDir, 'secrets.env'))).toBe(false);
      const echoed = (putResult.body as { secret: { maskedValue: string | null } }).secret;
      expect(echoed.maskedValue).toMatch(/^sk-ant-o/);
      expect(JSON.stringify(putResult.body)).not.toContain('subscription-token-value');
    });

    it('reports agent-sessions credentials as fallback evidence only while no token is configured', async () => {
      setup();
      const sessionDir = path.join(mycoHome, HARNESS_SESSION_DIRNAME);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(path.join(sessionDir, '.credentials.json'), '{}', { mode: 0o600 });

      const before = await handleGetProviderSecrets();
      const anthropicBefore = (before.body as {
        secrets: { anthropic: { configured: boolean; fallbackEvidence?: string | null } };
      }).secrets.anthropic;
      expect(anthropicBefore.configured).toBe(false);
      expect(anthropicBefore.fallbackEvidence).toBe('agent-sessions');

      await handlePutProviderSecret({
        body: { api_key: 'sk-ant-oat01-now-connected' },
        params: { provider: 'anthropic' },
        query: {},
        pathname: '/api/providers/secrets/anthropic',
      });

      const after = await handleGetProviderSecrets();
      const anthropicAfter = (after.body as {
        secrets: { anthropic: { configured: boolean; fallbackEvidence?: string | null } };
      }).secrets.anthropic;
      expect(anthropicAfter.configured).toBe(true);
      expect(anthropicAfter.fallbackEvidence).toBeNull();
    });

    it('delete clears the machine store and the process env', async () => {
      setup();
      await handlePutProviderSecret({
        body: { api_key: 'sk-ant-oat01-to-clear' },
        params: { provider: 'anthropic' },
        query: {},
        pathname: '/api/providers/secrets/anthropic',
      });

      const deleteResult = await handleDeleteProviderSecret({
        body: undefined,
        params: { provider: 'anthropic' },
        query: {},
        pathname: '/api/providers/secrets/anthropic',
      });

      expect(deleteResult.status ?? 200).toBe(200);
      expect(process.env[CLAUDE_CODE_OAUTH_TOKEN_ENV]).toBeUndefined();
      // deleteSecrets removes secrets.env entirely once its last entry goes.
      const secretsPath = path.join(mycoHome, 'secrets.env');
      if (fs.existsSync(secretsPath)) {
        expect(readSecretFile(mycoHome)).not.toContain('sk-ant-oat01-to-clear');
      }
    });
  });
});

function readSecretFile(dir: string): string {
  return fs.readFileSync(path.join(dir, 'secrets.env'), 'utf-8');
}
