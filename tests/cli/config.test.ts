import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { run } from '@myco/cli/config';

const VALID_CONFIG = {
  version: 2,
  intelligence: {
    llm: { provider: 'ollama', model: 'gpt-oss', context_window: 8192, max_tokens: 1024 },
    embedding: { provider: 'ollama', model: 'bge-m3' },
  },
  daemon: { log_level: 'info', grace_period: 30, max_log_size: 5242880 },
  capture: {
    transcript_paths: [],
    artifact_watch: ['.claude/plans/', '.cursor/plans/'],
    artifact_extensions: ['.md'],
    buffer_max_events: 500,
  },
  context: { max_tokens: 1200, layers: { plans: 200, sessions: 500, memories: 300, team: 200 } },
  team: { enabled: false, user: '', sync: 'git' },
};

function writeConfig(dir: string, config: Record<string, unknown> = VALID_CONFIG): void {
  fs.writeFileSync(path.join(dir, 'myco.yaml'), YAML.stringify(config), 'utf-8');
}

function readConfig(dir: string): Record<string, unknown> {
  return YAML.parse(fs.readFileSync(path.join(dir, 'myco.yaml'), 'utf-8')) as Record<string, unknown>;
}

describe('myco config', () => {
  let tmpDir: string;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logged: string[];
  let errors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-config-test-'));
    logged = [];
    errors = [];
    exitCode = undefined;
    originalLog = console.log;
    originalError = console.error;
    console.log = (...args: unknown[]) => logged.push(args.join(' '));
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    // Mock process.exit to capture exit code instead of terminating
    const originalExit = process.exit;
    process.exit = ((code?: number) => {
      exitCode = code;
      throw new Error(`process.exit(${code})`);
    }) as never;
    // Store for cleanup
    (globalThis as Record<string, unknown>).__originalExit = originalExit;
  });

  afterEach(() => {
    console.log = originalLog;
    console.error = originalError;
    process.exit = (globalThis as Record<string, unknown>).__originalExit as typeof process.exit;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('config get', () => {
    it('gets a nested value via dot-path', async () => {
      writeConfig(tmpDir);
      await run(['get', 'intelligence.llm.model'], tmpDir);
      expect(logged).toContain('gpt-oss');
    });

    it('gets a top-level value', async () => {
      writeConfig(tmpDir);
      await run(['get', 'version'], tmpDir);
      expect(logged).toContain('2');
    });

    it('prints object values as JSON', async () => {
      writeConfig(tmpDir);
      await run(['get', 'intelligence.llm'], tmpDir);
      const parsed = JSON.parse(logged[0]);
      expect(parsed.provider).toBe('ollama');
      expect(parsed.model).toBe('gpt-oss');
    });

    it('exits 1 for non-existent key', async () => {
      writeConfig(tmpDir);
      await expect(run(['get', 'nonexistent.path'], tmpDir)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.includes('Key not found'))).toBe(true);
    });

    it('exits 1 when no key provided', async () => {
      writeConfig(tmpDir);
      await expect(run(['get'], tmpDir)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });
  });

  describe('config set', () => {
    it('sets a nested value and persists to file', async () => {
      writeConfig(tmpDir);
      await run(['set', 'intelligence.llm.model', 'llama3'], tmpDir);
      const config = readConfig(tmpDir);
      expect((config.intelligence as Record<string, unknown> & { llm: { model: string } }).llm.model).toBe('llama3');
      expect(logged.some((l) => l.includes('Set intelligence.llm.model'))).toBe(true);
    });

    it('coerces number values via JSON parse', async () => {
      writeConfig(tmpDir);
      await run(['set', 'daemon.grace_period', '60'], tmpDir);
      const config = readConfig(tmpDir);
      expect((config.daemon as Record<string, unknown>).grace_period).toBe(60);
    });

    it('coerces boolean values via JSON parse', async () => {
      writeConfig(tmpDir);
      await run(['set', 'team.enabled', 'true'], tmpDir);
      const config = readConfig(tmpDir);
      expect((config.team as Record<string, unknown>).enabled).toBe(true);
    });

    it('creates intermediate objects along dot-path', async () => {
      // Start with a config that has a flat structure, set deep path
      writeConfig(tmpDir);
      // Setting a value in an existing object should work
      await run(['set', 'intelligence.llm.model', 'deepseek'], tmpDir);
      const config = readConfig(tmpDir);
      const intel = config.intelligence as Record<string, Record<string, unknown>>;
      expect(intel.llm.model).toBe('deepseek');
    });

    it('exits 1 on Zod validation failure', async () => {
      writeConfig(tmpDir);
      // version must be literal 2, setting to 99 should fail
      await expect(run(['set', 'version', '99'], tmpDir)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
      expect(errors.some((e) => e.includes('Validation error'))).toBe(true);
    });

    it('exits 1 when no value provided', async () => {
      writeConfig(tmpDir);
      await expect(run(['set', 'intelligence.llm.model'], tmpDir)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });

    it('prints daemon restart notice when daemon.json exists', async () => {
      writeConfig(tmpDir);
      fs.writeFileSync(path.join(tmpDir, 'daemon.json'), '{}', 'utf-8');
      await run(['set', 'intelligence.llm.model', 'llama3'], tmpDir);
      expect(logged.some((l) => l.includes('restart the daemon'))).toBe(true);
    });

    it('does not print daemon restart notice when daemon.json is absent', async () => {
      writeConfig(tmpDir);
      await run(['set', 'intelligence.llm.model', 'llama3'], tmpDir);
      expect(logged.every((l) => !l.includes('restart the daemon'))).toBe(true);
    });
  });

  describe('error handling', () => {
    it('errors on missing vault (no myco.yaml)', async () => {
      // loadConfig will throw since there's no myco.yaml
      await expect(run(['get', 'version'], tmpDir)).rejects.toThrow(/myco\.yaml not found/);
    });

    it('exits 1 with unknown subcommand', async () => {
      writeConfig(tmpDir);
      await expect(run(['unknown'], tmpDir)).rejects.toThrow('process.exit(1)');
      expect(exitCode).toBe(1);
    });
  });
});
