import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createHexToken,
  extractAccountIdFlag,
  extractJsonArray,
  isValidCloudflareAccountId,
  maskSecret,
  parseD1Id,
  parseKvNamespaceId,
  parseWorkerUrl,
  parseWranglerAccounts,
  readJsonConfig,
  resolveCloudflareAccount,
  resolveHomeConfigPath,
  resolveVaultConfigPath,
  runWrangler,
  stageDeploymentDir,
  writeJsonConfig,
} from '@myco-deploy/index.js';

const execCalls: Array<{ command: string; args: string[]; cwd?: string; input?: string }> = [];
const execHandlers: Array<(args: string[], options?: { cwd?: string; input?: string; encoding?: string }) => string | Error> = [];

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
    ...childProcessActual,
    execFileSync: vi.fn((command: string, args: string[], options?: { cwd?: string; input?: string; encoding?: string }) => {
      execCalls.push({ command, args, cwd: options?.cwd, input: typeof options?.input === 'string' ? options.input : undefined });
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler(args, options);
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  }));

describe('local config helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-deploy-config-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('writes and reads JSON config files', () => {
    const configPath = path.join(tempDir, 'config.json');
    writeJsonConfig(configPath, { enabled: true, name: 'collective' });

    expect(readJsonConfig<{ enabled: boolean; name: string }>(configPath)).toEqual({
      enabled: true,
      name: 'collective',
    });
  });

  it('builds home config paths under the requested directory', () => {
    const result = resolveHomeConfigPath('.myco-collective', 'config.json');
    expect(result).toBe(path.join(os.homedir(), '.myco-collective', 'config.json'));
  });

  it('builds vault config paths under the requested directory', () => {
    const result = resolveVaultConfigPath('/tmp/example/.myco', 'team', 'config.json');
    expect(result).toBe('/tmp/example/.myco/team/config.json');
  });

  it('masks secrets and generates hex tokens', () => {
    expect(maskSecret('1234567890abcdef')).toBe('1234...cdef');
    expect(maskSecret(null)).toBeNull();
    expect(createHexToken(8)).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('cloudflare deployment helpers', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-deploy-stage-'));
    execCalls.length = 0;
    execHandlers.length = 0;
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  it('stages deployment content, patches files, and installs dependencies', () => {
    const sourceDir = path.join(tempDir, 'source');
    const extraDir = path.join(tempDir, 'ui');
    const deployDir = path.join(tempDir, 'deploy');

    fs.mkdirSync(path.join(sourceDir, 'src'), { recursive: true });
    fs.mkdirSync(extraDir, { recursive: true });
    fs.writeFileSync(path.join(sourceDir, 'wrangler.toml'), 'name = "template"\ndatabase_id = "<YOUR_D1_DATABASE_ID>"\n', 'utf-8');
    fs.writeFileSync(path.join(sourceDir, 'package.json'), '{"name":"worker"}\n', 'utf-8');
    fs.writeFileSync(path.join(sourceDir, 'src', 'index.ts'), '// worker\n', 'utf-8');
    fs.writeFileSync(path.join(extraDir, 'index.html'), '<html></html>\n', 'utf-8');

    execHandlers.push(() => '');

    const staged = stageDeploymentDir({
      sourceDir,
      deployDir,
      reset: true,
      extraCopies: [{ sourceDir: extraDir, destinationSubdir: 'ui' }],
      textPatches: [{
        filePath: 'wrangler.toml',
        transforms: [
          (text) => text.replace('template', 'myco-collective'),
          (text) => text.replace('<YOUR_D1_DATABASE_ID>', 'db-123'),
        ],
      }],
      installDepsTimeoutMs: 10_000,
    });

    expect(staged).toBe(deployDir);
    expect(fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8')).toContain('name = "myco-collective"');
    expect(fs.readFileSync(path.join(deployDir, 'wrangler.toml'), 'utf-8')).toContain('database_id = "db-123"');
    expect(fs.existsSync(path.join(deployDir, 'ui', 'index.html'))).toBe(true);
    expect(execCalls).toContainEqual({
      command: 'npm',
      args: ['install', '--silent', '--no-audit', '--no-fund'],
      cwd: deployDir,
      input: undefined,
    });
  });

  it('surfaces wrangler stderr on failure', () => {
    const error = new Error('command failed') as Error & { stderr?: string; stdout?: string };
    error.stderr = 'wrangler exploded';
    execHandlers.push(() => error);

    expect(() => runWrangler(['deploy'], { timeoutMs: 5_000 })).toThrow('wrangler exploded');
  });

  it('parses cloudflare command output formats', () => {
    expect(parseD1Id('{ "database_id": "f9b0e166-a7e3-476c-b7a7-7a7f08723d67" }')).toBe('f9b0e166-a7e3-476c-b7a7-7a7f08723d67');
    expect(parseKvNamespaceId('{ "kv_namespaces": [ { "id": "7cc069cb32b4438b29079cca4714056" } ] }')).toBe('7cc069cb32b4438b29079cca4714056');
    expect(parseWorkerUrl('Deployed to https://myco-team.example.workers.dev')).toBe('https://myco-team.example.workers.dev');
    expect(extractJsonArray('banner\n[{"id":"one"}]\n')).toEqual([{ id: 'one' }]);
  });
});

const TWO_ACCOUNT_WHOAMI = [
  ' ⛅️ wrangler 4.105.0 (update available 4.106.0)',
  '───────────────────────────────────────────────',
  'Getting User settings...',
  '👋 You are logged in with an OAuth Token, associated with the email cf@example.net.',
  '┌──────────────────┬──────────────────────────────────┐',
  '│ Account Name     │ Account ID                       │',
  '├──────────────────┼──────────────────────────────────┤',
  '│ Personal Account │ 0123456789abcdef0123456789abcdef │',
  '├──────────────────┼──────────────────────────────────┤',
  '│ Team Account     │ fedcba9876543210fedcba9876543210 │',
  '└──────────────────┴──────────────────────────────────┘',
].join('\n') + '\n';

const ONE_ACCOUNT_WHOAMI = [
  '┌──────────────────┬──────────────────────────────────┐',
  '│ Account Name     │ Account ID                       │',
  '├──────────────────┼──────────────────────────────────┤',
  '│ Personal Account │ 0123456789abcdef0123456789abcdef │',
  '└──────────────────┴──────────────────────────────────┘',
].join('\n') + '\n';

describe('cloudflare account selection', () => {
  let previousAccountId: string | undefined;

  beforeEach(() => {
    previousAccountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    delete process.env.CLOUDFLARE_ACCOUNT_ID;
  });

  afterEach(() => {
    if (previousAccountId === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID;
    else process.env.CLOUDFLARE_ACCOUNT_ID = previousAccountId;
  });

  it('parses the wrangler whoami account table', () => {
    expect(parseWranglerAccounts(TWO_ACCOUNT_WHOAMI)).toEqual([
      { name: 'Personal Account', id: '0123456789abcdef0123456789abcdef' },
      { name: 'Team Account', id: 'fedcba9876543210fedcba9876543210' },
    ]);
    expect(parseWranglerAccounts(ONE_ACCOUNT_WHOAMI)).toHaveLength(1);
  });

  it('returns [] for non-table whoami output (older wrangler / stubs)', () => {
    expect(parseWranglerAccounts('logged in\n')).toEqual([]);
    expect(parseWranglerAccounts('')).toEqual([]);
  });

  it('still counts an account whose Name cell is blank (no undercount)', () => {
    const blankName = [
      '┌──┬──────────────────────────────────┐',
      '│  │ 0123456789abcdef0123456789abcdef │',
      '├──┼──────────────────────────────────┤',
      '│  │ fedcba9876543210fedcba9876543210 │',
      '└──┴──────────────────────────────────┘',
    ].join('\n') + '\n';
    expect(parseWranglerAccounts(blankName)).toEqual([
      { name: '', id: '0123456789abcdef0123456789abcdef' },
      { name: '', id: 'fedcba9876543210fedcba9876543210' },
    ]);
  });

  it('extracts a --account-id flag in both spaced and = forms', () => {
    expect(extractAccountIdFlag(['create', '--account-id', 'abc', '--name', 'x'])).toEqual({
      accountId: 'abc',
      rest: ['create', '--name', 'x'],
    });
    expect(extractAccountIdFlag(['create', '--account-id=abc'])).toEqual({
      accountId: 'abc',
      rest: ['create'],
    });
    expect(extractAccountIdFlag(['create', '--name', 'x'])).toEqual({
      accountId: undefined,
      rest: ['create', '--name', 'x'],
    });
  });

  it('validates the 32-hex account id shape', () => {
    expect(isValidCloudflareAccountId('0123456789abcdef0123456789abcdef')).toBe(true);
    expect(isValidCloudflareAccountId('0123456789ABCDEF0123456789ABCDEF')).toBe(true);
    expect(isValidCloudflareAccountId('too-short')).toBe(false);
    expect(isValidCloudflareAccountId('z123456789abcdef0123456789abcdef')).toBe(false);
  });

  it('respects an already-set CLOUDFLARE_ACCOUNT_ID without prompting', async () => {
    process.env.CLOUDFLARE_ACCOUNT_ID = '0123456789abcdef0123456789abcdef';
    const prompt = vi.fn(async () => '1');
    await resolveCloudflareAccount({ whoamiOutput: TWO_ACCOUNT_WHOAMI, isTTY: true, prompt, log: () => {} });
    expect(prompt).not.toHaveBeenCalled();
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe('0123456789abcdef0123456789abcdef');
  });

  it('is a no-op with a single account', async () => {
    const prompt = vi.fn(async () => '1');
    await resolveCloudflareAccount({ whoamiOutput: ONE_ACCOUNT_WHOAMI, isTTY: true, prompt, log: () => {} });
    expect(prompt).not.toHaveBeenCalled();
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });

  it('throws with the account list when multiple accounts and non-interactive', async () => {
    await expect(
      resolveCloudflareAccount({ whoamiOutput: TWO_ACCOUNT_WHOAMI, isTTY: false, log: () => {} }),
    ).rejects.toThrow(/more than one cloudflare account/i);
    await expect(
      resolveCloudflareAccount({ whoamiOutput: TWO_ACCOUNT_WHOAMI, isTTY: false, log: () => {} }),
    ).rejects.toThrow(/fedcba9876543210fedcba9876543210/);
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });

  it('prompts and applies the chosen account on a TTY', async () => {
    const prompt = vi.fn(async () => '2');
    await resolveCloudflareAccount({ whoamiOutput: TWO_ACCOUNT_WHOAMI, isTTY: true, prompt, log: () => {} });
    expect(prompt).toHaveBeenCalledTimes(1);
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe('fedcba9876543210fedcba9876543210');
  });

  it('re-prompts on invalid input, then applies a valid choice', async () => {
    const answers = ['9', 'nope', '1'];
    const prompt = vi.fn(async () => answers.shift() ?? '');
    await resolveCloudflareAccount({ whoamiOutput: TWO_ACCOUNT_WHOAMI, isTTY: true, prompt, log: () => {} });
    expect(prompt).toHaveBeenCalledTimes(3);
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBe('0123456789abcdef0123456789abcdef');
  });

  it('throws after exhausting prompt attempts without a valid choice', async () => {
    const prompt = vi.fn(async () => 'x');
    await expect(
      resolveCloudflareAccount({ whoamiOutput: TWO_ACCOUNT_WHOAMI, isTTY: true, prompt, log: () => {} }),
    ).rejects.toThrow(/no valid cloudflare account/i);
    expect(process.env.CLOUDFLARE_ACCOUNT_ID).toBeUndefined();
  });
});
