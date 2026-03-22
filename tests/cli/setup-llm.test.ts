import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { MycoConfigSchema } from '@myco/config/schema';
import { run } from '@myco/cli/setup-llm';

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'myco.yaml'), YAML.stringify(config), 'utf-8');
}

function readConfig(dir: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(path.join(dir, 'myco.yaml'), 'utf-8')) as Record<string, unknown>;
}

describe('myco setup-llm', () => {
  let tmpDir: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logged: string[];
  let errors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-llm-test-'));
    const config = MycoConfigSchema.parse({ version: 3 });
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

  it('--show outputs current embedding config as JSON', async () => {
    await run(['--show'], tmpDir);
    const output = logged.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('provider');
    expect(parsed).toHaveProperty('model');
  });

  it('--embedding-model updates the embedding model', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    const config = readConfig(tmpDir);
    const embedding = config.embedding as Record<string, unknown>;
    expect(embedding.model).toBe('nomic-embed-text');
  });

  it('--embedding-provider updates the embedding provider', async () => {
    await run(['--embedding-provider', 'openai-compatible', '--embedding-url', 'http://localhost:1234'], tmpDir);
    const config = readConfig(tmpDir);
    const embedding = config.embedding as Record<string, unknown>;
    expect(embedding.provider).toBe('openai-compatible');
    expect(embedding.base_url).toBe('http://localhost:1234');
  });

  it('partial update preserves other fields unchanged', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    const config = readConfig(tmpDir);
    const embedding = config.embedding as Record<string, unknown>;
    expect(embedding.model).toBe('nomic-embed-text');
    expect(embedding.provider).toBe('ollama');
  });

  it('prints updated embedding config after a change', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    const allOutput = logged.join('\n');
    expect(allOutput).toContain('nomic-embed-text');
  });

  it('warns about vector rebuild when embedding model changes', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    expect(logged.some((l) => l.includes('rebuild'))).toBe(true);
  });

  it('shows daemon restart notice when daemon.json exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.json'), '{}', 'utf-8');
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    expect(logged.some((l) => l.includes('restart'))).toBe(true);
  });

  it('does not show daemon restart notice when daemon.json is absent', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    expect(logged.every((l) => !l.includes('restart'))).toBe(true);
  });

  it('prints note about LLM flags being ignored', async () => {
    await run(['--llm-provider', 'ollama', '--llm-model', 'qwen3.5'], tmpDir);
    expect(logged.some((l) => l.includes('LLM') && l.includes('ignored'))).toBe(true);
  });
});
