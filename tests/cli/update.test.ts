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
      // `myco update` now refreshes GLOBAL symbiont configs via
      // runSymbiontDetection (plan 38cff0752c919ffd §4). The detection
      // pass calls isAvailableForScope() before install(); when the
      // mock returns false the manifest is reported as `not-detected`
      // and install() is skipped — that's the right behavior for
      // these tests, which don't exercise live symbiont detection.
      isAvailableForScope: vi.fn().mockReturnValue(false),
      isConfigured: vi.fn().mockReturnValue(false),
      install: vi.fn().mockReturnValue({ hooks: false, mcp: false, skills: false, settings: false, instructions: false }),
      uninstall: vi.fn().mockReturnValue({ hooks: false, mcp: false, skills: false, settings: false, instructions: false }),
      // Detection sweeps each manifest's retired global skill dirs before the
      // detection gate, for every manifest (not just detected ones).
      sweepRetiredGlobalSkills: vi.fn(),
    };
  }),
  MYCO_MCP_SERVER_NAME: 'myco',
  // ProjectVault imports removeProjectLaunchers transitively via the
  // vault module. Provide a no-op stub so the import resolves; tests
  // here don't exercise the cleanup path.
  removeProjectLaunchers: vi.fn().mockReturnValue([]),
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
  let mycoHome: string;
  let previousMycoHome: string | undefined;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-test-'));
    vaultDir = path.join(testDir, '.myco');
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-update-home-'));
    previousMycoHome = process.env.MYCO_HOME;
    process.env.MYCO_HOME = mycoHome;
    fs.mkdirSync(vaultDir, { recursive: true });
    vi.clearAllMocks();
    ensureRunningMock.mockResolvedValue(true);
    postMock.mockReset();
    postMock.mockResolvedValue({ ok: true, data: { embedded: 12, remaining_queue_depth: 4 } });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    fs.rmSync(mycoHome, { recursive: true, force: true });
    if (previousMycoHome === undefined) {
      delete process.env.MYCO_HOME;
    } else {
      process.env.MYCO_HOME = previousMycoHome;
    }
  });

  it('rejects --project with a missing value with exit code 2 instead of fanning out to all projects', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/update.js');
    await expect(run(['--project'])).rejects.toThrow(/process\.exit\(2\)/);

    expect(stderrSpy.mock.calls.flat().join('')).toContain('--project requires a value');
    // Nothing was updated — the daemon was never consulted.
    expect(ensureRunningMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('rejects --project followed by another flag with exit code 2', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/update.js');
    await expect(run(['--project', '--all-projects'])).rejects.toThrow(/process\.exit\(2\)/);

    expect(ensureRunningMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('rejects an unknown flag with exit code 2', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/update.js');
    await expect(run(['--bogus'])).rejects.toThrow(/process\.exit\(2\)/);

    expect(stderrSpy.mock.calls.flat().join('')).toContain("unknown flag '--bogus'");
    expect(ensureRunningMock).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('still accepts --all-projects (update-installer.sh and the Makefile hardcode it)', async () => {
    // Strict argv parsing must keep the deprecated alias in the
    // vocabulary: the daemon's post-install script and `make dev-link`
    // both invoke `myco update --all-projects`.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const { run } = await import('@myco/cli/update.js');
    await run(['--all-projects']);

    // Empty sandbox registry: the command reaches the no-targets path
    // instead of exiting 2 at the parser.
    expect(logSpy.mock.calls.flat().join(' ')).toContain('No registered projects');
    logSpy.mockRestore();
  });

  it('prints help without touching project files', async () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const { run } = await import('@myco/cli/update.js');

    await run(['--help']);

    expect(stdoutSpy).toHaveBeenCalledWith(expect.stringContaining('Usage: myco update'));
    expect(fs.existsSync(path.join(vaultDir, 'myco.yaml'))).toBe(false);
    expect(ensureRunningMock).not.toHaveBeenCalled();
    stdoutSpy.mockRestore();
  });

  it('runs symbiont detection across every manifest at GLOBAL scope', async () => {
    // Plan 38cff0752c919ffd §4 — `myco update` no longer filters by
    // per-project enabled flag. It calls runSymbiontDetection() which
    // iterates every manifest and writes at global scope.
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

    // Every manifest from loadManifests() gets a SymbiontInstaller —
    // detection runs across all of them, regardless of per-project
    // enabled flag. The mock has two manifests (claude-code, cursor).
    expect(SymbiontInstaller).toHaveBeenCalledTimes(2);
    const calledNames = vi.mocked(SymbiontInstaller).mock.calls.map((c) => c[0].name).sort();
    expect(calledNames).toEqual(['claude-code', 'cursor']);
    // Each installer was constructed with installScope='global' (the
    // 7th positional arg). Pre-refactor this was 'project'.
    for (const call of vi.mocked(SymbiontInstaller).mock.calls) {
      expect(call[6]).toBe('global');
    }
  });

  it('does not gate install by per-project enabled flag', async () => {
    // Per-project opt-OUT (symbionts.<name>.enabled: false in myco.yaml)
    // is a capture-time concern, not an install-time concern. The
    // global install proceeds regardless; only the daemon's capture
    // rules apply the project-level deny-list.
    const config = {
      version: 3, config_version: 0,
      symbionts: { 'claude-code': { enabled: true }, cursor: { enabled: false } },
    };
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    const calledNames = vi.mocked(SymbiontInstaller).mock.calls.map((c) => c[0].name).sort();
    expect(calledNames).toContain('cursor');  // opted out but still installed globally
  });

  it('installs every manifest that loadManifests returns', async () => {
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
        name: 'copilot', displayName: 'GitHub Copilot', binary: 'copilot',
        configDir: '.vscode', pluginRootEnvVar: 'COPILOT_PLUGIN_ROOT',
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
        copilot: { enabled: true },
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
    expect(installedNames).toEqual(['claude-code', 'copilot', 'cursor', 'gemini']);
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

    const stampPath = path.join(mycoHome, 'last-update-version');
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
    fs.writeFileSync(path.join(mycoHome, 'last-update-version'), '0.21.0', 'utf-8');

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
    fs.writeFileSync(path.join(mycoHome, 'last-update-version'), '0.21.0', 'utf-8');

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    const stamp = fs.readFileSync(path.join(mycoHome, 'last-update-version'), 'utf-8').trim();
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

  it('moves legacy project config fields into Grove config during update', async () => {
    const groveId = 'grove_00000000000000000000000000000001';
    const projectId = 'proj_00000000000000000000000000000001';
    fs.writeFileSync(path.join(vaultDir, 'project.toml'), [
      '[project]',
      `id = "${projectId}"`,
      'name = "test-project"',
      '',
      '[grove]',
      `id = "${groveId}"`,
      'name = "Default"',
      'slug = "default"',
      '',
    ].join('\n'));
    fs.writeFileSync(path.join(vaultDir, 'myco.yaml'), YAML.stringify({
      version: 3,
      config_version: 0,
      embedding: {
        provider: 'ollama',
        model: 'bge-m3',
        run_in_deep_sleep: false,
      },
      agent: {
        scheduled_tasks_active_window_days: 3,
      },
      symbionts: { 'claude-code': { enabled: true } },
    }));
    fs.mkdirSync(path.join(testDir, '.claude'), { recursive: true });

    const { run } = await import('@myco/cli/update.js');
    await run(['--project', testDir]);

    const projectYaml = fs.readFileSync(path.join(vaultDir, 'myco.yaml'), 'utf-8');
    expect(projectYaml).not.toContain('run_in_deep_sleep');
    expect(projectYaml).not.toContain('scheduled_tasks_active_window_days');

    const groveYaml = fs.readFileSync(path.join(mycoHome, 'groves', groveId, 'grove.yaml'), 'utf-8');
    expect(groveYaml).toContain('run_in_deep_sleep: false');
    expect(groveYaml).toContain('scheduled_tasks_active_window_days: 3');
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
        id: 'grove_00000000000000000000000000000001',
        name: 'Test',
        slug: 'test',
        mode: 'local' as const,
        created_at: new Date().toISOString(),
      };
      const projects = [
        { project_id: 'proj_00000000000000000000000000000001', name: 'a', root: projectA, created_at: '', updated_at: '' },
        { project_id: 'proj_00000000000000000000000000000002', name: 'b', root: projectB, created_at: '', updated_at: '' },
      ];

      mock.module('@myco/grove/registry.js', () => ({
        listGroves: () => [groveRecord],
        listRegisteredProjects: () => projects,
      }));

      const { run } = await import('@myco/cli/update.js');
      await run(['--all-projects']);

      // The update stamp is per-machine, not per-project — one file at
      // ~/.myco/last-update-version covers every project on this host.
      expect(fs.existsSync(path.join(mycoHome, 'last-update-version'))).toBe(true);

      groveSpy.mockRestore();
    });

    it('handles a missing myco.yaml in one project without aborting the rest', async () => {
      // Project A has a vault, project B does not.
      fs.rmSync(path.join(projectB, '.myco'), { recursive: true, force: true });

      const groveRecord = {
        id: 'grove_00000000000000000000000000000001',
        name: 'Test',
        slug: 'test',
        mode: 'local' as const,
        created_at: new Date().toISOString(),
      };
      mock.module('@myco/grove/registry.js', () => ({
        listGroves: () => [groveRecord],
        listRegisteredProjects: () => [
          { project_id: 'proj_00000000000000000000000000000001', name: 'a', root: projectA, created_at: '', updated_at: '' },
          { project_id: 'proj_00000000000000000000000000000002', name: 'b', root: projectB, created_at: '', updated_at: '' },
        ],
      }));

      // The runner exits non-zero when any project fails — capture that.
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
        throw new Error(`process.exit(${code ?? 0})`);
      }) as never);

      const { run } = await import('@myco/cli/update.js');
      await expect(run(['--all-projects'])).rejects.toThrow(/process\.exit\(1\)/);

      // The machine-level stamp lands even when one project errors mid-pass.
      expect(fs.existsSync(path.join(mycoHome, 'last-update-version'))).toBe(true);

      exitSpy.mockRestore();
    });
  });
});
