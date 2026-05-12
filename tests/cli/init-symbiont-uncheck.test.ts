import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import YAML from 'yaml';

/**
 * Tests for symmetric symbiont reconciliation in `myco init`.
 *
 * When a user unchecks a previously-enabled symbiont, init must call
 * SymbiontInstaller.uninstall() for it (not just remove it from myco.yaml).
 * When the user unchecks everything, the symbionts block is removed entirely.
 */

// We need the uninstall mock to be trackable per-instance
const uninstallMock = vi.fn().mockReturnValue({
  hooks: true, mcp: true, skills: true, settings: false, instructions: false,
});
const installerInstances: { manifest: unknown; uninstall: typeof uninstallMock }[] = [];

const { mockDb } = vi.hoisted(() => {
  const mockDb = {};
  return { mockDb };
});

mock.module('@myco/db/client.js', () => ({
  initDatabase: vi.fn().mockReturnValue(mockDb),
  openDatabase: vi.fn().mockReturnValue({
    prepare: vi.fn().mockReturnValue({
      get: vi.fn().mockReturnValue({ version: 32 }),
    }),
    run: vi.fn(),
    close: vi.fn(),
  }),
  vaultDbPath: vi.fn((dir: string) => `${dir}/myco.db`),
  closeDatabase: vi.fn(),
}));
mock.module('@myco/db/schema.js', () => ({
  createSchema: vi.fn(),
  SCHEMA_VERSION: 1,
  EMBEDDING_DIMENSIONS: 1024,
}));

mock.module('@myco/symbionts/detect.js', () => ({
  detectSymbionts: vi.fn().mockReturnValue([]),
  loadManifests: vi.fn().mockReturnValue([]),
  resolvePackageRoot: vi.fn().mockReturnValue('/tmp'),
}));

mock.module('@myco/symbionts/installer.js', () => {
  const SymbiontInstaller = vi.fn(function (this: typeof installerInstances[number], manifest: unknown) {
    const instance = {
      manifest,
      install: vi.fn().mockReturnValue({ hooks: true, mcp: true, skills: true, settings: false, instructions: false }),
      uninstall: vi.fn().mockReturnValue({ hooks: true, mcp: true, skills: true, settings: false, instructions: false }),
    };
    installerInstances.push(instance);
    return instance;
  });
  return { SymbiontInstaller, MYCO_MCP_SERVER_NAME: 'myco' };
});

mock.module('@myco/hooks/client.js', () => ({
  DaemonClient: class {
    async ensureRunning() {
      return false;
    }
  },
}));

class UnsafeProjectRootError extends Error {
  constructor(public readonly projectRoot: string, public readonly reason: string) {
    super(`unsafe: ${reason}`);
  }
}
mock.module('@myco/vault/resolve.js', () => ({
  resolveVaultDir: vi.fn(),
  resolveProjectRoot: vi.fn((vaultDir: string) => path.dirname(vaultDir)),
  assertSafeProjectRoot: vi.fn(),
  UnsafeProjectRootError,
}));

/** Shared manifest fixtures for claude-code and cursor symbionts. */
const CLAUDE_MANIFEST = {
  name: 'claude-code', displayName: 'Claude Code', binary: 'claude', configDir: '.claude',
  pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
  hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
};
const CURSOR_MANIFEST = {
  name: 'cursor', displayName: 'Cursor', binary: 'cursor', configDir: '.cursor',
  pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
  hookFields: { sessionId: 'session_id', transcriptPath: 'transcript_path', lastResponse: 'last_response', prompt: 'prompt', toolName: 'tool_name', toolInput: 'tool_input', toolOutput: 'tool_output' },
};

import { run } from '@myco/cli/init.js';
import { resolveVaultDir } from '@myco/vault/resolve.js';

describe('myco init — symbiont reconciliation', () => {
  let testDir: string;
  let vault: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-init-symbiont-'));
    vault = path.join(testDir, '.myco');
    process.env.MYCO_HOME = path.join(testDir, '.home');
    vi.clearAllMocks();
    installerInstances.length = 0;
    vi.mocked(resolveVaultDir).mockReturnValue(vault);
  });

  afterEach(() => {
    delete process.env.MYCO_HOME;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('uninstalls a newly-unchecked symbiont when re-running init with a reduced selection', async () => {
    // Set up an existing vault with claude-code and cursor both enabled
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(vault, 'myco.yaml'),
      YAML.stringify({
        version: 3,
        symbionts: {
          'claude-code': { enabled: true },
          'cursor': { enabled: true },
        },
      }),
    );

    const { loadManifests, detectSymbionts } = await import('@myco/symbionts/detect.js');
    vi.mocked(loadManifests).mockReturnValue([CLAUDE_MANIFEST, CURSOR_MANIFEST]);
    vi.mocked(detectSymbionts).mockReturnValue([
      { manifest: CLAUDE_MANIFEST, binaryFound: true, configDirFound: false },
      { manifest: CURSOR_MANIFEST, binaryFound: false, configDirFound: false },
    ]);

    // Re-run init non-interactively with only claude-code selected
    // (cursor was detected but not included in selection — simulates unchecking it)
    vi.mocked(detectSymbionts).mockReturnValue([
      { manifest: CLAUDE_MANIFEST, binaryFound: true, configDirFound: false },
      // cursor NOT in detected list → not auto-selected
    ]);
    vi.mocked(loadManifests).mockReturnValue([CLAUDE_MANIFEST, CURSOR_MANIFEST]);

    await run(['--non-interactive']);

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');

    // An installer must have been constructed for cursor (the newly-disabled symbiont)
    const cursorInstallerCall = vi.mocked(SymbiontInstaller).mock.calls.find(
      ([manifest]) => (manifest as { name: string }).name === 'cursor',
    );
    expect(cursorInstallerCall).toBeDefined();

    // Its uninstall() must have been called
    const cursorInstance = installerInstances.find(
      (inst) => (inst.manifest as { name: string }).name === 'cursor',
    );
    expect(cursorInstance?.uninstall).toHaveBeenCalled();

    // Final config reflects only claude-code
    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.symbionts?.['claude-code']).toEqual({ enabled: true });
    expect(config.symbionts?.['cursor']).toBeUndefined();
  });

  it('removes the symbionts block entirely and uninstalls all when the user selects nothing', async () => {
    // Set up an existing vault with cursor enabled
    fs.mkdirSync(vault, { recursive: true });
    fs.writeFileSync(
      path.join(vault, 'myco.yaml'),
      YAML.stringify({
        version: 3,
        symbionts: {
          'cursor': { enabled: true },
        },
      }),
    );

    const { loadManifests, detectSymbionts } = await import('@myco/symbionts/detect.js');
    // Neither symbiont detected → selectedManifests will be empty
    vi.mocked(loadManifests).mockReturnValue([CLAUDE_MANIFEST, CURSOR_MANIFEST]);
    vi.mocked(detectSymbionts).mockReturnValue([]);

    await run(['--non-interactive']);

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');

    // cursor must have been uninstalled
    const cursorInstallerCall = vi.mocked(SymbiontInstaller).mock.calls.find(
      ([manifest]) => (manifest as { name: string }).name === 'cursor',
    );
    expect(cursorInstallerCall).toBeDefined();
    const cursorInstance = installerInstances.find(
      (inst) => (inst.manifest as { name: string }).name === 'cursor',
    );
    expect(cursorInstance?.uninstall).toHaveBeenCalled();

    // The symbionts block must be absent (not just empty)
    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.symbionts).toBeUndefined();
  });

  it('does not call uninstall for symbionts that were not previously enabled', async () => {
    // Fresh init — no existing vault, no previously-enabled symbionts
    // claude-code detected, cursor not
    const { loadManifests, detectSymbionts } = await import('@myco/symbionts/detect.js');
    vi.mocked(loadManifests).mockReturnValue([CLAUDE_MANIFEST, CURSOR_MANIFEST]);
    vi.mocked(detectSymbionts).mockReturnValue([
      { manifest: CLAUDE_MANIFEST, binaryFound: true, configDirFound: false },
    ]);

    await run(['--non-interactive']);

    const { SymbiontInstaller } = await import('@myco/symbionts/installer.js');

    // No installer constructed for cursor (it was never enabled, so no uninstall needed)
    const cursorInstallerCall = vi.mocked(SymbiontInstaller).mock.calls.find(
      ([manifest]) => (manifest as { name: string }).name === 'cursor',
    );
    expect(cursorInstallerCall).toBeUndefined();

    // claude-code is written to config
    const config = YAML.parse(fs.readFileSync(path.join(vault, 'myco.yaml'), 'utf-8'));
    expect(config.symbionts?.['claude-code']).toEqual({ enabled: true });
  });
});
