import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

mock.module('@myco/symbionts/detect.js', () => ({
  loadManifests: vi.fn().mockReturnValue([
    {
      name: 'cursor', displayName: 'Cursor', binary: 'cursor',
      configDir: '.cursor', pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
      registration: { skillsTarget: '.cursor/skills' },
      hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
    },
  ]),
  resolvePackageRoot: vi.fn().mockReturnValue('/tmp'),
}));

mock.module('@myco/symbionts/installer.js', () => {
  const SymbiontInstaller = vi.fn(function () {
    return {
      uninstall: vi.fn().mockReturnValue({ hooks: true, mcp: true, skills: true, settings: false, instructions: false }),
      isAvailableForScope: vi.fn().mockReturnValue(true),
    };
  });
  // The CLI's `cleanProjectLocalArtifacts` now imports
  // `removeProjectLaunchers` directly — the mock must expose it.
  const removeProjectLaunchers = vi.fn().mockReturnValue([]);
  return { SymbiontInstaller, MYCO_MCP_SERVER_NAME: 'myco', removeProjectLaunchers };
});

// Confirmation gate: tests drive the answer per-scenario. Real prompting
// (TTY readline) is covered by confirm.test.ts.
const confirmMock = vi.fn();
mock.module('@myco/cli/confirm.js', () => ({ confirmDestructive: confirmMock }));

// Global remove unregisters the OS service — that must NEVER hit the real
// launchctl/systemctl from a test. Route it to the shared fake.
import { FakeServiceManager } from '../helpers/fake-service-manager.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
let fakeServiceManager = new FakeServiceManager();
mock.module('@myco/service/manager.js', () => ({
  getServiceManager: () => fakeServiceManager,
}));

let testVaultDir = '';
class UnsafeProjectRootError extends Error {
  constructor(public readonly projectRoot: string, public readonly reason: string) {
    super(`unsafe: ${reason}`);
  }
}
mock.module('@myco/vault/resolve.js', () => ({
  resolveVaultDir: vi.fn(() => testVaultDir),
  resolveProjectRoot: vi.fn((vaultDir: string) => path.dirname(vaultDir)),
  // Faithful-shaped guard: synthetic /tmp roots pass (as they would with
  // the real predicate), while $HOME and the filesystem root throw —
  // letting the safe-root refusal tests exercise the CLI's guard without
  // unmocking the rest of the module.
  assertSafeProjectRoot: vi.fn((projectRoot: string) => {
    const resolved = path.resolve(projectRoot);
    if (resolved === os.homedir() || resolved === path.parse(resolved).root) {
      throw new UnsafeProjectRootError(resolved, 'unsafe root (test guard)');
    }
  }),
  isSafeProjectRoot: vi.fn(() => true),
  UnsafeProjectRootError,
}));

describe('myco remove --symbiont', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remove-test-'));
    testVaultDir = path.join(testDir, '.myco');
    fs.mkdirSync(testVaultDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('unregisters a single symbiont and removes from config', async () => {
    const config = {
      version: 3, config_version: 0,
      symbionts: {
        'claude-code': { enabled: true },
        'cursor': { enabled: true },
      },
    };
    fs.writeFileSync(path.join(testVaultDir, 'myco.yaml'), YAML.stringify(config));
    fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/remove.js');
    await run(['--symbiont', 'cursor']);

    expect(SymbiontInstaller).toHaveBeenCalled();
    expect(vi.mocked(SymbiontInstaller).mock.calls[0][0].name).toBe('cursor');

    const updated = YAML.parse(fs.readFileSync(path.join(testVaultDir, 'myco.yaml'), 'utf-8'));
    expect(updated.symbionts['cursor']).toBeUndefined();
    expect(updated.symbionts['claude-code']).toEqual({ enabled: true });
  });

  it('exits with error for unknown symbiont name', async () => {
    const config = { version: 3, config_version: 0, symbionts: {} };
    fs.writeFileSync(path.join(testVaultDir, 'myco.yaml'), YAML.stringify(config));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('exit'); });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const { run } = await import('@myco/cli/remove.js');
    await expect(run(['--symbiont', 'nonexistent'])).rejects.toThrow('exit');

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('Unknown symbiont');
    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

describe('myco remove strict argv', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remove-argv-'));
    testVaultDir = path.join(testDir, '.myco');
    fs.mkdirSync(testVaultDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('rejects an unknown flag with exit code 2 before touching anything', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/remove.js');
    await expect(run(['--frobnicate'])).rejects.toThrow(/process\.exit\(2\)/);

    expect(stderrSpy.mock.calls.flat().join('')).toContain("unknown flag '--frobnicate'");
    expect(fakeServiceManager.uninstallCalls).toHaveLength(0);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('rejects --symbiont with a missing value with exit code 2', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/remove.js');
    await expect(run(['--symbiont'])).rejects.toThrow(/process\.exit\(2\)/);

    expect(stderrSpy.mock.calls.flat().join('')).toContain('--symbiont requires a value');
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('rejects --symbiont combined with --remove-vault with exit code 2 instead of dropping the flag', async () => {
    fs.writeFileSync(path.join(testVaultDir, 'myco.yaml'), YAML.stringify({ version: 3, config_version: 0, symbionts: { cursor: { enabled: true } } }));
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/remove.js');
    await expect(run(['--symbiont', 'cursor', '--remove-vault'])).rejects.toThrow(/process\.exit\(2\)/);

    expect(stderrSpy.mock.calls.flat().join('')).toContain('--remove-vault/--purge cannot be combined with --symbiont');
    expect(fs.existsSync(testVaultDir)).toBe(true);
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('rejects --symbiont combined with --purge with exit code 2', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    const { run } = await import('@myco/cli/remove.js');
    await expect(run(['--symbiont', 'cursor', '--purge'])).rejects.toThrow(/process\.exit\(2\)/);

    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  });
});

describe('myco remove --project safe-root guard', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remove-guard-'));
    testVaultDir = path.join(testDir, '.myco');
    fs.mkdirSync(testVaultDir, { recursive: true });
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  async function expectRefused(args: string[]): Promise<void> {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code ?? 0})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const rmSpy = vi.spyOn(fs, 'rmSync').mockImplementation(() => {});

    const { SymbiontInstaller, removeProjectLaunchers } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/remove.js');
    await expect(run(args)).rejects.toThrow(/process\.exit\(1\)/);

    expect(errorSpy.mock.calls.flat().join(' ')).toContain('Refusing project-scope removal');
    // The guard fired before ANY cleanup: no uninstalls, no launcher
    // removal, no vault rm, no confirmation prompt.
    expect(SymbiontInstaller).not.toHaveBeenCalled();
    expect(vi.mocked(removeProjectLaunchers)).not.toHaveBeenCalled();
    expect(rmSpy).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
    rmSpy.mockRestore();
  }

  it('refuses --project $HOME (would strip the global agent configs)', async () => {
    await expectRefused(['--project', os.homedir()]);
  });

  it('refuses --project / (filesystem root)', async () => {
    await expectRefused(['--project', '/']);
  });

  it('refuses --project $HOME --remove-vault --yes before any rm (would delete ~/.myco)', async () => {
    await expectRefused(['--project', os.homedir(), '--remove-vault', '--yes']);
  });
});

describe('myco remove --remove-vault routing (project scope)', () => {
  let testDir: string;
  let sandbox: ReturnType<typeof sandboxMycoHome>;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remove-vault-'));
    testVaultDir = path.join(testDir, '.myco');
    fs.mkdirSync(testVaultDir, { recursive: true });
    fs.writeFileSync(path.join(testVaultDir, 'myco.yaml'), YAML.stringify({ version: 3, config_version: 0 }));
    sandbox = sandboxMycoHome('myco-remove-vault-home-');
    // Sentinel: if --remove-vault ever falls through to the global
    // teardown again, this launcher gets deleted.
    fs.writeFileSync(path.join(sandbox.mycoHome, 'launcher.cjs'), 'launcher', 'utf-8');
    fakeServiceManager = new FakeServiceManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(testDir, { recursive: true, force: true });
    sandbox.restore();
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('routes to project scope and deletes the vault with --yes, leaving the global install intact', async () => {
    const { run } = await import('@myco/cli/remove.js');
    await run(['--remove-vault', '--yes']);

    expect(fs.existsSync(testVaultDir)).toBe(false);
    // No machine-wide teardown happened.
    expect(fakeServiceManager.uninstallCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'launcher.cjs'))).toBe(true);
    // --yes skips the prompt entirely.
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('aborts the whole project remove when confirmation is declined — nothing mutated, exit 1', async () => {
    confirmMock.mockResolvedValue(false);
    // Teardown surfaces that must remain untouched on decline: a
    // configured symbiont dir and the project daemon state.
    fs.mkdirSync(path.join(testDir, '.cursor'), { recursive: true });
    fs.writeFileSync(path.join(testVaultDir, 'daemon.json'), JSON.stringify({ pid: 999_999 }), 'utf-8');

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/remove.js');
    await run(['--remove-vault']);

    expect(fs.existsSync(testVaultDir)).toBe(true);
    expect(process.exitCode).toBe(1);
    expect(confirmMock.mock.calls[0]![0]).toContain(testVaultDir);
    // The confirmation came BEFORE any teardown: hooks intact, daemon
    // state intact — not the half-removed state of the prior shape.
    expect(SymbiontInstaller).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(testVaultDir, 'daemon.json'))).toBe(true);
  });

  it('deletes the vault when confirmation is accepted', async () => {
    confirmMock.mockResolvedValue(true);

    const { run } = await import('@myco/cli/remove.js');
    await run(['--remove-vault']);

    expect(fs.existsSync(testVaultDir)).toBe(false);
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('myco remove --project <path>', () => {
  let cwdDir: string;
  let targetDir: string;

  beforeEach(() => {
    cwdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remove-cwd-'));
    targetDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-remove-target-'));
    // resolveVaultDir (the cwd fallback) points at a DIFFERENT project —
    // if the --project value is dropped, these tests fail loudly.
    testVaultDir = path.join(cwdDir, '.myco');
    fs.mkdirSync(testVaultDir, { recursive: true });
    fs.writeFileSync(path.join(testVaultDir, 'myco.yaml'), YAML.stringify({ version: 3, config_version: 0 }));
    vi.clearAllMocks();
  });

  afterEach(() => {
    fs.rmSync(cwdDir, { recursive: true, force: true });
    fs.rmSync(targetDir, { recursive: true, force: true });
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('honors the --project value instead of defaulting to the cwd project', async () => {
    const targetVault = path.join(targetDir, '.myco');
    fs.mkdirSync(targetVault, { recursive: true });
    fs.writeFileSync(path.join(targetVault, 'myco.yaml'), YAML.stringify({ version: 3, config_version: 0 }));
    fs.mkdirSync(path.join(targetDir, '.cursor'), { recursive: true });

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/remove.js');
    await run(['--project', targetDir]);

    // Installers operated on the targeted project root, not the cwd one.
    const roots = vi.mocked(SymbiontInstaller).mock.calls.map((c) => c[1]);
    expect(roots).toContain(targetDir);
    expect(roots).not.toContain(cwdDir);
    // The cwd project's vault was untouched.
    expect(fs.existsSync(path.join(testVaultDir, 'myco.yaml'))).toBe(true);
  });

  it('cleans launcher artifacts and exits 0 for an orphan root without myco.yaml', async () => {
    // The doctor orphan shape: a launcher stub with no .myco/myco.yaml.
    fs.mkdirSync(path.join(targetDir, '.agents'), { recursive: true });
    fs.writeFileSync(path.join(targetDir, '.agents', 'myco-run.cjs'), 'stub', 'utf-8');

    const { removeProjectLaunchers } = await import('@myco/symbionts/installer.js');
    const { run } = await import('@myco/cli/remove.js');
    await run(['--project', targetDir]);

    expect(vi.mocked(removeProjectLaunchers)).toHaveBeenCalledWith(
      targetDir,
      { legacy: true, active: true, runtimeCommand: true },
    );
    expect(process.exitCode ?? 0).toBe(0);
  });
});

describe('myco remove (global) confirmation gate', () => {
  let sandbox: ReturnType<typeof sandboxMycoHome>;

  beforeEach(() => {
    sandbox = sandboxMycoHome('myco-remove-global-home-');
    fs.writeFileSync(path.join(sandbox.mycoHome, 'launcher.cjs'), 'launcher', 'utf-8');
    fs.writeFileSync(path.join(sandbox.mycoHome, 'mcp-launcher.cjs'), 'mcp launcher', 'utf-8');
    fakeServiceManager = new FakeServiceManager();
    fakeServiceManager.installed.add('co.goondocks.myco');
    vi.clearAllMocks();
  });

  afterEach(() => {
    sandbox.restore();
    process.exitCode = 0;
    vi.restoreAllMocks();
  });

  it('aborts with exit code 1 and tears nothing down when confirmation is declined (non-TTY shape)', async () => {
    confirmMock.mockResolvedValue(false);

    const { run } = await import('@myco/cli/remove.js');
    await run([]);

    expect(process.exitCode).toBe(1);
    expect(fakeServiceManager.uninstallCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'launcher.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'mcp-launcher.cjs'))).toBe(true);
    // The summary names the machine-wide blast radius.
    expect(confirmMock.mock.calls[0]![0]).toContain('machine-wide');
  });

  it('proceeds without prompting when --yes is passed', async () => {
    const { run } = await import('@myco/cli/remove.js');
    await run(['--yes']);

    expect(confirmMock).not.toHaveBeenCalled();
    expect(fakeServiceManager.uninstallCalls.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'launcher.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(sandbox.mycoHome, 'mcp-launcher.cjs'))).toBe(false);
    // No --purge: captured data home is preserved.
    expect(fs.existsSync(sandbox.mycoHome)).toBe(true);
  });

  it('mentions ~/.myco deletion in the summary and purges it on --purge --yes', async () => {
    confirmMock.mockResolvedValue(true);

    const { run } = await import('@myco/cli/remove.js');
    await run(['--purge']);

    expect(confirmMock.mock.calls[0]![0]).toContain('DELETE');
    expect(confirmMock.mock.calls[0]![0]).toContain(sandbox.mycoHome);
    expect(fs.existsSync(sandbox.mycoHome)).toBe(false);
  });
});
