import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { MycoConfigSchema } from '@myco/config/schema';
import { run } from '@myco/cli/setup-digest';

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'myco.yaml'), YAML.stringify(config), 'utf-8');
}

function readConfig(dir: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(path.join(dir, 'myco.yaml'), 'utf-8')) as Record<string, unknown>;
}

describe('myco setup-digest', () => {
  let tmpDir: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logged: string[];
  let errors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-digest-test-'));
    // Write a minimal valid config using MycoConfigSchema defaults
    const config = MycoConfigSchema.parse({ version: 2, intelligence: { llm: { provider: 'ollama', model: 'qwen3.5' }, embedding: { provider: 'ollama', model: 'bge-m3' } } });
    writeConfig(tmpDir, config as unknown as Record<string, unknown>);

    logged = [];
    errors = [];
    exitCode = undefined;
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
    console.error = (...args: unknown[]) => errors.push(args.join(' '));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;
    (globalThis as Record<string, unknown>).__originalExit = originalExit;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = (globalThis as Record<string, unknown>).__originalExit as typeof process.exit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('--show outputs current digest config as JSON containing inject_tier', async () => {
    await run(['--show'], tmpDir);
    const output = logged.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('digest');
    expect(parsed.digest).toHaveProperty('inject_tier');
  });

  it('--tiers updates the tiers array in the YAML file', async () => {
    await run(['--tiers', '1500,3000'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    expect(digest.tiers).toEqual([1500, 3000]);
  });

  it('--inject-tier updates inject_tier to the given number', async () => {
    await run(['--inject-tier', '5000'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    expect(digest.inject_tier).toBe(5000);
  });

  it('--inject-tier null sets inject_tier to null', async () => {
    await run(['--inject-tier', 'null'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    expect(digest.inject_tier).toBeNull();
  });

  it('--provider and --model update digest intelligence provider and model', async () => {
    await run(['--provider', 'lm-studio', '--model', 'test-model'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    const intelligence = digest.intelligence as Record<string, unknown>;
    expect(intelligence.provider).toBe('lm-studio');
    expect(intelligence.model).toBe('test-model');
  });

  it('--context-window updates intelligence context_window', async () => {
    await run(['--context-window', '65536'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    const intelligence = digest.intelligence as Record<string, unknown>;
    expect(intelligence.context_window).toBe(65536);
  });

  it('--gpu-kv-cache true sets gpu_kv_cache to true', async () => {
    await run(['--gpu-kv-cache', 'true'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    const intelligence = digest.intelligence as Record<string, unknown>;
    expect(intelligence.gpu_kv_cache).toBe(true);
  });

  it('--summary-tokens updates capture.summary_max_tokens', async () => {
    await run(['--summary-tokens', '2048'], tmpDir);
    const config = readConfig(tmpDir);
    const capture = config.capture as Record<string, unknown>;
    expect(capture.summary_max_tokens).toBe(2048);
  });

  it('--enabled false disables digest', async () => {
    await run(['--enabled', 'false'], tmpDir);
    const config = readConfig(tmpDir);
    const digest = config.digest as Record<string, unknown>;
    expect(digest.enabled).toBe(false);
  });

  it('invalid value causes validation error and exits with code 1', async () => {
    // Corrupt the tiers value to cause a schema validation error by passing a
    // non-positive integer via a direct YAML manipulation before the run call.
    // We trigger validation failure by writing a bad inject_tier after parsing:
    // write an invalid config with version missing, then call with valid args
    // to ensure the safeParse step fails.
    const badConfig = {
      version: 2,
      intelligence: { llm: { provider: 'ollama', model: 'qwen3.5' }, embedding: { provider: 'ollama', model: 'bge-m3' } },
      digest: { tiers: [-1] }, // negative number fails z.number().int().positive()
    };
    writeConfig(tmpDir, badConfig);

    await expect(run(['--enabled', 'true'], tmpDir)).rejects.toThrow('process.exit(1)');
    expect(exitCode).toBe(1);
    expect(errors.some((e) => e.includes('Validation error') || e.includes('validation'))).toBe(true);
  });

  it('shows daemon restart notice when daemon.json exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.json'), '{}', 'utf-8');
    await run(['--enabled', 'true'], tmpDir);
    expect(logged.some((l) => l.includes('restart'))).toBe(true);
  });

  it('does not show daemon restart notice when daemon.json is absent', async () => {
    await run(['--enabled', 'true'], tmpDir);
    expect(logged.every((l) => !l.includes('restart'))).toBe(true);
  });
});
