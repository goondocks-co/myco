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
    return { uninstall: vi.fn().mockReturnValue({ hooks: true, mcp: true, skills: true, settings: false, instructions: false }) };
  });
  // The CLI's `cleanProjectLocalArtifacts` now imports
  // `removeProjectLaunchers` directly — the mock must expose it.
  const removeProjectLaunchers = vi.fn().mockReturnValue(false);
  return { SymbiontInstaller, MYCO_MCP_SERVER_NAME: 'myco', removeProjectLaunchers };
});

let testVaultDir = '';
class UnsafeProjectRootError extends Error {
  constructor(public readonly projectRoot: string, public readonly reason: string) {
    super(`unsafe: ${reason}`);
  }
}
mock.module('@myco/vault/resolve.js', () => ({
  resolveVaultDir: vi.fn(() => testVaultDir),
  resolveProjectRoot: vi.fn((vaultDir: string) => path.dirname(vaultDir)),
  // Tests run with synthetic /tmp project roots that are always safe — the
  // real guard would let them through too. Stub as a no-op so cli paths
  // that import this module don't fail at import time.
  assertSafeProjectRoot: vi.fn(),
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
