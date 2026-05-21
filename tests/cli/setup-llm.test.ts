import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';
import { MycoConfigSchema } from '@myco/config/schema';
import { run } from '@myco/cli/setup-llm';
import { resolveServiceDaemonStatePath } from '@myco/grove/paths';
import { loadGroveConfig } from '@myco/config/loader';
import { saveProjectManifest, loadProjectManifest } from '@myco/config/project-manifest';
import { createGrove, registerProjectInGrove } from '@myco/grove/registry';

function writeConfig(dir: string, config: Record<string, unknown>): void {
  fs.writeFileSync(path.join(dir, 'myco.yaml'), YAML.stringify(config), 'utf-8');
}

describe('myco setup-llm', () => {
  let tmpDir: string;
  let homeDir: string;
  let groveId: string;
  let previousMycoHome: string | undefined;
  let originalLog: typeof console.log;
  let originalError: typeof console.error;
  let logged: string[];
  let errors: string[];
  let exitCode: number | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-llm-test-'));
    homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-setup-llm-home-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = homeDir;

    const config = MycoConfigSchema.parse({ version: 3 });
    writeConfig(tmpDir, config as unknown as Record<string, unknown>);

    // Create a Grove and bind the project manifest so setup-llm can resolve
    // the Grove id for Grove-tier embedding writes.
    const grove = createGrove('default', homeDir);
    groveId = grove.id;
    registerProjectInGrove(groveId, {
      projectId: 'proj_test',
      projectName: 'test-project',
      projectRoot: path.dirname(tmpDir),
    }, homeDir);
    saveProjectManifest(tmpDir, {
      project: { id: 'proj_test', name: 'test-project' },
      grove: { id: groveId, slug: grove.slug, name: grove.name },
    });

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
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(homeDir, { recursive: true, force: true });
  });

  it('--show outputs current embedding config as JSON', async () => {
    await run(['--show'], tmpDir);
    const output = logged.join('\n');
    const parsed = JSON.parse(output);
    expect(parsed).toHaveProperty('provider');
    expect(parsed).toHaveProperty('model');
  });

  it('--embedding-model persists to Grove-tier config', async () => {
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    const groveConfig = loadGroveConfig(groveId);
    expect(groveConfig.embedding.model).toBe('nomic-embed-text');
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
    const statePath = resolveServiceDaemonStatePath();
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, '{}', 'utf-8');
    try {
      await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
      expect(logged.some((l) => l.includes('restart'))).toBe(true);
    } finally {
      try { fs.unlinkSync(statePath); } catch { /* gone */ }
    }
  });

  it('does not show daemon restart notice when daemon.json is absent', async () => {
    try { fs.unlinkSync(resolveServiceDaemonStatePath()); } catch { /* gone */ }
    await run(['--embedding-model', 'nomic-embed-text'], tmpDir);
    expect(logged.every((l) => !l.includes('restart'))).toBe(true);
  });

  it('prints note about LLM flags being ignored', async () => {
    await run(['--llm-provider', 'ollama', '--llm-model', 'qwen3.5'], tmpDir);
    expect(logged.some((l) => l.includes('LLM') && l.includes('ignored'))).toBe(true);
  });
});
