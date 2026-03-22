import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

const VALID_CONFIG = {
  version: 3,
  embedding: { provider: 'ollama', model: 'bge-m3' },
  daemon: { port: null, log_level: 'info' },
  capture: {
    transcript_paths: [],
    artifact_watch: ['.claude/plans/', '.cursor/plans/'],
    artifact_extensions: ['.md'],
    buffer_max_events: 500,
  },
};

// Mock the intelligence module before importing verify
vi.mock('@myco/intelligence/llm', () => {
  return {
    createLlmProvider: vi.fn(),
    createEmbeddingProvider: vi.fn(),
  };
});

import { run } from '@myco/cli/verify';
import { createEmbeddingProvider } from '@myco/intelligence/llm';

const mockCreateEmbedding = vi.mocked(createEmbeddingProvider);

describe('myco verify', () => {
  let tmpDir: string;
  let originalLog: typeof console.log;
  let logged: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-verify-test-'));
    fs.writeFileSync(path.join(tmpDir, 'myco.yaml'), YAML.stringify(VALID_CONFIG), 'utf-8');
    logged = [];
    exitCode = undefined;
    originalLog = console.log;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));

    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;
    (globalThis as Record<string, unknown>).__originalExit = originalExit;
  });

  afterEach(() => {
    console.log = originalLog;
    process.exit = (globalThis as Record<string, unknown>).__originalExit as typeof process.exit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints OK when embedding succeeds', async () => {
    mockCreateEmbedding.mockReturnValue({
      name: 'ollama',
      embed: vi.fn().mockResolvedValue({ embedding: new Array(1024).fill(0), model: 'bge-m3', dimensions: 1024 }),
      isAvailable: vi.fn().mockResolvedValue(true),
    });

    await run([], tmpDir);

    expect(logged.some((l) => l.includes('Embedding') && l.includes('OK') && l.includes('1024 dimensions'))).toBe(true);
    expect(exitCode).toBeUndefined(); // no exit called — success
  });

  it('exits 1 when embedding fails', async () => {
    mockCreateEmbedding.mockReturnValue({
      name: 'ollama',
      embed: vi.fn().mockRejectedValue(new Error('Model not found')),
      isAvailable: vi.fn().mockResolvedValue(false),
    });

    await expect(run([], tmpDir)).rejects.toThrow('process.exit(1)');
    expect(exitCode).toBe(1);
    expect(logged.some((l) => l.includes('Embedding') && l.includes('FAIL'))).toBe(true);
  });

  it('includes provider and model names in output', async () => {
    mockCreateEmbedding.mockReturnValue({
      name: 'ollama',
      embed: vi.fn().mockResolvedValue({ embedding: [0.1], model: 'bge-m3', dimensions: 512 }),
      isAvailable: vi.fn().mockResolvedValue(true),
    });

    await run([], tmpDir);

    expect(logged.some((l) => l.includes('ollama') && l.includes('bge-m3'))).toBe(true);
  });

  it('prints note about LLM management', async () => {
    mockCreateEmbedding.mockReturnValue({
      name: 'ollama',
      embed: vi.fn().mockResolvedValue({ embedding: [0.1], model: 'bge-m3', dimensions: 512 }),
      isAvailable: vi.fn().mockResolvedValue(true),
    });

    await run([], tmpDir);

    expect(logged.some((l) => l.includes('LLM') && l.includes('Myco agent'))).toBe(true);
  });
});
