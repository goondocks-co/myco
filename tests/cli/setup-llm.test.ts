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

  it('--show outputs current intelligence config as JSON', async () => {
    await run(['--show'], tmpDir);
    const output = logged.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('llm');
    expect(parsed).toHaveProperty('embedding');
  });

  it('--llm-model updates the llm model', async () => {
    await run(['--llm-model', 'qwen3.5:35b'], tmpDir);
    const config = readConfig(tmpDir);
    const intelligence = config.intelligence as Record<string, Record<string, unknown>>;
    expect(intelligence.llm.model).toBe('qwen3.5:35b');
  });

  it('--llm-provider and --llm-url updates provider and base_url', async () => {
    await run(['--llm-provider', 'lm-studio', '--llm-url', 'http://localhost:1234'], tmpDir);
    const config = readConfig(tmpDir);
    const intelligence = config.intelligence as Record<string, Record<string, unknown>>;
    expect(intelligence.llm.provider).toBe('lm-studio');
    expect(intelligence.llm.base_url).toBe('http://localhost:1234');
  });

  it('--embedding-model updates the embedding model', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    const config = readConfig(tmpDir);
    const intelligence = config.intelligence as Record<string, Record<string, unknown>>;
    expect(intelligence.embedding.model).toBe('nomic-embed-text');
  });

  it('--llm-context-window updates context_window', async () => {
    await run(['--llm-context-window', '32768'], tmpDir);
    const config = readConfig(tmpDir);
    const intelligence = config.intelligence as Record<string, Record<string, unknown>>;
    expect(intelligence.llm.context_window).toBe(32768);
  });

  it('partial update preserves other fields unchanged', async () => {
    // Change only the model; provider should remain 'ollama'
    await run(['--llm-model', 'llama3'], tmpDir);
    const config = readConfig(tmpDir);
    const intelligence = config.intelligence as Record<string, Record<string, unknown>>;
    expect(intelligence.llm.model).toBe('llama3');
    expect(intelligence.llm.provider).toBe('ollama');
  });

  it('prints updated intelligence config after a change', async () => {
    await run(['--llm-model', 'deepseek-r1'], tmpDir);
    const allOutput = logged.join('\n');
    // The updated config JSON should appear in output
    expect(allOutput).toContain('deepseek-r1');
  });

  it('warns about vector rebuild when embedding model changes', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    expect(logged.some((l) => l.includes('rebuild'))).toBe(true);
  });

  it('shows daemon restart notice when daemon.json exists', async () => {
    fs.writeFileSync(path.join(tmpDir, 'daemon.json'), '{}', 'utf-8');
    await run(['--llm-model', 'llama3'], tmpDir);
    expect(logged.some((l) => l.includes('restart'))).toBe(true);
  });

  it('does not show daemon restart notice when daemon.json is absent', async () => {
    await run(['--llm-model', 'llama3'], tmpDir);
    expect(logged.every((l) => !l.includes('restart'))).toBe(true);
  });
});
