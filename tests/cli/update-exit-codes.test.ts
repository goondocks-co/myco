// Exit-code rollups for `myco update`: per-symbiont global-install errors
// and a machine-wide refresh failure must surface as exit 1 instead of the
// historical silent exit 0 (RC-6 bug 4).
import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

mock.module('@myco/symbionts/detect.js', () => ({
  loadManifests: vi.fn().mockReturnValue([
    {
      name: 'claude-code', displayName: 'Claude Code', binary: 'claude',
      configDir: '.claude', pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
      registration: { skillsTarget: '.claude/skills' },
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
    },
  ]),
  resolvePackageRoot: vi.fn().mockReturnValue('/tmp'),
}));

mock.module('@myco/symbionts/installer.js', () => ({
  SymbiontInstaller: vi.fn(function MockSymbiontInstaller() {
    return {
      isAvailableForScope: vi.fn().mockReturnValue(false),
      isConfigured: vi.fn().mockReturnValue(false),
      install: vi.fn().mockReturnValue({ hooks: false, mcp: false, skills: false, settings: false, instructions: false }),
      uninstall: vi.fn().mockReturnValue({ hooks: false, mcp: false, skills: false, settings: false, instructions: false }),
    };
  }),
  MYCO_MCP_SERVER_NAME: 'myco',
  removeProjectLaunchers: vi.fn().mockReturnValue([]),
}));

// The machine-wide refresh's first step — drive its outcome per test.
const runSymbiontDetectionMock = vi.fn();
const bootstrapActual = await import('@myco/cli/bootstrap.js');
mock.module('@myco/cli/bootstrap.js', () => ({
  ...bootstrapActual,
  runSymbiontDetection: runSymbiontDetectionMock,
}));

const ensureRunningMock = vi.fn();
mock.module('@myco/daemon/client.js', () => ({
  DaemonClient: vi.fn(function MockDaemonClient() {
    return {
      ensureRunning: ensureRunningMock,
      restart: vi.fn().mockResolvedValue(true),
    };
  }),
}));

const listGrovesMock = vi.fn();
const listRegisteredProjectsMock = vi.fn();
const registryActual = await import('@myco/grove/registry.js');
mock.module('@myco/grove/registry.js', () => ({
  ...registryActual,
  listGroves: listGrovesMock,
  listRegisteredProjects: listRegisteredProjectsMock,
}));

function writeProjectVault(root: string): void {
  const vaultDir = path.join(root, '.myco');
  fs.mkdirSync(vaultDir, { recursive: true });
  fs.writeFileSync(
    path.join(vaultDir, 'myco.yaml'),
    YAML.stringify({ version: 3, config_version: 0, symbionts: { 'claude-code': { enabled: true } } }),
  );
}

describe('myco update exit-code rollups', () => {
  let testDir: string;
  let mycoHome: string;
  let fakeHome: string;
  let previousMycoHome: string | undefined;
  let previousHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-exit-proj-'));
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-exit-home-'));
    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-exit-user-'));
    previousMycoHome = process.env.MYCO_HOME;
    previousHome = process.env.HOME;
    process.env.MYCO_HOME = mycoHome;
    process.env.HOME = fakeHome;
    writeProjectVault(testDir);
    vi.clearAllMocks();
    ensureRunningMock.mockResolvedValue(true);
    listGrovesMock.mockReturnValue([]);
    listRegisteredProjectsMock.mockReturnValue([]);
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
    if (previousMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = previousMycoHome;
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    vi.restoreAllMocks();
  });

  it('exits 1 when a symbiont errors during the machine-wide refresh of a --project update', async () => {
    runSymbiontDetectionMock.mockReturnValue([
      { symbiont: 'claude-code', status: 'error', error: 'EACCES: settings.json locked' },
    ]);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { run } = await import('@myco/cli/update.js');
    await expect(run(['--project', testDir])).rejects.toThrow(/process\.exit\(1\)/);

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('EACCES: settings.json locked');
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  it('exits 0 (no exit call) when the machine-wide refresh of a --project update is clean', async () => {
    runSymbiontDetectionMock.mockReturnValue([
      { symbiont: 'claude-code', status: 'not-detected' },
    ]);

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    expect(ensureRunningMock).toHaveBeenCalled();
  });

  it('exits 1 when the machine-wide refresh throws even though every project succeeds', async () => {
    runSymbiontDetectionMock.mockImplementation(() => {
      throw new Error('manifest registry corrupted');
    });
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-exit-reg-'));
    writeProjectVault(projectRoot);
    listGrovesMock.mockReturnValue([{
      id: 'grove_00000000000000000000000000000001',
      name: 'Test', slug: 'test', mode: 'local',
      created_at: new Date().toISOString(),
    }]);
    listRegisteredProjectsMock.mockReturnValue([
      { project_id: 'proj_00000000000000000000000000000001', name: 'a', root: projectRoot, created_at: '', updated_at: '' },
    ]);

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const { run } = await import('@myco/cli/update.js');
      await expect(run([])).rejects.toThrow(/process\.exit\(1\)/);

      const stderr = errorSpy.mock.calls.flat().join(' ');
      expect(stderr).toContain('Machine-wide refresh failed');
      expect(stderr).toContain('manifest registry corrupted');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
      exitSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});
