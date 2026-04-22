import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createHexToken,
  extractJsonArray,
  maskSecret,
  parseD1Id,
  parseKvNamespaceId,
  parseWorkerUrl,
  readJsonConfig,
  resolveHomeConfigPath,
  resolveVaultConfigPath,
  runWrangler,
  stageDeploymentDir,
  writeJsonConfig,
} from '@myco-deploy/index.js';

const execCalls: Array<{ command: string; args: string[]; cwd?: string; input?: string }> = [];
const execHandlers: Array<(args: string[], options?: { cwd?: string; input?: string; encoding?: string }) => string | Error> = [];

vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    execFileSync: vi.fn((command: string, args: string[], options?: { cwd?: string; input?: string; encoding?: string }) => {
      execCalls.push({ command, args, cwd: options?.cwd, input: typeof options?.input === 'string' ? options.input : undefined });
      const handler = execHandlers.shift();
      if (!handler) return options?.encoding ? '' : Buffer.from('');
      const result = handler(args, options);
      if (result instanceof Error) throw result;
      return options?.encoding ? result : Buffer.from(result);
    }),
  };
});

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
