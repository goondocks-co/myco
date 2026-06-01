/**
 * Tests for the global-install migration's project teardown: legacy
 * launcher stubs, orphaned plugin packages, and retired-symbiont configs.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { migrateProjectToGlobalInstall } from './global-install-migration.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { MYCO_HOME_ENV } from './paths.js';

const GEMINI_MYCO_SETTINGS = {
  hooks: {
    SessionStart: [
      { hooks: [{ name: 'myco-session-start', type: 'command', command: 'node .agents/myco-run.cjs hook session-start --symbiont gemini' }] },
    ],
  },
  mcpServers: { myco: { command: 'myco-run', args: ['mcp'] } },
  coreTools: ['ShellTool(myco *)'],
};

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

/** Build an isolated MYCO_HOME + a brownfield project carrying the
 *  pre-global artifacts. Returns the project root. */
function setupProject(geminiSettings?: unknown): string {
  const mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mig-home-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mig-proj-'));
  const prevHome = process.env[MYCO_HOME_ENV];
  process.env[MYCO_HOME_ENV] = mycoHome;
  cleanups.push(() => {
    if (prevHome === undefined) delete process.env[MYCO_HOME_ENV];
    else process.env[MYCO_HOME_ENV] = prevHome;
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  const write = (rel: string, body: string) => {
    const abs = path.join(projectRoot, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body, 'utf-8');
  };

  fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
  // Legacy launcher stubs (pre-global brownfield).
  write('.agents/myco-run.cjs', '// stub\n');
  write('.agents/myco-cli.cjs', '// stub\n');
  // OpenCode plugin + its orphaning package.json.
  write('.opencode/plugins/myco.ts', 'export const plugin = {};\n');
  write('.opencode/package.json', JSON.stringify({ dependencies: { '@opencode-ai/plugin': '^1.1.59' } }, null, 2));
  // Retired Gemini symbiont config.
  if (geminiSettings !== undefined) {
    write('.gemini/settings.json', JSON.stringify(geminiSettings, null, 2));
  }
  return projectRoot;
}

function runMigration(projectRoot: string) {
  return migrateProjectToGlobalInstall(projectRoot, {
    manifests: loadManifests(),
    packageRoot: resolvePackageRoot(),
  });
}

describe('migrateProjectToGlobalInstall — project teardown', () => {
  test('removes legacy launcher stubs', () => {
    const projectRoot = setupProject(GEMINI_MYCO_SETTINGS);
    const outcome = runMigration(projectRoot);

    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(false);
    expect(outcome.removedLaunchers).toContain(path.join('.agents', 'myco-run.cjs'));
    expect(outcome.removedLaunchers).toContain(path.join('.agents', 'myco-cli.cjs'));
  });

  test('removes a pristine orphaned OpenCode package.json', () => {
    const projectRoot = setupProject(GEMINI_MYCO_SETTINGS);
    const outcome = runMigration(projectRoot);
    expect(fs.existsSync(path.join(projectRoot, '.opencode/package.json'))).toBe(false);
    expect(outcome.removedPluginPackages).toContain('.opencode/package.json');
  });

  test('preserves an OpenCode package.json with contributor-added deps', () => {
    const projectRoot = setupProject(GEMINI_MYCO_SETTINGS);
    const pkgPath = path.join(projectRoot, '.opencode/package.json');
    fs.writeFileSync(pkgPath, JSON.stringify({
      dependencies: { '@opencode-ai/plugin': '^1.1.59', lodash: '^4.17.0' },
    }, null, 2));

    const outcome = runMigration(projectRoot);
    expect(fs.existsSync(pkgPath)).toBe(true);
    expect(outcome.removedPluginPackages).not.toContain('.opencode/package.json');
  });

  test('deletes an all-Myco retired Gemini config and archives it first', () => {
    const projectRoot = setupProject(GEMINI_MYCO_SETTINGS);
    const outcome = runMigration(projectRoot);

    expect(fs.existsSync(path.join(projectRoot, '.gemini/settings.json'))).toBe(false);
    expect(outcome.cleanedRetiredConfigs).toContain(path.join('.gemini', 'settings.json'));
    expect(outcome.archiveDir).not.toBeNull();
    const archived = path.join(outcome.archiveDir!, '.gemini', 'settings.json');
    expect(fs.existsSync(archived)).toBe(true);
  });

  test('preserves non-Myco content in a retired Gemini config', () => {
    const projectRoot = setupProject({ ...GEMINI_MYCO_SETTINGS, theme: 'dark', coreTools: ['ShellTool(myco *)', 'ReadFileTool'] });
    runMigration(projectRoot);

    const abs = path.join(projectRoot, '.gemini/settings.json');
    expect(fs.existsSync(abs)).toBe(true);
    const data = JSON.parse(fs.readFileSync(abs, 'utf-8'));
    expect(data.theme).toBe('dark');
    expect(data.coreTools).toEqual(['ReadFileTool']);
    expect(data.hooks).toBeUndefined();
    expect(data.mcpServers).toBeUndefined();
  });

  test('is idempotent — second pass is a no-op', () => {
    const projectRoot = setupProject(GEMINI_MYCO_SETTINGS);
    runMigration(projectRoot);
    const second = runMigration(projectRoot);
    expect(second.alreadyDone).toBe(true);
    expect(second.removedLaunchers).toEqual([]);
  });
});
