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
    {
      name: 'cursor', displayName: 'Cursor', binary: 'cursor',
      configDir: '.cursor', pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
      registration: { skillsTarget: '.cursor/skills' },
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
    },
  ]),
  resolvePackageRoot: vi.fn().mockReturnValue('/tmp'),
}));

mock.module('@myco/symbionts/installer.js', () => ({
  SymbiontInstaller: vi.fn(function MockSymbiontInstaller() {
    return {
    install: vi.fn().mockReturnValue({ hooks: false, mcp: false, skills: false, settings: false, instructions: false }),
    };
  }),
  MYCO_MCP_SERVER_NAME: 'myco',
}));

const ensureRunningMock = vi.fn();
mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: vi.fn(function MockDaemonClient() {
    return {
      ensureRunning: ensureRunningMock,
    };
  }),
}));

const postMock = vi.fn();
const sharedActual = await import('@myco/cli/shared.js');
mock.module('@myco/cli/shared.js', () => ({
  ...sharedActual,
  connectToDaemon: vi.fn(async () => ({ post: postMock })),
}));

describe('myco update', () => {
  let testDir: string;
  let vaultDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-test-'));
    vaultDir = path.join(testDir, '.myco');
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.clearAllMocks();
    ensureRunningMock.mockResolvedValue(true);
    postMock.mockReset();
    postMock.mockResolvedValue({ ok: true, data: { embedded: 12, remaining_queue_depth: 4 } });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('updates only enabled symbionts from config', async () => {
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    expect(SymbiontInstaller).toHaveBeenCalledTimes(1);
    expect(vi.mocked(SymbiontInstaller).mock.calls[0][0].name).toBe('claude-code');
  });

  it('warns about registered but not enabled symbionts', async () => {
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });

    const consoleSpy = vi.spyOn(console, 'log');
    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    const output = consoleSpy.mock.calls.flat().join(' ');
    expect(output).toContain('Cursor');
    expect(output).toContain('not enabled');
    consoleSpy.mockRestore();
  });

  it('falls back to configDir heuristic when symbionts section absent', async () => {
    const config = { version: 3, config_version: 0 };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    expect(SymbiontInstaller).toHaveBeenCalled();
  });

  it('updates all enabled telemetry-capable symbionts from config', async () => {
    const { loadManifests } = await import('@myco/symbionts/detect.js');
    vi.mocked(loadManifests).mockReturnValue([
      {
        name: 'claude-code', displayName: 'Claude Code', binary: 'claude',
        configDir: '.claude', pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
        registration: { hooksTarget: '.claude/settings.json', skillsTarget: '.claude/skills' },
        hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
      },
      {
        name: 'cursor', displayName: 'Cursor', binary: 'cursor',
        configDir: '.cursor', pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
        registration: { hooksTarget: '.cursor/hooks.json', skillsTarget: '.cursor/skills' },
        hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
      },
      {
        name: 'gemini', displayName: 'Gemini CLI', binary: 'gemini',
        configDir: '.gemini', pluginRootEnvVar: 'GEMINI_PLUGIN_ROOT',
        registration: { hooksTarget: '.gemini/settings.json', skillsTarget: '.agents/skills' },
        hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
      },
      {
        name: 'vscode-copilot', displayName: 'VS Code Copilot', binary: 'code',
        configDir: '.vscode', pluginRootEnvVar: 'VSCODE_PLUGIN_ROOT',
        registration: { hooksTarget: '.github/hooks/myco-hooks.json', skillsTarget: '.agents/skills' },
        hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
      },
    ]);

    const config = {
      version: 3, config_version: 0,
      symbionts: {
        'claude-code': { enabled: true },
        cursor: { enabled: true },
        gemini: { enabled: true },
        'vscode-copilot': { enabled: true },
      },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.gemini'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.vscode'), { recursive: true });
    fs.mkdirSync(path.join(testDir, '.github/hooks'), { recursive: true });

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    expect(SymbiontInstaller).toHaveBeenCalledTimes(4);
    const installedNames = vi.mocked(SymbiontInstaller).mock.calls.map((call) => call[0].name).sort();
    expect(installedNames).toEqual(['claude-code', 'cursor', 'gemini', 'vscode-copilot']);
  });

  it('writes last-update-version stamp file after successful update', async () => {
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    const stampPath = path.join(vaultDir, 'last-update-version');
    expect(fs.existsSync(stampPath)).toBe(true);
    const stamp = fs.readFileSync(stampPath, 'utf-8').trim();
    expect(stamp).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('does not trigger any daemon-side migrations — those are the daemon\'s concern', async () => {
    // Historical regression: the CLI used to POST /api/embedding/rebuild as
    // a one-time migration gated by the update stamp. That design re-fired
    // whenever the stamp couldn't be advanced (path typo, timeout, etc.),
    // causing repeated re-embeds. Migrations now live in the daemon's
    // `migration_tasks` ledger; the CLI just regenerates configs.
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'last-update-version'), '0.21.0', 'utf-8');

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    expect(postMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/embedding/rebuild'),
      expect.anything(),
      expect.anything(),
    );
    expect(postMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/embedding/rebuild'),
      expect.anything(),
    );
  });

  it('advances the update stamp to the current version regardless of prior state', async () => {
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(vaultDir, 'last-update-version'), '0.21.0', 'utf-8');

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    const stamp = fs.readFileSync(path.join(vaultDir, 'last-update-version'), 'utf-8').trim();
    expect(stamp).not.toBe('0.21.0');
    expect(stamp).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('ensures the daemon is running after regenerating HTTP MCP config', async () => {
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    expect(ensureRunningMock).toHaveBeenCalledTimes(1);
  });

  describe('--all-projects', () => {
    let mycoHome: string;
    let projectA: string;
    let projectB: string;

    beforeEach(() => {
      mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-allprojects-'));
      process.env.MYCO_HOME = mycoHome;

      projectA = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-projA-'));
      projectB = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-projB-'));

      const writeProjectVault = (root: string) => {
        const v = path.join(root, '.myco');
        fs.mkdirSync(v, { recursive: true });
        fs.writeFileSync(
          path.join(v, 'myco.yaml'),
          YAML.stringify({ version: 3, config_version: 0, symbionts: { 'claude-code': { enabled: true } } }),
        );
        fs.mkdirSync(path.join(root, '.claude'), { recursive: true });
      };
      writeProjectVault(projectA);
      writeProjectVault(projectB);
    });

    afterEach(() => {
      fs.rmSync(mycoHome, { recursive: true, force: true });
      fs.rmSync(projectA, { recursive: true, force: true });
      fs.rmSync(projectB, { recursive: true, force: true });
      delete process.env.MYCO_HOME;
    });

    it('iterates every (Grove, project) pair when --all-projects is passed', async () => {
      const { listGroves, listRegisteredProjects } = await import('@myco/grove/registry.js');
      const groveSpy = vi.spyOn({ listGroves }, 'listGroves');
      // Direct mock the registry helpers instead of fixturing the on-disk
      // YAML — quicker to express and isolates this test from registry IO.
      const groveRecord = {
        id: 'grove_test',
        name: 'Test',
        slug: 'test',
        mode: 'local' as const,
        created_at: new Date().toISOString(),
      };
      const projects = [
        { project_id: 'proj_a', name: 'a', root: projectA, created_at: '', updated_at: '' },
        { project_id: 'proj_b', name: 'b', root: projectB, created_at: '', updated_at: '' },
      ];

      mock.module('@myco/grove/registry.js', () => ({
        listGroves: () => [groveRecord],
        listRegisteredProjects: () => projects,
      }));

      const { run } = await import('@myco/cli/update.js');
      await run(['--all-projects']);

      // Each project gets its update stamp written.
      expect(fs.existsSync(path.join(projectA, '.myco', 'last-update-version'))).toBe(true);
      expect(fs.existsSync(path.join(projectB, '.myco', 'last-update-version'))).toBe(true);

      groveSpy.mockRestore();
    });

    it('handles a missing myco.yaml in one project without aborting the rest', async () => {
      // Project A has a vault, project B does not.
      fs.rmSync(path.join(projectB, '.myco'), { recursive: true, force: true });

      const groveRecord = {
        id: 'grove_test',
        name: 'Test',
        slug: 'test',
        mode: 'local' as const,
        created_at: new Date().toISOString(),
      };
      mock.module('@myco/grove/registry.js', () => ({
        listGroves: () => [groveRecord],
        listRegisteredProjects: () => [
          { project_id: 'proj_a', name: 'a', root: projectA, created_at: '', updated_at: '' },
          { project_id: 'proj_b', name: 'b', root: projectB, created_at: '', updated_at: '' },
        ],
      }));

      // The runner exits non-zero when any project fails — capture that.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never);

      const { run } = await import('@myco/cli/update.js');
      await expect(run(['--all-projects'])).rejects.toThrow(/process\.exit\(1\)/);

      // Project A still got its stamp despite project B failing.
      expect(fs.existsSync(path.join(projectA, '.myco', 'last-update-version'))).toBe(true);

      exitSpy.mockRestore();
    });
  });
});
