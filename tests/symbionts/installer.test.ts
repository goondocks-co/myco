import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { derivePort } from '@myco/daemon/port.js';
import { isMycoHookCommand, MYCO_MANAGED_MARKER } from '@myco/symbionts/install-helpers.js';
import { readSymbiontFlag } from '@myco/hooks/normalize.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// --- Test manifests ---

const CLAUDE_MANIFEST: SymbiontManifest = {
  name: 'claude-code',
  displayName: 'Claude Code',
  binary: 'claude',
  configDir: '.claude',
  pluginRootEnvVar: 'CLAUDE_PLUGIN_ROOT',
  settingsPath: '.claude/settings.json',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.claude/settings.json',
    mcpTarget: '.mcp.json',
    skillsTarget: '.claude/skills',
    settingsTarget: '.claude/settings.json',
    instructionsFile: 'CLAUDE.md',
  },
};

const CURSOR_MANIFEST: SymbiontManifest = {
  name: 'cursor',
  displayName: 'Cursor',
  binary: 'cursor',
  configDir: '.cursor',
  pluginRootEnvVar: 'CURSOR_PLUGIN_ROOT',
  settingsPath: '.cursor/mcp.json',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'conversation_id' },
  registration: {
    hooksTarget: '.cursor/hooks.json',
    mcpTarget: '.cursor/mcp.json',
    mcpFormat: 'json',
    skillsTarget: '.cursor/skills',
    settingsTarget: '.cursor/settings.json',
  },
};

/**
 * Cursor's real-world transport: `cli`. Its MCP child spawns at a
 * non-workspace cwd with no project-dir env and no usable roots, so the
 * stdio bridge can't carry tenancy — `installMcp()` must skip the server
 * and sweep any stale `myco` entry. Kept distinct from CURSOR_MANIFEST so
 * the mcp-path tests above still exercise a generic mcp-transport agent.
 */
const CURSOR_CLI_MANIFEST: SymbiontManifest = {
  ...CURSOR_MANIFEST,
  capabilities: { toolTransport: 'cli' },
};

/** Minimal manifest with no hooks — used to test skip-guard behavior. */
const NO_HOOKS_MANIFEST: SymbiontManifest = {
  name: 'no-hooks-agent',
  displayName: 'No Hooks Agent',
  binary: 'nohooks',
  configDir: '.nohooks',
  pluginRootEnvVar: 'NOHOOKS_PLUGIN_ROOT',
  settingsPath: '.nohooks/settings.json',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    mcpTarget: '.nohooks/mcp.json',
    skillsTarget: '.nohooks/skills',
  },
};

const CODEX_MANIFEST: SymbiontManifest = {
  name: 'codex',
  displayName: 'Codex',
  binary: 'codex',
  configDir: '.codex',
  pluginRootEnvVar: 'CODEX_PLUGIN_ROOT',
  settingsPath: '.codex/config.toml',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.codex/hooks.json',
    mcpTarget: '.codex/config.toml',
    mcpFormat: 'toml',
    skillsTarget: '.agents/skills',
    settingsTarget: '.codex/config.toml',
    settingsFormat: 'toml',
  },
};

/**
 * Synthetic cli-transport symbiont whose hooks, MCP, and settings all resolve
 * to one shared JSON file (`mcpFormat: 'json'`) — the `shouldBatchJsonTargets`
 * condition. Exercises the batched-JSON write path's transport gate: a future
 * JSON-colocated cli symbiont must NOT get an MCP server written, and any
 * pre-existing `myco` entry must be swept.
 */
const CLI_BATCHED_MANIFEST: SymbiontManifest = {
  name: 'cli-batched',
  displayName: 'CLI Batched',
  binary: 'clibatched',
  configDir: '.clibatched',
  pluginRootEnvVar: 'CLIBATCHED_PLUGIN_ROOT',
  settingsPath: '.clibatched/config.json',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.clibatched/config.json',
    mcpTarget: '.clibatched/config.json',
    mcpFormat: 'json',
    settingsTarget: '.clibatched/config.json',
    skillsTarget: '.agents/skills',
  },
  capabilities: {
    toolTransport: 'cli',
  },
};

const GEMINI_MANIFEST: SymbiontManifest = {
  name: 'gemini',
  displayName: 'Gemini CLI',
  binary: 'gemini',
  configDir: '.gemini',
  pluginRootEnvVar: 'GEMINI_PLUGIN_ROOT',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.gemini/settings.json',
    mcpTarget: '.gemini/settings.json',
    skillsTarget: '.agents/skills',
    settingsTarget: '.gemini/settings.json',
    instructionsFile: 'GEMINI.md',
  },
};

const COPILOT_MANIFEST: SymbiontManifest = {
  name: 'copilot',
  displayName: 'GitHub Copilot',
  binary: 'copilot',
  configDir: '.vscode',
  pluginRootEnvVar: 'COPILOT_PLUGIN_ROOT',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'sessionId' },
  registration: {
    hooksTarget: '.github/hooks/myco-hooks.json',
    mcpTarget: '.vscode/mcp.json',
    skillsTarget: '.agents/skills',
    settingsTarget: '.vscode/settings.json',
    instructionsFile: '.github/copilot-instructions.md',
  },
};

const WINDSURF_MANIFEST: SymbiontManifest = {
  name: 'windsurf',
  displayName: 'Windsurf',
  binary: 'windsurf',
  configDir: '.windsurf',
  pluginRootEnvVar: 'WINDSURF_PLUGIN_ROOT',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'trajectory_id' },
  registration: {
    hooksTarget: '.windsurf/hooks.json',
    skillsTarget: '.agents/skills',
    settingsTarget: '.windsurf/settings.json',
  },
};

const OPENCODE_MANIFEST: SymbiontManifest = {
  name: 'opencode',
  displayName: 'OpenCode',
  binary: 'opencode',
  configDir: '.opencode',
  pluginRootEnvVar: 'OPENCODE_PLUGIN_ROOT',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.opencode/plugins/myco.ts',
    hooksFormat: 'plugin-file',
    pluginPackageTarget: '.opencode/package.json',
    mcpTarget: 'opencode.json',
    mcpServersKey: 'mcp',
    settingsTarget: 'opencode.json',
    skillsTarget: '.agents/skills',
  },
};

/** Fixture content written as the opencode plugin.ts template in tests. */
const OPENCODE_PLUGIN_TEMPLATE_CONTENT = `// Managed by Myco. Regenerated on \`myco update\`.
// myco:plugin-marker:opencode
import type { Plugin } from "@opencode-ai/plugin";
export const MycoPlugin: Plugin = async () => ({});
export default MycoPlugin;
`;

const OPENCODE_PACKAGE_TEMPLATE_CONTENT = `{
  "dependencies": {
    "@opencode-ai/plugin": "^1.1.59"
  }
}
`;

// --- Minimal hooks template for tests ---

// Mirrors the real claude-code template: bare `{{mycoLauncher}}` placeholder,
// no `cd` prefix (the binary's launch preamble anchors cwd in-process). The
// installer substitutes the placeholder with the pinned binary path and
// appends the `--myco-managed` ownership marker.
const HOOKS_TEMPLATE = {
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: '{{mycoLauncher}} hook session-start --symbiont claude-code', timeout: 10 },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: 'command', command: '{{mycoLauncher}} hook stop --symbiont claude-code', timeout: 30 },
      ],
    },
  ],
  PreCompact: [
    {
      hooks: [
        { type: 'command', command: '{{mycoLauncher}} hook pre-compact --symbiont claude-code', timeout: 5 },
      ],
    },
  ],
  PostCompact: [
    {
      hooks: [
        { type: 'command', command: '{{mycoLauncher}} hook post-compact --symbiont claude-code', timeout: 5 },
      ],
    },
  ],
};

const MCP_TEMPLATE = {
  myco: {
    type: 'stdio',
    command: '{{mycoBinary}}', args: ['mcp'],
  },
};

// --- Test helpers ---

let projectRoot: string;
let packageRoot: string;
const originalMycoHome = process.env.MYCO_HOME;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/**
 * Deterministic, whitespace-free binary path pinned as the machine
 * `runtime.command` in `beforeEach`, so every hook-command the installer emits
 * resolves to a stable, assertable binary path instead of the test runner's
 * own `process.execPath`. Shared across the installHooks and direct-binary
 * suites.
 */
const PINNED_BINARY = '/opt/myco/bin/myco';

/** Pin the machine runtime command so the emitted binary path is stable. */
function pinRuntimeBinary(binary: string): void {
  fs.writeFileSync(path.join(installerMycoHome, 'runtime.command'), `${binary}\n`, 'utf-8');
}

/**
 * Per-command assertions for the direct-binary hook form the installer emits:
 * the pinned binary path, `--symbiont <agent>`, the `--myco-managed` marker
 * exactly once, and no `node`/`.cjs` trampoline.
 */
function assertDirectBinaryCommands(commands: string[], agent: string): void {
  for (const cmd of commands) {
    expect(cmd).toContain(PINNED_BINARY);
    expect(cmd).toContain(`--symbiont ${agent}`);
    expect(cmd).toContain(MYCO_MANAGED_MARKER);
    expect(cmd.split(MYCO_MANAGED_MARKER).length - 1).toBe(1);
    expect(cmd).not.toContain('node ');
    expect(cmd).not.toContain('.cjs');
  }
}

function setupPackageRoot(): void {
  // Create template files in packageRoot
  const claudeTemplateDir = path.join(packageRoot, 'src/symbionts/templates/claude-code');
  const cursorTemplateDir = path.join(packageRoot, 'src/symbionts/templates/cursor');
  const codexTemplateDir = path.join(packageRoot, 'src/symbionts/templates/codex');
  const copilotTemplateDir = path.join(packageRoot, 'src/symbionts/templates/copilot');
  const geminiTemplateDir = path.join(packageRoot, 'src/symbionts/templates/gemini');
  fs.mkdirSync(claudeTemplateDir, { recursive: true });
  fs.mkdirSync(cursorTemplateDir, { recursive: true });
  fs.mkdirSync(codexTemplateDir, { recursive: true });
  fs.mkdirSync(copilotTemplateDir, { recursive: true });
  fs.mkdirSync(geminiTemplateDir, { recursive: true });

  writeJson(path.join(claudeTemplateDir, 'hooks.json'), HOOKS_TEMPLATE);
  writeJson(path.join(claudeTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(claudeTemplateDir, 'settings.json'), {
    permissions: { allow: ['Bash(myco *)', 'Bash(myco:*)', 'Bash(myco-dev *)', 'Bash(myco-dev:*)'] },
  });
  // Cursor's real hooks.json carries the bare `{{mycoLauncher}}` placeholder
  // (the cd prefix was dropped — the binary anchors cwd in-process). The
  // installer substitutes the binary path and appends the ownership marker.
  writeJson(path.join(cursorTemplateDir, 'hooks.json'), {
    sessionStart: [{ command: '{{mycoLauncher}} hook session-start --symbiont cursor', type: 'command', timeout: 10 }],
    stop: [{ command: '{{mycoLauncher}} hook stop --symbiont cursor', type: 'command', timeout: 30 }],
    preCompact: [{ command: '{{mycoLauncher}} hook pre-compact --symbiont cursor', type: 'command', timeout: 5 }],
  });
  writeJson(path.join(cursorTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(cursorTemplateDir, 'settings.json'), {
    'chat.tools.terminal.autoApprove': { 'myco': true, 'myco-dev': true },
  });
  writeJson(path.join(codexTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook session-start --symbiont codex', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook stop --symbiont codex', timeout: 30 }] }],
  });
  writeJson(path.join(codexTemplateDir, 'mcp.json'), {
    myco: { command: '{{mycoBinary}}', args: ['mcp'] },
  });
  writeJson(path.join(codexTemplateDir, 'settings.json'), {
    features: { hooks: true },
  });
  writeJson(path.join(copilotTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook session-start --symbiont copilot', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook stop --symbiont copilot', timeout: 30 }] }],
    PreCompact: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook pre-compact --symbiont copilot', timeout: 5 }] }],
  });
  writeJson(path.join(copilotTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(copilotTemplateDir, 'settings.json'), {
    'chat.tools.terminal.autoApprove': { 'myco': true, 'myco-dev': true },
  });
  // Gemini is a test-only manifest (no production template); mirror the
  // post-flip convention — bare `{{mycoLauncher}}`, no cd prefix.
  writeJson(path.join(geminiTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ name: 'myco-session-start', type: 'command', command: '{{mycoLauncher}} hook session-start --symbiont gemini', timeout: 10000 }] }],
    AfterAgent: [{ hooks: [{ name: 'myco-stop', type: 'command', command: '{{mycoLauncher}} hook stop --symbiont gemini', timeout: 30000 }] }],
    PreCompress: [{ hooks: [{ name: 'myco-pre-compact', type: 'command', command: '{{mycoLauncher}} hook pre-compact --symbiont gemini', timeout: 5000 }] }],
  });
  writeJson(path.join(geminiTemplateDir, 'mcp.json'), {
    myco: { command: '{{mycoBinary}}', args: ['mcp'] },
  });
  writeJson(path.join(geminiTemplateDir, 'settings.json'), {
    coreTools: ['ShellTool(myco *)', 'ShellTool(myco-dev *)'],
  });

  const windsurfTemplateDir = path.join(packageRoot, 'src/symbionts/templates/windsurf');
  fs.mkdirSync(windsurfTemplateDir, { recursive: true });
  writeJson(path.join(windsurfTemplateDir, 'hooks.json'), {
    pre_user_prompt: [{ command: '{{mycoLauncher}} hook user-prompt-submit --symbiont windsurf' }],
    post_cascade_response: [{ command: '{{mycoLauncher}} hook stop --symbiont windsurf' }],
  });

  // opencode uses plugin-file hooks + non-standard MCP key + a package.json for plugin deps
  const opencodeTemplateDir = path.join(packageRoot, 'src/symbionts/templates/opencode');
  fs.mkdirSync(opencodeTemplateDir, { recursive: true });
  fs.writeFileSync(path.join(opencodeTemplateDir, 'plugin.ts'), OPENCODE_PLUGIN_TEMPLATE_CONTENT, 'utf-8');
  fs.writeFileSync(path.join(opencodeTemplateDir, 'package.json'), OPENCODE_PACKAGE_TEMPLATE_CONTENT, 'utf-8');
  writeJson(path.join(opencodeTemplateDir, 'mcp.json'), {
    myco: { type: 'local', command: ['{{mycoBinary}}', 'mcp'] },
  });
  writeJson(path.join(opencodeTemplateDir, 'settings.json'), {
    permission: { bash: { 'myco *': 'allow', 'myco-dev *': 'allow' } },
  });

  // Copy hook-guard template so installHookGuard can find it
  fs.copyFileSync(
    path.resolve('packages/myco/src/symbionts/templates/myco-run.cjs'),
    path.join(packageRoot, 'src/symbionts/templates/myco-run.cjs'),
  );
  writeJson(path.join(windsurfTemplateDir, 'settings.json'), {
    'windsurf.cascadeCommandsAllowList': ['myco', 'myco-dev'],
  });

  // Create shared instruction stub template
  fs.writeFileSync(
    path.join(packageRoot, 'src/symbionts/templates/instructions-stub.md'),
    '# Project Instructions\n\n> **Source of truth:** Read and follow [`AGENTS.md`](AGENTS.md)\n>\n> If anything in this file conflicts with `AGENTS.md`, **`AGENTS.md` wins**.\n\n<!-- This file exists so {agentDisplayName} discovers project instructions. -->\n<!-- All rules are maintained in AGENTS.md to avoid cross-agent duplication. -->\n<!-- Edit AGENTS.md, not this file, when adding or changing project rules. -->\n',
  );

  // Create a skill directory
  const skillDir = path.join(packageRoot, 'skills/myco');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');
}

let installerMycoHome: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-project-'));
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-package-'));
  // Sandbox MYCO_HOME for every installer test. The installer reads config via
  // loadMergedConfig, whose tier-strip migration now relocates capture.* (and
  // notifications.*) into machine config. Without a clean temp home this would
  // both contaminate the developer's real ~/.myco/config.yaml and, when that
  // file already carries a capture block, skip the move (idempotency) so a
  // planted capture.plan_dirs value would be lost. Tests that need a specific
  // home still override process.env.MYCO_HOME locally.
  installerMycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-home-'));
  process.env.MYCO_HOME = installerMycoHome;
  // Pin a deterministic binary so every emitted hook command resolves to a
  // stable path. Tests that need a different binary (whitespace / backslash)
  // overwrite this pin locally.
  pinRuntimeBinary(PINNED_BINARY);
  setupPackageRoot();
});

afterEach(() => {
  if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = originalMycoHome;
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(packageRoot, { recursive: true, force: true });
  fs.rmSync(installerMycoHome, { recursive: true, force: true });
});

// =====================
// loadTemplate
// =====================

describe('loadTemplate', () => {
  it('loads hooks template for claude-code', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const template = installer.loadTemplate('hooks');
    expect(template).not.toBeNull();
    expect(template).toHaveProperty('SessionStart');
    expect(template).toHaveProperty('Stop');
  });

  it('returns null for missing template', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const template = installer.loadTemplate('nonexistent');
    expect(template).toBeNull();
  });

  it('loads hooks template for Cursor (flat format)', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const template = installer.loadTemplate('hooks');
    expect(template).not.toBeNull();
    expect(template).toHaveProperty('sessionStart');
    expect(template).toHaveProperty('stop');
  });

  it('loads from dist layout as fallback', () => {
    // Remove source layout template
    const srcPath = path.join(packageRoot, 'src/symbionts/templates/claude-code/hooks.json');
    fs.unlinkSync(srcPath);

    // Create dist layout template
    const distDir = path.join(packageRoot, 'dist/src/symbionts/templates/claude-code');
    fs.mkdirSync(distDir, { recursive: true });
    writeJson(path.join(distDir, 'hooks.json'), HOOKS_TEMPLATE);

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const template = installer.loadTemplate('hooks');
    expect(template).not.toBeNull();
    expect(template).toHaveProperty('SessionStart');
  });
});

// =====================
// installHooks
// =====================

describe('installHooks', () => {
  it('writes hooks to settings.json', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installHooks();

    expect(result).toBe(true);
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);

    const settings = readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });

  it('preserves non-Myco hooks', () => {
    // Pre-populate settings with a non-Myco hook
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'my-other-tool start', timeout: 5 },
            ],
          },
        ],
      },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Should have both the non-Myco hook and the Myco hook
    expect(hooks.SessionStart).toHaveLength(2);
    const commands = hooks.SessionStart.flatMap(
      (g: unknown) => ((g as { hooks: Array<{ command: string }> }).hooks ?? []).map(h => h.command),
    );
    expect(commands).toContain('my-other-tool start');
    const mycoCommands = commands.filter((c) => c !== 'my-other-tool start');
    assertDirectBinaryCommands(mycoCommands, 'claude-code');
  });

  it('replaces stale Myco hooks on update', () => {
    // Pre-populate with an old Myco hook (different timeout)
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'myco-run hook session-start', timeout: 5 },
            ],
          },
        ],
      },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Should have exactly one SessionStart group (the old one replaced, not duplicated)
    expect(hooks.SessionStart).toHaveLength(1);
    const group = hooks.SessionStart[0] as { hooks: Array<{ timeout: number }> };
    // Template has timeout: 10, old had timeout: 5
    expect(group.hooks[0].timeout).toBe(10);
  });

  it('preserves non-hook settings keys', () => {
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      env: { FOO: 'bar' },
      hooks: {},
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(settingsPath);
    expect(settings.env).toEqual({ FOO: 'bar' });
    expect(settings.hooks).toBeDefined();
  });

  it('returns false when no hooksTarget in manifest', () => {
    const installer = new SymbiontInstaller(NO_HOOKS_MANIFEST, projectRoot, packageRoot);
    const result = installer.installHooks();
    expect(result).toBe(false);
  });

  it('writes Myco-owned hook groups WITHOUT a _meta marker (ownership rides on the --myco-managed flag)', () => {
    // Earlier installs stamped `_meta.owner: myco` on every group as a
    // redundant identity signal. That field broke strict-schema agents
    // (Windsurf silently rejects entries with unknown fields), so it's
    // retired. Ownership is now identified by the `--myco-managed` marker
    // appended to the direct-binary hook command — the only signal that
    // needs to exist.
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();
    const settings = readJson(path.join(projectRoot, '.claude/settings.json'));
    const hooks = settings.hooks as Record<string, Array<Record<string, unknown>>>;
    for (const groups of Object.values(hooks)) {
      for (const group of groups) {
        expect(group._meta).toBeUndefined();
        // The command MUST carry the ownership marker so future reinstalls
        // can find this entry by the marker scan.
        const commands: string[] = Array.isArray(group.hooks)
          ? (group.hooks as Array<{ command?: string }>).map((h) => h.command ?? '')
          : [typeof group.command === 'string' ? group.command : ''];
        expect(commands.some((c) => c.includes(MYCO_MANAGED_MARKER))).toBe(true);
      }
    }
  });

  it('strips a previous Myco install (legacy launcher-path) and replaces with a clean direct-binary group', () => {
    // Legacy-seed: a previous install wrote the canonical launcher-path
    // form. The launcher-path substring scan still recognizes it as
    // Myco-owned, so it gets swept and replaced with the direct-binary
    // group; the third-party tenant entry is preserved untouched.
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node .agents/myco-run.cjs hook session-start --symbiont claude-code', timeout: 5 }] },
          { hooks: [{ type: 'command', command: '/Users/x/Library/Application Support/GitKrakenCLI/gk ai hook run --host claude-code' }] },
        ],
      },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();
    const settings = readJson(settingsPath);
    const groups = (settings.hooks as Record<string, Array<{ hooks?: Array<{ command: string }>; command?: string }>>).SessionStart;
    expect(groups).toHaveLength(2);
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    // Third-party tenant entry survives.
    expect(commands.some((c) => c.includes('GitKrakenCLI'))).toBe(true);
    // The legacy launcher-path entry is gone, replaced by the direct-binary form.
    expect(commands.some((c) => c.includes('node .agents/myco-run.cjs'))).toBe(false);
    const mycoCommands = commands.filter((c) => !c.includes('GitKrakenCLI'));
    assertDirectBinaryCommands(mycoCommands, 'claude-code');
    // No `_meta` field anywhere on the installed groups.
    for (const group of groups) {
      expect((group as Record<string, unknown>)._meta).toBeUndefined();
    }
  });

  it('PRESERVES user-authored hooks that invoke Myco from a non-canonical launcher path', () => {
    // User's own hook calls Myco's launcher from a wrapper they own.
    // Without the marker, Myco MUST treat it as a third-party tenant
    // entry and leave it intact on reinstall — the substring scan is
    // intentionally strict (canonical paths only) so user wrappers
    // are not falsely claimed.
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: 'node /opt/me/launcher.cjs --symbiont claude-code && my-wrapper', timeout: 5 }] },
        ],
      },
    });
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();
    const settings = readJson(settingsPath);
    const groups = (settings.hooks as Record<string, Array<{ hooks?: Array<{ command: string }> }>>).SessionStart;
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    // User's hook survives untouched.
    expect(commands.some((c) => c.includes('/opt/me/launcher.cjs'))).toBe(true);
    // Myco's direct-binary hook is also added alongside.
    expect(commands.some((c) => c.includes(MYCO_MANAGED_MARKER) && c.includes('hook session-start'))).toBe(true);
  });

  it('reinstall after marker landed is idempotent — repeated installs do not accumulate groups', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();
    installer.installHooks();
    installer.installHooks();
    const settings = readJson(path.join(projectRoot, '.claude/settings.json'));
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Every event present after first install carries exactly one group
    // after three installs — Myco strips its own marker-tagged groups
    // before re-adding the template on each reinstall.
    for (const [event, groups] of Object.entries(hooks)) {
      expect(groups, `event ${event} accumulated groups across reinstalls`).toHaveLength(1);
    }
    // The events the project-scope manifest cares about must be present.
    expect(hooks.SessionStart).toBeDefined();
    expect(hooks.Stop).toBeDefined();
  });

  it('installs pre and post compact hooks for Claude Code', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(path.join(projectRoot, '.claude/settings.json'));
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;

    expect(hooks.PreCompact).toHaveLength(1);
    expect(hooks.PostCompact).toHaveLength(1);
    expect(hooks.PreCompact[0]?.hooks[0]?.command).toBe(`${PINNED_BINARY} hook pre-compact --symbiont claude-code ${MYCO_MANAGED_MARKER}`);
    expect(hooks.PostCompact[0]?.hooks[0]?.command).toBe(`${PINNED_BINARY} hook post-compact --symbiont claude-code ${MYCO_MANAGED_MARKER}`);
  });

  it('installs pre-compact hook for Cursor', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(path.join(projectRoot, '.cursor/hooks.json'));
    const preCompact = ((settings.hooks as Record<string, unknown[]>).preCompact as Array<{ command: string }>);

    expect(preCompact).toHaveLength(1);
    // The installer substitutes `{{mycoLauncher}}` with the direct binary path
    // and appends the ownership marker — no `cd` prefix (cwd is anchored
    // in-process by the binary's launch preamble).
    expect(preCompact[0]?.command).toBe(`${PINNED_BINARY} hook pre-compact --symbiont cursor ${MYCO_MANAGED_MARKER}`);
    // No raw placeholder leaks through to the installed file.
    expect(preCompact[0]?.command).not.toContain('{{mycoLauncher}}');
  });

  it('installs pre-compact hook for Gemini CLI', () => {
    fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(path.join(projectRoot, '.gemini/settings.json'));
    const hooks = settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>;

    expect(hooks.PreCompress).toHaveLength(1);
    expect(hooks.PreCompress[0]?.hooks[0]?.command).toBe(`${PINNED_BINARY} hook pre-compact --symbiont gemini ${MYCO_MANAGED_MARKER}`);
  });

  it('installs pre-compact hook for VS Code Copilot', () => {
    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(path.join(projectRoot, '.github/hooks/myco-hooks.json'));
    const preCompact = ((settings.hooks as Record<string, unknown[]>).PreCompact as Array<{ hooks: Array<{ command: string }> }>);

    expect(preCompact).toHaveLength(1);
    expect(preCompact[0]?.hooks[0]?.command).toBe(`${PINNED_BINARY} hook pre-compact --symbiont copilot ${MYCO_MANAGED_MARKER}`);
  });
});

// =====================
// installMcp
// =====================

describe('installMcp', () => {
  it('writes MCP server to .mcp.json for Claude Code', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(true);
    const mcpPath = path.join(projectRoot, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);

    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.myco).toBeDefined();
    // MCP command points at the resolved self-contained binary's `mcp`
    // subcommand — the pinned runtime.command path, forward-slashed — not the
    // `myco-run` node shim (which fails on a native Windows agent with no node).
    expect((servers.myco as Record<string, unknown>).command).toBe(PINNED_BINARY);
    expect((servers.myco as Record<string, unknown>).args).toEqual(['mcp']);
    expect(JSON.stringify(servers.myco)).not.toContain('myco-run');
  });

  it('substitutes a whitespace-free, forward-slashed binary path into the MCP command', () => {
    // Reuse the hook-path invariant: the embedded binary path must contain no
    // whitespace (breaks argv-split spawn) and no backslashes (forward-slashed
    // so the unquoted command is portable across bash / argv / cmd).
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installMcp();

    const config = readJson(path.join(projectRoot, '.mcp.json'));
    const command = (config.mcpServers as Record<string, Record<string, unknown>>).myco.command as string;
    expect(command).toBe(PINNED_BINARY);
    expect(command).not.toMatch(/\s/);
    expect(command).not.toContain('\\');
  });

  it('writes MCP server to .cursor/mcp.json for Cursor', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(true);
    const mcpPath = path.join(projectRoot, '.cursor/mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);

    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers.myco).toBeDefined();
  });

  it('preserves other MCP servers', () => {
    const mcpPath = path.join(projectRoot, '.mcp.json');
    writeJson(mcpPath, {
      mcpServers: {
        'other-tool': { type: 'stdio', command: 'other-tool', args: ['serve'] },
      },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installMcp();

    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, unknown>;
    expect(servers['other-tool']).toBeDefined();
    expect(servers.myco).toBeDefined();
  });

  it('skips the MCP server for a cli-transport symbiont (cursor) and writes nothing', () => {
    const installer = new SymbiontInstaller(CURSOR_CLI_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    // cli transport: the stdio bridge can't carry tenancy, so no server.
    expect(result).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.cursor/mcp.json'))).toBe(false);
  });

  it('sweeps a stale myco MCP server for a cli-transport symbiont (cursor)', () => {
    const mcpPath = path.join(projectRoot, '.cursor/mcp.json');
    // Pre-existing state: a stale myco entry from a prior mcp-transport era,
    // alongside a user's own server.
    writeJson(mcpPath, {
      mcpServers: {
        myco: { type: 'stdio', command: 'myco-run', args: ['mcp'] },
        'other-tool': { type: 'stdio', command: 'other-tool', args: ['serve'] },
      },
    });

    const installer = new SymbiontInstaller(CURSOR_CLI_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(false);
    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    // Stale myco entry swept; the user's own server preserved.
    expect(servers?.myco).toBeUndefined();
    expect(servers?.['other-tool']).toBeDefined();
  });

  it('writes the stdio bridge for mcp-transport Copilot (resolved binary, no url)', () => {
    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(true);
    const config = readJson(path.join(projectRoot, '.vscode/mcp.json'));
    // The test COPILOT_MANIFEST sets no project-local mcpServersKey, so the
    // installer defaults to `mcpServers`.
    const servers = config.mcpServers as Record<string, unknown>;
    const myco = servers.myco as Record<string, unknown>;
    expect(myco).toBeDefined();
    expect(myco.command).toBe(PINNED_BINARY);
    expect(myco.args).toEqual(['mcp']);
    expect(myco.url).toBeUndefined();
    expect(JSON.stringify(myco)).not.toContain('myco-run');
  });

  it('writes the local-array stdio bridge for mcp-transport OpenCode (resolved binary, no url)', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(true);
    const config = readJson(path.join(projectRoot, 'opencode.json'));
    // opencode hosts MCP under the non-standard `mcp` key. Its command is an
    // ARRAY — only element 0 (the launcher) carries the binary substitution.
    const servers = config.mcp as Record<string, unknown>;
    const myco = servers.myco as Record<string, unknown>;
    expect(myco).toBeDefined();
    expect(myco.type).toBe('local');
    expect(myco.command).toEqual([PINNED_BINARY, 'mcp']);
    expect(myco.url).toBeUndefined();
    expect(JSON.stringify(myco)).not.toContain('myco-run');
  });
});

describe('installBatchedJson transport gate', () => {
  /** Plant the cli-batched templates the batched-JSON path reads. */
  function setupCliBatchedTemplates(): void {
    const dir = path.join(packageRoot, 'src/symbionts/templates/cli-batched');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'hooks.json'), {
      Stop: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook stop --symbiont cli-batched', timeout: 30 }] }],
    });
    writeJson(path.join(dir, 'mcp.json'), MCP_TEMPLATE);
    writeJson(path.join(dir, 'settings.json'), { features: { capture: true } });
  }

  it('omits the MCP server for a cli-transport symbiont and sweeps any existing myco entry', () => {
    setupCliBatchedTemplates();
    const sharedFile = path.join(projectRoot, '.clibatched/config.json');
    // Pre-existing state: a stale myco MCP server alongside a user's own.
    writeJson(sharedFile, {
      mcpServers: {
        myco: { type: 'stdio', command: 'myco-run', args: ['mcp'] },
        'other-tool': { type: 'stdio', command: 'other-tool', args: ['serve'] },
      },
    });

    const installer = new SymbiontInstaller(CLI_BATCHED_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    // Batched path reports no MCP write for the cli-transport symbiont.
    expect(result.mcp).toBe(false);
    // Hooks still installed (shared file) — the symbiont remains captured.
    expect(result.hooks).toBe(true);

    const config = readJson(sharedFile);
    const servers = config.mcpServers as Record<string, unknown> | undefined;
    // The stale myco entry is swept; the user's own server is preserved.
    expect(servers?.myco).toBeUndefined();
    expect(servers?.['other-tool']).toBeDefined();
    // Hooks block landed in the same file.
    expect(config.hooks).toBeDefined();
  });
});

// =====================
// installSkills
// =====================

describe('installSkills', () => {
  it('creates canonical symlinks in .agents/skills/', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installSkills();

    expect(result).toBe(true);
    const canonicalLink = path.join(projectRoot, '.agents/skills/myco');
    expect(fs.existsSync(canonicalLink)).toBe(true);
    expect(fs.lstatSync(canonicalLink).isSymbolicLink()).toBe(true);

    // Symlink target should point to the package skills dir
    const target = fs.readlinkSync(canonicalLink);
    expect(target).toBe(path.join(packageRoot, 'skills/myco'));
  });

  it('creates agent-specific symlinks chaining to canonical', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    const agentLink = path.join(projectRoot, '.claude/skills/myco');
    expect(fs.existsSync(agentLink)).toBe(true);
    expect(fs.lstatSync(agentLink).isSymbolicLink()).toBe(true);

    // Agent-specific symlink should be a relative path to canonical
    const target = fs.readlinkSync(agentLink);
    expect(target).toContain('.agents/skills/myco');
  });

  it('is idempotent — re-running does not fail', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);

    const result1 = installer.installSkills();
    const result2 = installer.installSkills();

    expect(result1).toBe(true);
    expect(result2).toBe(true);

    // Symlinks still valid
    const canonicalLink = path.join(projectRoot, '.agents/skills/myco');
    expect(fs.lstatSync(canonicalLink).isSymbolicLink()).toBe(true);
  });

  it('updates stale symlinks', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    // Create a new packageRoot with different skills path to simulate staleness
    const canonicalLink = path.join(projectRoot, '.agents/skills/myco');
    const originalTarget = fs.readlinkSync(canonicalLink);

    // Manually replace symlink with a stale one
    fs.unlinkSync(canonicalLink);
    fs.symlinkSync('/nonexistent/old/path', canonicalLink);
    expect(fs.readlinkSync(canonicalLink)).toBe('/nonexistent/old/path');

    // Re-install should fix the stale symlink
    installer.installSkills();
    expect(fs.readlinkSync(canonicalLink)).toBe(originalTarget);
  });

  it('returns false when no skillsTarget in manifest', () => {
    const noSkillsManifest: SymbiontManifest = {
      ...CLAUDE_MANIFEST,
      registration: { hooksTarget: '.claude/settings.json', mcpTarget: '.mcp.json' },
    };
    const installer = new SymbiontInstaller(noSkillsManifest, projectRoot, packageRoot);
    const result = installer.installSkills();
    expect(result).toBe(false);
  });

  it('returns false when skills directory does not exist', () => {
    // Remove skills directory from packageRoot
    fs.rmSync(path.join(packageRoot, 'skills'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installSkills();
    expect(result).toBe(false);
  });

  it('handles multiple skills', () => {
    // Add a second skill
    const secondSkill = path.join(packageRoot, 'skills/myco-rules');
    fs.mkdirSync(secondSkill, { recursive: true });
    fs.writeFileSync(path.join(secondSkill, 'SKILL.md'), '# Rules\n');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco-rules'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco-rules'))).toBe(true);
  });

  it('removes legacy built-in skill symlinks during install', () => {
    fs.mkdirSync(path.join(projectRoot, '.agents/skills'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.claude/skills'), { recursive: true });

    fs.symlinkSync('/tmp/old-rules-skill', path.join(projectRoot, '.agents/skills/rules'));
    fs.symlinkSync('../../.agents/skills/rules', path.join(projectRoot, '.claude/skills/rules'));
    fs.symlinkSync('/tmp/old-curate-skill', path.join(projectRoot, '.agents/skills/myco-curate'));
    fs.symlinkSync('../../.agents/skills/myco-curate', path.join(projectRoot, '.claude/skills/myco-curate'));

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/rules'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/rules'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco-curate'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco-curate'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
  });

  it('ignores skill directories that do not contain SKILL.md', () => {
    fs.mkdirSync(path.join(packageRoot, 'skills/rules'), { recursive: true });
    fs.mkdirSync(path.join(packageRoot, 'skills/myco-curate'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/rules'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco-curate'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco-rules'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
  });
});

// =====================
// installSettings
// =====================

describe('installSettings', () => {
  it('writes permissions to Claude Code settings', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.claude/settings.json'));
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco-dev *)');
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco *)');
  });

  it('writes auto-approve to Cursor settings', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.cursor/settings.json'));
    expect((settings as Record<string, unknown>)['chat.tools.terminal.autoApprove']).toEqual({
      'myco': true,
      'myco-dev': true,
    });
  });

  it('writes auto-approve to VS Code settings', () => {
    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.vscode/settings.json'));
    expect((settings as Record<string, unknown>)['chat.tools.terminal.autoApprove']).toEqual({
      'myco': true,
      'myco-dev': true,
    });
  });

  it('preserves existing settings', () => {
    const settingsDir = path.join(projectRoot, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      env: { FOO: 'bar' },
      permissions: { allow: ['Bash(git *)'] },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    expect((settings as Record<string, unknown>).env).toEqual({ FOO: 'bar' });
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(git *)');
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco-dev *)');
  });

  it('deduplicates on repeated install', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.claude/settings.json'));
    const allow = (settings.permissions as { allow: string[] }).allow;
    const mycoEntries = allow.filter((e: string) => e === 'Bash(myco-dev *)');
    expect(mycoEntries.length).toBe(1);
  });

  it('returns false when no settingsTarget in manifest', () => {
    const noSettingsManifest: SymbiontManifest = {
      ...CODEX_MANIFEST,
      registration: { ...CODEX_MANIFEST.registration, settingsTarget: undefined },
    };
    const installer = new SymbiontInstaller(noSettingsManifest, projectRoot, packageRoot);
    const result = installer.installSettings();
    expect(result).toBe(false);
  });

  it('merges auto-approve keys with existing keys', () => {
    const settingsDir = path.join(projectRoot, '.vscode');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      'chat.tools.terminal.autoApprove': { 'other-tool': true },
    });

    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const autoApprove = (settings as Record<string, unknown>)['chat.tools.terminal.autoApprove'] as Record<string, boolean>;
    expect(autoApprove['other-tool']).toBe(true);
    expect(autoApprove['myco']).toBe(true);
    expect(autoApprove['myco-dev']).toBe(true);
  });
});

// =====================
// install (integration)
// =====================

describe('install', () => {
  it('runs all steps and returns results for Claude Code', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.instructions).toBe(true);
  });

  it('verifies all files exist after Claude Code install', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    // Hooks + settings in settings.json
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = readJson(settingsPath);
    expect(settings.hooks).toBeDefined();
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco-dev *)');

    // MCP config
    const mcpPath = path.join(projectRoot, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);

    // Skills
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco'))).toBe(true);
  });

  it('runs all steps and returns results for Cursor', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    // Cursor has hooks but no instructionsFile
    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.instructions).toBe(false);
  });

  it('runs all steps for VS Code Copilot', () => {
    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.instructions).toBe(true);

    // Hooks in .github/hooks/myco-hooks.json
    expect(fs.existsSync(path.join(projectRoot, '.github/hooks/myco-hooks.json'))).toBe(true);
    // MCP in .vscode/mcp.json
    expect(fs.existsSync(path.join(projectRoot, '.vscode/mcp.json'))).toBe(true);
    // Settings in .vscode/settings.json
    const settings = readJson(path.join(projectRoot, '.vscode/settings.json'));
    expect((settings as Record<string, unknown>)['chat.tools.terminal.autoApprove']).toEqual({
      'myco': true,
      'myco-dev': true,
    });
  });

  it('runs all steps for Gemini CLI (shared settings file)', () => {
    fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.instructions).toBe(true);

    // All in one file
    const settings = readJson(path.join(projectRoot, '.gemini/settings.json'));
    expect(settings.hooks).toBeDefined();
    expect((settings as Record<string, unknown>).mcpServers).toBeDefined();
    expect(((settings as Record<string, unknown>).mcpServers as Record<string, unknown>).myco).toBeDefined();
    expect((settings as Record<string, unknown>).coreTools).toContain('ShellTool(myco-dev *)');
  });

  it('is idempotent — running twice produces same on-disk state, second pass is a no-op', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);

    const result1 = installer.install();
    const result2 = installer.install();

    // First run wrote everything; second run is a no-op because the
    // content-diff gate in writeJsonFile and writeManagedFile detects
    // unchanged content. Instructions follow the same shape — they're
    // only ever written once, then preserved.
    expect(result1.hooks).toBe(true);
    expect(result1.mcp).toBe(true);
    expect(result1.settings).toBe(true);
    expect(result1.instructions).toBe(true);
    expect(result2.hooks).toBe(false);
    expect(result2.mcp).toBe(false);
    expect(result2.settings).toBe(false);
    expect(result2.instructions).toBe(false);

    // Settings file should be identical
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    const settings = readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Should not have duplicated hook groups
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.Stop).toHaveLength(1);
  });
});

// =====================
// gitignore management
// =====================

describe('gitignore management', () => {
  it('adds per-skill canonical entries to project .gitignore', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agents/skills/myco');
    // Should NOT blanket-ignore the directory (generated skills need to be committed)
    expect(gitignore).not.toContain('.agents/skills/\n');
  });

  it('creates local .gitignore in agent-specific skills directory', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const localGitignore = fs.readFileSync(path.join(projectRoot, '.claude/skills/.gitignore'), 'utf-8');
    expect(localGitignore).toContain('*');
    expect(localGitignore).toContain('!.gitignore');
    // Project-level .gitignore should NOT contain agent-specific skill entries
    const projectGitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(projectGitignore).not.toContain('.claude/skills/');
  });

  it('does not duplicate existing entries', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    installer.install(); // Second run

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.agents\/skills\/myco\b/g);
    expect(matches?.length).toBe(1);
  });

  it('appends to existing .gitignore content', () => {
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n.env\n');
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.agents/skills/myco');
  });

  it('adds repo-relative custom plan dirs when ignore_plan_dirs_in_git is enabled', () => {
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/myco.yaml'), [
      'version: 3',
      'capture:',
      '  plan_dirs:',
      '    - docs/design',
      '    - ./docs/specs/',
      '    - ~/plans',
      '    - /tmp/plans',
      '  ignore_plan_dirs_in_git: true',
      '',
    ].join('\n'));

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('docs/design/');
    expect(gitignore).toContain('docs/specs/');
    expect(gitignore).not.toContain('~/plans');
    expect(gitignore).not.toContain('/tmp/plans');
  });

  it('removes custom plan dirs from the managed block when the flag is disabled', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco/myco.yaml'), [
      'version: 3',
      'capture:',
      '  plan_dirs:',
      '    - docs/design',
      '  ignore_plan_dirs_in_git: true',
      '',
    ].join('\n'));

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    // capture.* is Machine-tier (2026-06 scope correction): the first install's
    // loadMergedConfig relocated the planted capture block out of myco.yaml and
    // into machine config. To flip the flag we must edit the machine config,
    // not myco.yaml (which no longer carries capture).
    const machineConfigPath = path.join(installerMycoHome, 'config.yaml');
    fs.writeFileSync(machineConfigPath, [
      'capture:',
      '  plan_dirs:',
      '    - docs/design',
      '  ignore_plan_dirs_in_git: false',
      '',
    ].join('\n'));
    installer.install();

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).not.toContain('docs/design/');
    expect(gitignore).toContain('.agents/skills/myco');
  });
});

// =====================
// installMcp (TOML)
// =====================

describe('installMcp (TOML)', () => {
  it('writes MCP server entry to TOML config verbatim from the template', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.myco]');
    expect(content).toContain(`command = "${PINNED_BINARY}"`);
    expect(content).toContain('args = ["mcp"]');
    expect(content).not.toContain('myco-run');
    expect(content).not.toContain('cwd = "."');
    expect(content).not.toContain('[mcp_servers.myco.env]');
  });

  it('preserves existing TOML content', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), 'model = "gpt-5-codex"\n\n[mcp_servers.other]\ncommand = "other"\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installMcp();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('model = "gpt-5-codex"');
    expect(content).toContain('[mcp_servers.other]');
    expect(content).toContain('[mcp_servers.myco]');
  });

  it('replaces existing myco section on update', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[mcp_servers.myco]\ncommand = "old-command"\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installMcp();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain(`command = "${PINNED_BINARY}"`);
    expect(content).not.toContain('old-command');
  });

  it('does not write cwd into the installed Codex MCP entry', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);

    installer.installMcp();

    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).not.toContain('cwd = "."');
  });
});

// =====================
// installMcp — per-symbiont tool transport
// =====================

describe('installMcp tool transport', () => {
  it('cli-transport symbiont: installMcp writes nothing and sweeps the existing block (project scope)', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-cli-tr-'));
    const cliCodex = {
      ...CODEX_MANIFEST,
      capabilities: { ...(CODEX_MANIFEST.capabilities ?? {}), toolTransport: 'cli' as const },
    };
    const installer = new SymbiontInstaller(cliCodex, projectRoot, packageRoot); // default 'project' scope
    const cfg = path.join(projectRoot, '.codex', 'config.toml'); // codex mcpTarget
    fs.mkdirSync(path.dirname(cfg), { recursive: true });
    fs.writeFileSync(cfg, '[mcp_servers.myco]\nurl = "http://127.0.0.1:20915/mcp"\n');
    expect(installer.installMcp()).toBe(false);
    const after = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf-8') : '';
    expect(after).not.toContain('[mcp_servers.myco]');
  });

  it('cli-transport symbiont: installMcp sweeps the GLOBAL config (production path)', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-'));
    const origHome = process.env.HOME;
    const origSandbox = process.env.MYCO_SANDBOX_ROOT;
    process.env.HOME = home;
    process.env.MYCO_SANDBOX_ROOT = home; // satisfy assertSandboxedHome — HOME must resolve inside the sandbox root
    try {
      const cliCodex = {
        ...CODEX_MANIFEST,
        // Global scope reads reg.globalMcpTarget; the production codex manifest
        // declares ~/.codex/config.toml. The test fixture omits it, so add the
        // normalized array shape the installer iterates.
        registration: {
          ...CODEX_MANIFEST.registration,
          globalMcpTarget: [{ path: '~/.codex/config.toml' }],
        },
        capabilities: { ...(CODEX_MANIFEST.capabilities ?? {}), toolTransport: 'cli' as const },
      };
      // installScope 'global' is the 7th constructor arg (see bootstrap.ts:92-93).
      const installer = new SymbiontInstaller(cliCodex, '/', packageRoot, false, undefined, null, 'global');
      const cfg = path.join(home, '.codex', 'config.toml'); // codex globalMcpTarget = ~/.codex/config.toml
      fs.mkdirSync(path.dirname(cfg), { recursive: true });
      fs.writeFileSync(cfg, '[mcp_servers.myco]\nurl = "http://127.0.0.1:20915/mcp"\n');
      expect(installer.installMcp()).toBe(false);
      const after = fs.existsSync(cfg) ? fs.readFileSync(cfg, 'utf-8') : '';
      expect(after).not.toContain('[mcp_servers.myco]');
    } finally {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
      if (origSandbox === undefined) delete process.env.MYCO_SANDBOX_ROOT; else process.env.MYCO_SANDBOX_ROOT = origSandbox;
    }
  });

  it('mcp-transport symbiont: installMcp still writes the server', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-mcp-tr-'));
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot); // mcp by default
    expect(installer.installMcp()).toBe(true);
    expect(fs.readFileSync(path.join(projectRoot, '.cursor', 'mcp.json'), 'utf-8')).toContain('myco');
  });
});

// =====================
// installMcp — runtime command isolation
// =====================

describe('installMcp runtime command isolation', () => {
  function writeRuntimeCommand(value: string): void {
    fs.mkdirSync(path.join(projectRoot, '.myco'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, '.myco', 'runtime.command'), value, 'utf-8');
  }

  it('does not copy runtime.command into opencode MCP config', () => {
    const runtime = '/Users/test/.local/bin/myco-dev';
    writeRuntimeCommand(runtime);
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);

    installer.installMcp();

    const config = readJson(path.join(projectRoot, 'opencode.json'));
    const servers = config.mcp as Record<string, { command: unknown }>;
    // The MCP command resolves to the MACHINE runtime pin (PINNED_BINARY), not
    // the project-local `.myco/runtime.command` — `resolveManagedBinaryPath`
    // reads `resolveRuntimeCommand()` with no vaultDir, so the project pin (and
    // its `myco-dev` value) never leak into the installed config.
    expect(servers.myco.command).toEqual([PINNED_BINARY, 'mcp']);
    expect(JSON.stringify(servers.myco.command)).not.toContain(runtime);
    expect(JSON.stringify(servers.myco.command)).not.toContain('myco-dev');
  });

  it('does not copy runtime.command into string-form MCP configs', () => {
    const runtime = '/Users/test/.local/bin/myco-dev';
    writeRuntimeCommand(runtime);
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);

    installer.installMcp();

    const config = readJson(path.join(projectRoot, '.mcp.json'));
    const servers = config.mcpServers as Record<string, { command: unknown; args: unknown }>;
    // Same isolation as the array form: the MCP command is the MACHINE pin,
    // so the project-local `myco-dev` runtime never lands in the config.
    expect(servers.myco.command).toBe(PINNED_BINARY);
    expect(servers.myco.args).toEqual(['mcp']);
    expect(JSON.stringify(servers.myco)).not.toContain(runtime);
    expect(JSON.stringify(servers.myco)).not.toContain('myco-dev');
  });
});

// =====================
// installSettings (TOML)
// =====================

describe('installSettings (TOML)', () => {
  it('writes [features] section to Codex config.toml', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.installSettings();

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
  });

  it('preserves unrelated sections when adding [features]', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[shell_environment_policy]\ninherit = "core"\n\n[shell_environment_policy.set]\nMYCO_CMD = "myco-dev"\n\n[mcp_servers.myco]\ncommand = "myco-run"\nargs = ["mcp"]\n',
    );

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[shell_environment_policy]');
    expect(content).toContain('inherit = "core"');
    expect(content).toContain('[mcp_servers.myco]');
    expect(content).toContain('[shell_environment_policy.set]');
    expect(content).toContain('MYCO_CMD = "myco-dev"');
    expect(content).toContain('command = "myco-run"');
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
  });

  it('is idempotent on repeated install', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    const first = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    installer.installSettings();
    const second = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(second).toBe(first);
    // And only one [features] header exists
    expect(first.match(/\[features\]/g)?.length).toBe(1);
  });

  it('replaces stale value on update', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = false\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('hooks = true');
    expect(content).not.toContain('hooks = false');
  });

  it('install() composes MCP + settings into one TOML file', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.mcp).toBe(true);
    expect(result.settings).toBe(true);

    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.myco]');
    expect(content).toContain(`command = "${PINNED_BINARY}"`);
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
  });

  it('reconciles dropped template keys via the install audit', () => {
    // When a previous Myco template wrote a key the new template no longer
    // claims (here: `codex_hooks` → `hooks`), install consults the audit and
    // strips the now-stale Myco-owned key. The audit makes this a real
    // ownership transfer rather than the old whole-section-rewrite hack
    // (which also nuked unrelated sibling keys the user had added).
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[mcp_servers.myco]\nurl = "http://127.0.0.1:20915/mcp"\n\n[features]\ncodex_hooks = true\n',
    );
    // Pre-seed the audit as if an older Myco had recorded ownership of the
    // now-renamed key. This is what every upgrading user's machine looks
    // like after a previous install/init cycle.
    const auditDir = path.join(projectRoot, '.myco', 'installer-audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'codex-project-settings.json'),
      JSON.stringify({ schema: 1, wroteKeys: ['features.codex_hooks'] }) + '\n',
    );

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).not.toContain('codex_hooks');
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
    expect(content).toContain('[mcp_servers.myco]');
  });

  it('preserves user-added sibling keys inside a Myco-managed section', () => {
    // Data-preservation regression: install must not nuke user keys that
    // happen to live in the same TOML section Myco writes to. Codex users
    // commonly add their own `[features]` flags; those must survive.
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[features]\nmy_user_flag = true\nother_flag = "yes"\n',
    );

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('my_user_flag = true');
    expect(content).toContain('other_flag = "yes"');
    expect(content).toContain('hooks = true');
  });

  it('records audit only for keys it actually mutated', () => {
    // When the user already has [features].hooks = true, install is a no-op
    // on disk and the audit must not claim ownership of that key. This is
    // what makes the uninstall path safe: an uninstall that runs after this
    // install will leave the user's pre-existing value alone.
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = true\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const auditPath = path.join(projectRoot, '.myco', 'installer-audit', 'codex-project-settings.json');
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf-8'));
    expect(audit.wroteKeys).not.toContain('features.hooks');
  });
});

// =====================
// uninstallSettings (TOML)
// =====================

describe('uninstallSettings (TOML)', () => {
  it('removes hooks key and drops empty [features] section', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[mcp_servers.myco]\ncommand = "myco-run"\nargs = ["mcp"]\n',
    );

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    const result = installer.uninstallSettings();

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).not.toContain('[features]');
    expect(content).not.toContain('hooks');
    expect(content).toContain('[mcp_servers.myco]');
  });

  it('preserves sibling feature flags in [features]', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[features]\nsome_other_flag = true\n',
    );

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.uninstallSettings();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[features]');
    expect(content).toContain('some_other_flag = true');
    expect(content).not.toContain('hooks = true');
  });

  it('deletes file when no TOML content remains', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.uninstallSettings();

    expect(fs.existsSync(path.join(codexDir, 'config.toml'))).toBe(false);
  });

  it('returns false when no Myco install is on record', () => {
    // No prior install → no audit → uninstall must be a no-op. This is the
    // safe-default behavior that prevents data loss for users whose config
    // pre-dates Myco entirely (their pre-existing [features].hooks survives).
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = true\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.uninstallSettings();
    expect(result).toBe(false);
    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('hooks = true');
  });

  it('preserves pre-existing user [features].hooks across install + uninstall', () => {
    // Smoke-test regression (live repro 2026-05-24): a user whose codex
    // config already enabled hooks lost the setting entirely on `myco
    // remove`. The fix: install detects the value already matches and
    // refuses to claim ownership; uninstall therefore leaves the key alone.
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const userOriginal = '[user]\nsome_existing_setting = true\n\n[features]\nhooks = true\n';
    fs.writeFileSync(path.join(codexDir, 'config.toml'), userOriginal);

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.uninstallSettings();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[user]');
    expect(content).toContain('some_existing_setting = true');
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
  });

  it('full install then uninstall leaves legacy MYCO_CMD stripped', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    const original = '[shell_environment_policy]\ninherit = "core"\n\n[shell_environment_policy.set]\nMYCO_CMD = "myco-dev"\n';
    fs.writeFileSync(path.join(codexDir, 'config.toml'), original);

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.install();

    installer.uninstallSettings();
    installer.uninstallMcp();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('[shell_environment_policy]');
    expect(content).toContain('inherit = "core"');
    expect(content).not.toContain('MYCO_CMD = "myco-dev"');
    expect(content).not.toContain('[shell_environment_policy.set]');
    expect(content).not.toContain('[features]');
    expect(content).not.toContain('[mcp_servers.myco]');
  });

  it('cleanup preserves exec argv arrays (opencode MCP shape)', () => {
    // Regression: an earlier version of stripLegacyFromJson walked into
    // every array and filtered out legacy tokens. That
    // would corrupt opencode.json which stores its MCP server command
    // as a `type: "local"` exec argv array (`command: ["myco-run", "mcp"]`).
    // The cleanup must recognize `command` / `args` as exec argv arrays
    // and skip them.
    const openCodeJsonPath = path.join(projectRoot, 'opencode.json');
    writeJson(openCodeJsonPath, {
      mcp: {
        myco: {
          type: 'local',
          command: ['myco-run', 'mcp'],
        },
      },
      permission: {
        bash: {
          'myco-run *': 'allow',  // legacy allowlist — this SHOULD get stripped
          'myco *': 'allow',
        },
      },
    });

    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const result = readJson(openCodeJsonPath);
    // Exec argv array stays a clean 2-element argv (not filtered token-by-token
    // down to `['mcp']`). install() rewrites the `myco` server, so element 0 is
    // now the resolved binary path; the structural invariant — `command` is a
    // preserved exec argv array — is what this test guards.
    expect(((result.mcp as Record<string, unknown>).myco as Record<string, unknown>).command)
      .toEqual([PINNED_BINARY, 'mcp']);
    // Legacy permission key stripped.
    const bash = ((result.permission as Record<string, unknown>).bash) as Record<string, unknown>;
    expect(bash['myco-run *']).toBeUndefined();
    // Non-legacy keys preserved.
    expect(bash['myco *']).toBe('allow');
  });

  it('cleanup strips `myco-run` from windsurf cascadeCommandsAllowList (non-exec string array)', () => {
    // Counterpart to the opencode preservation test: a non-exec string
    // array (windsurf's shell allowlist) should still get `myco-run`
    // stripped, because that entry is a legacy permission token, not
    // an invocation argv.
    const settingsDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      'windsurf.cascadeCommandsAllowList': ['other-cmd', 'myco-run', 'myco', 'myco-dev'],
    });

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const allow = (settings as Record<string, unknown>)['windsurf.cascadeCommandsAllowList'] as string[];
    expect(allow).toContain('other-cmd');
    expect(allow).toContain('myco');
    expect(allow).toContain('myco-dev');
    expect(allow).not.toContain('myco-run');
  });
});

// =====================
// uninstall
// =====================

describe('uninstall', () => {
  it('removes hooks from settings.json', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const result = installer.uninstall();
    expect(result.hooks).toBe(true);

    // Settings file is deleted when empty (hooks was the only content)
    expect(fs.existsSync(path.join(projectRoot, '.claude/settings.json'))).toBe(false);
  });

  it('preserves non-Myco hooks on uninstall', () => {
    const settingsDir = path.join(projectRoot, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    fs.writeFileSync(path.join(settingsDir, 'settings.json'), JSON.stringify({
      hooks: {
        PostToolUse: [
          { hooks: [{ type: 'command', command: 'npm run lint', timeout: 30 }] },
          { hooks: [{ type: 'command', command: 'myco-run hook post-tool-use', timeout: 5 }] },
        ],
      },
    }));

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.uninstallHooks();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const commands = (settings.hooks as Record<string, Array<{ hooks: Array<{ command: string }> }>>)
      .PostToolUse.flatMap((g) => g.hooks.map((h) => h.command));
    expect(commands).toContain('npm run lint');
    expect(commands).not.toContain('myco-run hook post-tool-use');
  });

  it('removes MCP server from JSON config', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    installer.uninstallMcp();

    // .mcp.json is deleted when empty (myco was the only server)
    expect(fs.existsSync(path.join(projectRoot, '.mcp.json'))).toBe(false);
  });

  it('preserves other MCP servers on uninstall', () => {
    fs.writeFileSync(path.join(projectRoot, '.mcp.json'), JSON.stringify({
      mcpServers: { other: { command: 'other' }, myco: { command: 'myco-run', args: ['mcp'] } },
    }));

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.uninstallMcp();

    const config = readJson(path.join(projectRoot, '.mcp.json'));
    expect(config.mcpServers.other).toBeDefined();
    expect(config.mcpServers.myco).toBeUndefined();
  });

  it('removes MCP server from TOML config', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'),
      'model = "gpt-5"\n\n[mcp_servers.myco]\ncommand = "myco-run"\nargs = ["mcp"]\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.uninstallMcp();

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('model = "gpt-5"');
    expect(content).not.toContain('[mcp_servers.myco]');
  });

  it('removes skill symlinks', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);

    installer.uninstallSkills();

    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco'))).toBe(false);
  });

  it('cleans gitignore entries', () => {
    // Pre-create .gitignore with non-Myco content so it survives uninstall
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n');
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const gitignoreBefore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignoreBefore).toContain('.agents/skills/');

    installer.uninstall();

    const gitignoreAfter = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignoreAfter).not.toContain('.agents/skills/');
    expect(gitignoreAfter).not.toContain('.claude/skills/myco');
    expect(gitignoreAfter).toContain('node_modules/');
  });

  it('removes permissions from Claude Code settings', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const settingsBefore = readJson(path.join(projectRoot, '.claude/settings.json'));
    expect((settingsBefore.permissions as { allow: string[] }).allow).toContain('Bash(myco-dev *)');

    installer.uninstallSettings();

    // settings.json still exists because it has hooks, but permissions.allow entries are gone
    // (hooks were separately installed and not uninstalled here)
    const settingsAfter = readJson(path.join(projectRoot, '.claude/settings.json'));
    expect(settingsAfter.permissions).toBeUndefined();
  });

  it('audit-track: install + uninstall preserves a value-collision Bash(myco *) entry (Claude Code)', () => {
    // User already had `Bash(myco *)` in their permissions.allow
    // before installing Myco (maybe they hand-allowed it for some
    // workflow). Install dedupes — no array-append happens for that
    // entry, so the audit doesn't claim ownership. Uninstall must
    // preserve it.
    const settingsDir = path.join(projectRoot, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      permissions: { allow: ['Bash(myco *)', 'Bash(user-custom *)'] },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json')) as {
      permissions?: { allow: string[] };
    };
    const allow = settings.permissions?.allow ?? [];
    // User's pre-existing entries survive.
    expect(allow).toContain('Bash(myco *)');
    expect(allow).toContain('Bash(user-custom *)');
    // Myco's other additions (myco:*, myco-dev *, myco-dev:*) are gone.
    expect(allow).not.toContain('Bash(myco:*)');
    expect(allow).not.toContain('Bash(myco-dev *)');
    expect(allow).not.toContain('Bash(myco-dev:*)');
  });

  it('removes auto-approve from VS Code settings', () => {
    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    installer.uninstallSettings();

    // File removed when empty
    expect(fs.existsSync(path.join(projectRoot, '.vscode/settings.json'))).toBe(false);
  });

  it('preserves non-Myco auto-approve entries on uninstall', () => {
    const settingsDir = path.join(projectRoot, '.vscode');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      'chat.tools.terminal.autoApprove': { 'other-tool': true, 'myco': true, 'myco-dev': true },
    });

    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const autoApprove = (settings as Record<string, unknown>)['chat.tools.terminal.autoApprove'] as Record<string, boolean>;
    expect(autoApprove['other-tool']).toBe(true);
    expect(autoApprove['myco']).toBeUndefined();
    expect(autoApprove['myco-dev']).toBeUndefined();
  });

  // -----------------------------------------------------------------
  // Stewardship audit regression — value-collision case
  //
  // The data-loss bug the audit closes: user already had a setting
  // whose value happens to MATCH Myco's template (e.g. they enabled
  // `chat.tools.terminal.autoApprove.myco-dev = true` themselves
  // before installing Myco). Install is a no-op on disk; if uninstall
  // used value-match removal it would silently strip the user's
  // setting. With the audit, install records only changes Myco
  // actually made — so this user-pre-existing value survives.
  // -----------------------------------------------------------------
  it('audit-track: install + uninstall preserves a value-collision user setting (Copilot/VS Code)', () => {
    const settingsDir = path.join(projectRoot, '.vscode');
    fs.mkdirSync(settingsDir, { recursive: true });
    // User has pre-set `myco-dev: true` independently — value matches
    // Myco's template by coincidence.
    writeJson(path.join(settingsDir, 'settings.json'), {
      'chat.tools.terminal.autoApprove': { 'other-tool': true, 'myco-dev': true },
    });

    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json')) as Record<string, unknown>;
    const autoApprove = settings['chat.tools.terminal.autoApprove'] as Record<string, boolean>;
    // The user's pre-existing value survives.
    expect(autoApprove['myco-dev']).toBe(true);
    // Myco's own additions are gone (myco: true was Myco-only).
    expect(autoApprove['myco']).toBeUndefined();
    // The user's other key is untouched.
    expect(autoApprove['other-tool']).toBe(true);
  });

  it('removes coreTools entries from Gemini settings', () => {
    fs.mkdirSync(path.join(projectRoot, '.gemini'), { recursive: true });
    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    installer.uninstallSettings();

    // File removed when empty
    expect(fs.existsSync(path.join(projectRoot, '.gemini/settings.json'))).toBe(false);
  });

  it('preserves non-Myco coreTools entries on uninstall', () => {
    const geminiDir = path.join(projectRoot, '.gemini');
    fs.mkdirSync(geminiDir, { recursive: true });
    writeJson(path.join(geminiDir, 'settings.json'), {
      coreTools: ['ShellTool(other-tool *)', 'ShellTool(myco *)', 'ShellTool(myco-dev *)'],
    });

    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(geminiDir, 'settings.json'));
    const coreTools = settings.coreTools as string[];
    expect(coreTools).toContain('ShellTool(other-tool *)');
    expect(coreTools).not.toContain('ShellTool(myco *)');
    expect(coreTools).not.toContain('ShellTool(myco-dev *)');
  });

  it('preserves non-Myco permissions on uninstall', () => {
    const settingsDir = path.join(projectRoot, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      permissions: { allow: ['Bash(git *)', 'Bash(myco *)', 'Bash(myco-dev *)'] },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const allow = (settings.permissions as { allow: string[] }).allow;
    expect(allow).toContain('Bash(git *)');
    expect(allow).not.toContain('Bash(myco *)');
    expect(allow).not.toContain('Bash(myco-dev *)');
  });

  it('full uninstall removes everything install added', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    // Verify everything was installed
    expect(fs.existsSync(path.join(projectRoot, '.claude/settings.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.mcp.json'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);

    const result = installer.uninstall();
    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.instructions).toBe(true);

    // .mcp.json should be gone (was only myco)
    expect(fs.existsSync(path.join(projectRoot, '.mcp.json'))).toBe(false);
    // Skills gone
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(false);
    // Settings file cleaned up (hooks + settings both removed = empty = deleted)
    expect(fs.existsSync(path.join(projectRoot, '.claude/settings.json'))).toBe(false);
  });
});

// =====================
// Windsurf flat hook format
// =====================

describe('Windsurf flat hook format', () => {
  it('installs hooks in flat format', () => {
    fs.mkdirSync(path.join(projectRoot, '.windsurf'), { recursive: true });
    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const hooks = readJson(path.join(projectRoot, '.windsurf/hooks.json'));
    const groups = (hooks.hooks as Record<string, unknown[]>).pre_user_prompt as Array<Record<string, unknown>>;
    expect(groups[0].command).toBe(`${PINNED_BINARY} hook user-prompt-submit --symbiont windsurf ${MYCO_MANAGED_MARKER}`);
    // Should NOT have nested hooks array
    expect(groups[0].hooks).toBeUndefined();
  });

  it('preserves non-Myco flat hooks', () => {
    const hooksDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      hooks: {
        pre_user_prompt: [{ command: 'other-tool check' }],
      },
    }));

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const hooks = readJson(path.join(hooksDir, 'hooks.json'));
    const commands = ((hooks.hooks as Record<string, unknown[]>).pre_user_prompt as Array<Record<string, unknown>>)
      .map((g) => g.command);
    expect(commands).toContain('other-tool check');
    expect(commands).toContain(`${PINNED_BINARY} hook user-prompt-submit --symbiont windsurf ${MYCO_MANAGED_MARKER}`);
  });

  it('replaces stale Myco flat hooks', () => {
    const hooksDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      hooks: {
        pre_user_prompt: [{ command: 'myco-run hook old-event' }],
      },
    }));

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const hooks = readJson(path.join(hooksDir, 'hooks.json'));
    const commands = ((hooks.hooks as Record<string, unknown[]>).pre_user_prompt as Array<Record<string, unknown>>)
      .map((g) => g.command);
    expect(commands).not.toContain('myco-run hook old-event');
    expect(commands).toContain(`${PINNED_BINARY} hook user-prompt-submit --symbiont windsurf ${MYCO_MANAGED_MARKER}`);
  });

  it('uninstalls flat Myco hooks', () => {
    fs.mkdirSync(path.join(projectRoot, '.windsurf'), { recursive: true });
    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const result = installer.uninstallHooks();
    expect(result).toBe(true);

    // File deleted when empty
    expect(fs.existsSync(path.join(projectRoot, '.windsurf/hooks.json'))).toBe(false);
  });

  it('preserves non-Myco flat hooks on uninstall', () => {
    const hooksDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(hooksDir, { recursive: true });
    fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify({
      hooks: {
        pre_user_prompt: [
          { command: 'other-tool check' },
          { command: 'myco-run hook user-prompt-submit' },
        ],
      },
    }));

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.uninstallHooks();

    const hooks = readJson(path.join(hooksDir, 'hooks.json'));
    const commands = ((hooks.hooks as Record<string, unknown[]>).pre_user_prompt as Array<Record<string, unknown>>)
      .map((g) => g.command);
    expect(commands).toContain('other-tool check');
    expect(commands).not.toContain('myco-run hook user-prompt-submit');
  });
});

// =====================
// Windsurf install (integration)
// =====================

describe('Windsurf install', () => {
  it('runs all steps for Windsurf (no MCP)', () => {
    fs.mkdirSync(path.join(projectRoot, '.windsurf'), { recursive: true });
    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(false); // No MCP for Windsurf
    expect(result.skills).toBe(true);
    expect(result.settings).toBe(true);
    expect(result.instructions).toBe(false); // Windsurf reads AGENTS.md natively

    // Settings has cascadeCommandsAllowList
    const settings = readJson(path.join(projectRoot, '.windsurf/settings.json'));
    expect((settings as Record<string, unknown>)['windsurf.cascadeCommandsAllowList']).toContain('myco-dev');
  });

  it('removes cascadeCommandsAllowList entries on uninstall', () => {
    fs.mkdirSync(path.join(projectRoot, '.windsurf'), { recursive: true });
    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.install();

    installer.uninstallSettings();

    // File removed when empty
    expect(fs.existsSync(path.join(projectRoot, '.windsurf/settings.json'))).toBe(false);
  });

  it('preserves non-Myco cascadeCommandsAllowList entries on uninstall', () => {
    const settingsDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      'windsurf.cascadeCommandsAllowList': ['other-cmd', 'myco', 'myco-dev'],
    });

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const allowList = (settings as Record<string, unknown>)['windsurf.cascadeCommandsAllowList'] as string[];
    expect(allowList).toContain('other-cmd');
    expect(allowList).not.toContain('myco');
    expect(allowList).not.toContain('myco-dev');
  });

  it('audit-track: install + uninstall preserves a value-collision allowlist entry (Windsurf)', () => {
    // User had `myco-dev` in their allowlist BEFORE installing Myco
    // (some other tool happens to use the same name, or they typed it
    // themselves). Install is a no-op for that array entry — audit
    // does NOT claim ownership. Uninstall preserves it.
    const settingsDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      'windsurf.cascadeCommandsAllowList': ['user-cmd', 'myco-dev'],
    });

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const allowList = (settings as Record<string, unknown>)['windsurf.cascadeCommandsAllowList'] as string[];
    // User's pre-existing entry survives.
    expect(allowList).toContain('myco-dev');
    // User's other entry is untouched.
    expect(allowList).toContain('user-cmd');
    // Myco's own additions (just `myco`) are gone.
    expect(allowList).not.toContain('myco');
  });
});

// =====================
// installInstructions
// =====================

describe('installInstructions', () => {
  it('creates instruction stub for Claude Code', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installInstructions();
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('Claude Code');
  });

  it('prepends reference block to existing instruction file', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# My custom rules\n\nDo not use var.\n');
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installInstructions();
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    // Reference block prepended
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('myco:agents-ref:start');
    // Original content preserved
    expect(content).toContain('# My custom rules');
    expect(content).toContain('Do not use var.');
  });

  it('is idempotent — does not duplicate reference on existing file', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# My rules\n');
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installInstructions();
    const result = installer.installInstructions(); // Second run
    expect(result).toBe(false);
    const content = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    const matches = content.match(/myco:agents-ref:start/g);
    expect(matches?.length).toBe(1);
  });

  it('creates .github/ directory for Copilot instructions', () => {
    const installer = new SymbiontInstaller(COPILOT_MANIFEST, projectRoot, packageRoot);
    installer.installInstructions();
    expect(fs.existsSync(path.join(projectRoot, '.github/copilot-instructions.md'))).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.github/copilot-instructions.md'), 'utf-8');
    expect(content).toContain('GitHub Copilot');
  });

  it('creates instruction stub for Gemini CLI', () => {
    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    const result = installer.installInstructions();
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf-8');
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('Gemini CLI');
  });

  it('installs bundled AGENTS and instructions templates without package template files on disk', () => {
    fs.rmSync(packageRoot, { recursive: true, force: true });
    fs.mkdirSync(packageRoot, { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installInstructions();
    expect(result).toBe(true);

    const agents = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(agents).toContain('Project Rules');
    expect(agents).toContain('/myco-rules');

    const instructions = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(instructions).toContain('Claude Code');
    expect(instructions).toContain('AGENTS.md');
  });

  it('returns false when no instructionsFile in manifest', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    expect(installer.installInstructions()).toBe(false);
  });

  it('loads template from dist layout as fallback', () => {
    // Remove source layout template
    const srcPath = path.join(packageRoot, 'src/symbionts/templates/instructions-stub.md');
    fs.unlinkSync(srcPath);

    // Create dist layout template
    const distDir = path.join(packageRoot, 'dist/src/symbionts/templates');
    fs.mkdirSync(distDir, { recursive: true });
    fs.writeFileSync(
      path.join(distDir, 'instructions-stub.md'),
      '# Project Instructions\n\n<!-- This file exists so {agentDisplayName} discovers project instructions. -->\n<!-- Edit AGENTS.md, not this file, when adding or changing project rules. -->\n',
    );

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installInstructions();
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('Claude Code');
  });
});

describe('AGENTS.md managed guidance', () => {
  it('adds the Myco-managed guidance block to an existing AGENTS.md', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(projectRoot, 'AGENTS.md'), '# Project Rules\n\nKeep tests current.\n');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const content = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    expect(content).toContain('myco:managed:start');
    expect(content).toContain('capture.ignore_plan_dirs_in_git');
    expect(content).toContain('myco tool call myco_cortex --json --input');
    expect(content).toContain('"op":"canopy_map"');
    expect(content).toContain('`myco_cortex({"op":"canopy_map"})` via MCP');
    expect(content).toContain('Keep tests current.');
  });

  it('reconciles the managed guidance block without duplicating it', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    installer.install();

    const content = fs.readFileSync(path.join(projectRoot, 'AGENTS.md'), 'utf-8');
    const matches = content.match(/myco:managed:start/g);
    expect(matches?.length).toBe(1);
  });
});

// =====================
// uninstallInstructions
// =====================

describe('uninstallInstructions', () => {
  it('removes unmodified stub', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installInstructions();
    expect(fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))).toBe(true);

    expect(installer.uninstallInstructions()).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))).toBe(false);
  });

  it('removes prepended reference block, preserves user content', () => {
    // Simulate: user had custom rules, then the installer prepended the reference
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# My custom rules\n');
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installInstructions(); // Prepends reference

    expect(installer.uninstallInstructions()).toBe(true);
    const after = fs.readFileSync(path.join(projectRoot, 'CLAUDE.md'), 'utf-8');
    // Reference block removed
    expect(after).not.toContain('myco:agents-ref:start');
    // User content preserved
    expect(after).toContain('# My custom rules');
  });

  it('preserves file with no Myco content', () => {
    fs.writeFileSync(path.join(projectRoot, 'CLAUDE.md'), '# Pure user rules\n');
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    expect(installer.uninstallInstructions()).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, 'CLAUDE.md'))).toBe(true);
  });

  it('returns false when no instructionsFile in manifest', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    expect(installer.uninstallInstructions()).toBe(false);
  });

  it('returns false when file does not exist', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    expect(installer.uninstallInstructions()).toBe(false);
  });
});

// =====================
// installHookGuard
// =====================

describe('installHookGuard', () => {
  it('writes capture and project CLI launchers', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installHookGuard();

    expect(result).toBe(true);
    const guardPath = path.join(projectRoot, '.agents/myco-run.cjs');
    const cliPath = path.join(projectRoot, '.agents/myco-cli.cjs');
    expect(fs.existsSync(guardPath)).toBe(true);
    expect(fs.existsSync(cliPath)).toBe(true);
    const content = fs.readFileSync(guardPath, 'utf-8');
    expect(content).toContain('hook guard');
  });

  it('is idempotent — second install does not rewrite if content identical', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHookGuard();

    const guardPath = path.join(projectRoot, '.agents/myco-run.cjs');
    const stat1 = fs.statSync(guardPath);

    // Second install should return false (no change)
    const result = installer.installHookGuard();
    expect(result).toBe(false);

    // File should still exist with same content
    expect(fs.existsSync(guardPath)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(true);
  });

  it('skips guard for symbionts without hooksTarget', () => {
    const installer = new SymbiontInstaller(NO_HOOKS_MANIFEST, projectRoot, packageRoot);
    const result = installer.installHookGuard();

    expect(result).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(false);
  });

  it('install() writes hook guard before hooks', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    // Hook guard should exist
    const guardPath = path.join(projectRoot, '.agents/myco-run.cjs');
    expect(fs.existsSync(guardPath)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(true);
  });
});

// =====================
// uninstallHookGuard
// =====================

describe('uninstallHookGuard', () => {
  it('removes runtime launchers', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHookGuard();
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-run.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(true);

    const result = installer.uninstallHookGuard();
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-run.cjs'))).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(false);
  });

  it('does not fail if guard does not exist', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.uninstallHookGuard();
    expect(result).toBe(false);
  });

  // Contract: per-symbiont uninstall must NOT remove the shared
  // project-level launchers — uninstalling symbiont A must not break
  // symbiont B. Project-level teardown lives in `removeProjectLaunchers`,
  // called explicitly by `myco remove` and the migration walker (gated
  // by the opt-in check) after the per-symbiont loop completes.
  it('uninstall() preserves the shared project launchers', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-run.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(true);

    installer.uninstall();
    // Launchers must still be on disk — another symbiont may need them.
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-run.cjs'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(true);
  });
});

// =====================
// Old-format hook backward compatibility
// =====================

describe('old-format hook backward compatibility', () => {
  it('replaces old myco-run format hooks with new guard format', () => {
    // Pre-populate settings with old-format Myco hooks
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [
          {
            hooks: [
              { type: 'command', command: 'myco-run hook session-start', timeout: 10 },
            ],
          },
        ],
      },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(settingsPath);
    const hooks = settings.hooks as Record<string, unknown[]>;
    // Old hooks replaced, not stacked
    expect(hooks.SessionStart).toHaveLength(1);
    const command = ((hooks.SessionStart[0] as { hooks: Array<{ command: string }> }).hooks[0]).command;
    expect(command).toBe(`${PINNED_BINARY} hook session-start --symbiont claude-code ${MYCO_MANAGED_MARKER}`);
  });

  it('replaces old-format flat hooks in Windsurf', () => {
    const hooksDir = path.join(projectRoot, '.windsurf');
    fs.mkdirSync(hooksDir, { recursive: true });
    writeJson(path.join(hooksDir, 'hooks.json'), {
      hooks: {
        pre_user_prompt: [{ command: 'myco-run hook user-prompt-submit' }],
      },
    });

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const hooks = readJson(path.join(hooksDir, 'hooks.json'));
    const commands = ((hooks.hooks as Record<string, unknown[]>).pre_user_prompt as Array<Record<string, unknown>>)
      .map((g) => g.command);
    // Old format removed, new format added
    expect(commands).not.toContain('myco-run hook user-prompt-submit');
    expect(commands).toContain(`${PINNED_BINARY} hook user-prompt-submit --symbiont windsurf ${MYCO_MANAGED_MARKER}`);
    // No duplication
    expect(commands).toHaveLength(1);
  });
});

// =====================
// Hook template validation
// =====================

describe('hook template validation', () => {
  it('all hook templates use the launcher placeholder', () => {
    // Templates use `{{mycoLauncher}}`, which the installer substitutes at
    // install time with the direct binary path (plus the `--myco-managed`
    // marker). The legacy hard-coded `.agents/myco-run.cjs` form is the bug
    // that caused global-install hook files to depend on a project-local file
    // existing — the placeholder is what enforces the scope-correctness
    // invariant.
    const templateDirs = ['claude-code', 'codex', 'cursor', 'copilot', 'windsurf'];
    const launcherForm = /\{\{mycoLauncher\}\} /;
    for (const dir of templateDirs) {
      const filePath = path.resolve(`packages/myco/src/symbionts/templates/${dir}/hooks.json`);
      const template = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const [event, groups] of Object.entries(template)) {
        for (const group of groups as Array<Record<string, unknown>>) {
          // Nested format
          if (Array.isArray(group.hooks)) {
            for (const hook of group.hooks as Array<{ command?: string }>) {
              if (hook.command) {
                expect(hook.command).toMatch(launcherForm);
                expect(hook.command).not.toMatch(/\.agents\/myco-run\.cjs/);
              }
            }
          }
          // Flat format
          if (typeof group.command === 'string') {
            expect(group.command).toMatch(launcherForm);
            expect(group.command).not.toMatch(/\.agents\/myco-run\.cjs/);
          }
        }
      }
    }
  });
});

// =====================
// opencode — plugin-file hooks + non-standard MCP key
// =====================

describe('opencode (plugin-file hooks)', () => {
  it('install writes the plugin file verbatim with marker', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.hooks).toBe(true);
    const pluginPath = path.join(projectRoot, '.opencode/plugins/myco.ts');
    const written = fs.readFileSync(pluginPath, 'utf-8');
    expect(written).toBe(OPENCODE_PLUGIN_TEMPLATE_CONTENT);
    expect(written).toContain('myco:plugin-marker:opencode');
  });

  it('installPluginHookFile is content-diff gated (idempotent)', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    // Second install: hooks should be skipped because the file is already current.
    // We can only observe this via the returned boolean (false = no-op).
    const second = installer.install();
    expect(second.hooks).toBe(false);
  });

  it('install writes plugin deps package.json', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    const result = installer.install();

    expect(result.pluginPackage).toBe(true);
    const pkgPath = path.join(projectRoot, '.opencode/package.json');
    const written = fs.readFileSync(pkgPath, 'utf-8');
    expect(written).toBe(OPENCODE_PACKAGE_TEMPLATE_CONTENT);
    expect(JSON.parse(written)).toHaveProperty('dependencies.@opencode-ai/plugin');
  });

  it('installPluginPackage is content-diff gated', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    const second = installer.install();
    expect(second.pluginPackage).toBe(false);
  });

  it('uninstall deletes plugin file when marker present', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    const pluginPath = path.join(projectRoot, '.opencode/plugins/myco.ts');
    expect(fs.existsSync(pluginPath)).toBe(true);

    const result = installer.uninstall();
    expect(result.hooks).toBe(true);
    expect(fs.existsSync(pluginPath)).toBe(false);
  });

  it('uninstall preserves hand-edited plugin file without marker', () => {
    const pluginDir = path.join(projectRoot, '.opencode/plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    const pluginPath = path.join(pluginDir, 'myco.ts');
    const handEdited = '// I am not a Myco-managed file\nexport default async () => ({});\n';
    fs.writeFileSync(pluginPath, handEdited, 'utf-8');

    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    const result = installer.uninstall();
    expect(result.hooks).toBe(false);
    expect(fs.readFileSync(pluginPath, 'utf-8')).toBe(handEdited);
  });

  it('uninstall preserves plugin deps package.json for contributor-added deps', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    const pkgPath = path.join(projectRoot, '.opencode/package.json');
    expect(fs.existsSync(pkgPath)).toBe(true);

    installer.uninstall();
    // Plan: package.json is intentionally left in place — contributors may add their own deps.
    expect(fs.existsSync(pkgPath)).toBe(true);
  });

  it('MCP entries are written under the custom mcpServersKey', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const openCodeJson = readJson(path.join(projectRoot, 'opencode.json'));
    // opencode uses 'mcp' not 'mcpServers'
    expect(openCodeJson).toHaveProperty('mcp');
    expect(openCodeJson).not.toHaveProperty('mcpServers');
    const mcp = openCodeJson.mcp as Record<string, unknown>;
    expect(mcp).toHaveProperty('myco');
  });

  it('array-form MCP command entries round-trip verbatim', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const openCodeJson = readJson(path.join(projectRoot, 'opencode.json'));
    const myco = (openCodeJson.mcp as Record<string, unknown>).myco as Record<string, unknown>;
    // opencode's MCP entry shape: { type: "local", command: ["<binary>", "mcp"] }
    // — element 0 is the resolved binary path (the machine runtime pin).
    expect(myco.type).toBe('local');
    expect(myco.command).toEqual([PINNED_BINARY, 'mcp']);
  });

  it('uninstall removes only the myco MCP entry and leaves other servers intact', () => {
    // Seed opencode.json with an unrelated MCP server
    const openCodeJsonPath = path.join(projectRoot, 'opencode.json');
    writeJson(openCodeJsonPath, {
      mcp: {
        otherSdk: { type: 'local', command: ['other', 'mcp'] },
      },
    });

    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    installer.uninstall();

    const after = readJson(openCodeJsonPath);
    const mcp = after.mcp as Record<string, unknown> | undefined;
    expect(mcp).toBeDefined();
    expect(mcp).toHaveProperty('otherSdk');
    expect(mcp).not.toHaveProperty('myco');
  });

  it('permission settings are merged under opencode.json permission key', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const openCodeJson = readJson(path.join(projectRoot, 'opencode.json'));
    const permission = openCodeJson.permission as Record<string, Record<string, string>>;
    expect(permission.bash['myco *']).toBe('allow');
    expect(permission.bash['myco-dev *']).toBe('allow');
  });

  it('opencode does not trigger batched JSON install (hooks target is .ts)', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    // If the batched path incorrectly tried to JSON.parse the plugin .ts file,
    // the install would throw. Success means the non-batched path ran.
    expect(() => installer.install()).not.toThrow();

    // Plugin file is the verbatim TS, NOT JSON
    const plugin = fs.readFileSync(path.join(projectRoot, '.opencode/plugins/myco.ts'), 'utf-8');
    expect(() => JSON.parse(plugin)).toThrow();
  });

  it('hook guard is installed for opencode', () => {
    const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const guardPath = path.join(projectRoot, '.agents/myco-run.cjs');
    expect(fs.existsSync(guardPath)).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-cli.cjs'))).toBe(true);
  });

  describe('shared-helpers snippet injection', () => {
    // When a plugin template carries the `<myco:shared-helpers>` markers,
    // the installer replaces the block between them with the canonical
    // snippet from `_shared/plugin-helpers.ts.snippet` at install time.
    // Real opencode and pi plugins rely on this to keep BATCH_KIND,
    // bufferEvent, isIgnoredResponse, and postEventWithBuffer in one place
    // rather than duplicated inline in each plugin file.

    function writeSharedSnippet(body: string): void {
      const sharedDir = path.join(packageRoot, 'src/symbionts/templates/_shared');
      fs.mkdirSync(sharedDir, { recursive: true });
      fs.writeFileSync(
        path.join(sharedDir, 'plugin-helpers.ts.snippet'),
        body,
        'utf-8',
      );
    }

    function writePluginWithMarkers(inner: string): void {
      const body = [
        '// myco:plugin-marker:opencode',
        'export const MycoPlugin = async () => ({});',
        '// <myco:shared-helpers>',
        inner,
        '// </myco:shared-helpers>',
        'export default MycoPlugin;',
        '',
      ].join('\n');
      fs.writeFileSync(
        path.join(packageRoot, 'src/symbionts/templates/opencode/plugin.ts'),
        body,
        'utf-8',
      );
    }

    it('replaces the marker block with the canonical snippet content', () => {
      writeSharedSnippet('const BATCH_KIND = { STEERING: "steering" } as const;\n');
      writePluginWithMarkers('// stale inlined copy — to be overwritten');

      const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
      installer.install();

      const installed = fs.readFileSync(
        path.join(projectRoot, '.opencode/plugins/myco.ts'),
        'utf-8',
      );
      expect(installed).toContain('const BATCH_KIND = { STEERING: "steering" } as const;');
      expect(installed).not.toContain('stale inlined copy');
      // Markers themselves are preserved so contributors can still navigate
      // the installed file back to the snippet.
      expect(installed).toContain('// <myco:shared-helpers>');
      expect(installed).toContain('// </myco:shared-helpers>');
    });

    it('is a no-op when the template has no shared-helpers markers', () => {
      // Default OPENCODE_PLUGIN_TEMPLATE_CONTENT has no markers — the
      // installer must copy it verbatim. Proves the injection path is
      // opt-in and doesn't damage non-participating templates.
      writeSharedSnippet('SHOULD NOT LEAK INTO THE FILE');

      const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot);
      installer.install();

      const installed = fs.readFileSync(
        path.join(projectRoot, '.opencode/plugins/myco.ts'),
        'utf-8',
      );
      expect(installed).toBe(OPENCODE_PLUGIN_TEMPLATE_CONTENT);
      expect(installed).not.toContain('SHOULD NOT LEAK');
    });

    it('falls back to the inlined marker block when the snippet file is absent', () => {
      // Contributors who clone without running a full build have no
      // _shared/plugin-helpers.ts.snippet on disk — the plugin still
      // installs cleanly because the on-disk template already contains a
      // valid inline copy between its markers.
      writePluginWithMarkers('const INLINED = "still valid";');
      // Deliberately no writeSharedSnippet()

      // Suppress the BUNDLED_TEMPLATES fallback so this test can observe
      // the "snippet absent on disk" path. In a real compiled binary the
      // snippet is always baked in and this fallback is unreachable.
      const installer = new SymbiontInstaller(OPENCODE_MANIFEST, projectRoot, packageRoot, true);
      installer.install();

      const installed = fs.readFileSync(
        path.join(projectRoot, '.opencode/plugins/myco.ts'),
        'utf-8',
      );
      expect(installed).toContain('const INLINED = "still valid";');
    });
  });
});

// ---------------------------------------------------------------------------
// RC-14 — symlink stewardship: never destroy user content; symmetric uninstall
// ---------------------------------------------------------------------------

describe('RC-14 — ensureSymlink never destroys real paths', () => {
  it('a REAL directory at the canonical link path survives install (other skills still link)', () => {
    const canonicalDir = path.join(projectRoot, '.agents/skills');
    fs.mkdirSync(path.join(canonicalDir, 'myco'), { recursive: true });
    fs.writeFileSync(path.join(canonicalDir, 'myco', 'SKILL.md'), 'hand-authored content\n');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installSkills();
    expect(result).toBe(true);

    // The user's real directory is untouched.
    const kept = path.join(canonicalDir, 'myco');
    expect(fs.lstatSync(kept).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(kept, 'SKILL.md'), 'utf-8')).toBe('hand-authored content\n');
  });

  it('a REAL file at the agent link path survives install', () => {
    const agentSkillsDir = path.join(projectRoot, '.claude/skills');
    fs.mkdirSync(agentSkillsDir, { recursive: true });
    fs.writeFileSync(path.join(agentSkillsDir, 'myco'), 'not a symlink\n');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    expect(fs.lstatSync(path.join(agentSkillsDir, 'myco')).isSymbolicLink()).toBe(false);
    expect(fs.readFileSync(path.join(agentSkillsDir, 'myco'), 'utf-8')).toBe('not a symlink\n');
    // The canonical layer still linked normally.
    expect(fs.lstatSync(path.join(projectRoot, '.agents/skills/myco')).isSymbolicLink()).toBe(true);
  });
});

describe('RC-14 — global-scope (flatSkills) uninstall symmetry', () => {
  it('uninstallSkills removes flat global skill symlinks installed under globalSkillsTarget', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-home-rc14-'));
    const origHome = process.env.HOME;
    const origSandbox = process.env.MYCO_SANDBOX_ROOT;
    process.env.HOME = home;
    process.env.MYCO_SANDBOX_ROOT = home;
    try {
      const globalClaude = {
        ...CLAUDE_MANIFEST,
        registration: {
          ...CLAUDE_MANIFEST.registration,
          globalSkillsTarget: '~/.claude/skills',
        },
      };
      const installer = new SymbiontInstaller(globalClaude, '/', packageRoot, false, undefined, null, 'global');
      expect(installer.installSkills()).toBe(true);

      const link = path.join(home, '.claude/skills/myco');
      expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);

      // A real user skill beside ours must survive the uninstall.
      const userSkill = path.join(home, '.claude/skills/my-own-skill');
      fs.mkdirSync(userSkill, { recursive: true });

      expect(installer.uninstallSkills()).toBe(true);
      expect(fs.existsSync(link)).toBe(false);
      expect(fs.existsSync(userSkill)).toBe(true);
    } finally {
      if (origHome === undefined) delete process.env.HOME; else process.env.HOME = origHome;
      if (origSandbox === undefined) delete process.env.MYCO_SANDBOX_ROOT; else process.env.MYCO_SANDBOX_ROOT = origSandbox;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('uninstallSkills leaves a REAL directory named like a skill untouched (project scope)', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    // Replace the agent link with a real dir (user vendored a copy).
    const agentLink = path.join(projectRoot, '.claude/skills/myco');
    fs.unlinkSync(agentLink);
    fs.mkdirSync(agentLink);
    fs.writeFileSync(path.join(agentLink, 'SKILL.md'), 'vendored\n');

    installer.uninstallSkills();
    expect(fs.existsSync(path.join(agentLink, 'SKILL.md'))).toBe(true);
    // The canonical symlink (ours) is gone.
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Windows backslash-path collapse — the 6× duplicate-stack regression
// ---------------------------------------------------------------------------

describe('Windows backslash hook entries collapse on merge (both merge sites)', () => {
  // The wild Windows config carried six Myco hook groups whose commands used a
  // BACKSLASH canonical path. The pre-fix substring scan (forward-slash only)
  // never matched them, so they went unclaimed and re-accumulated on each
  // merge. With separator normalization in `containsMycoLauncherReference`,
  // both merge sites recognize and strip the six, replacing them with one
  // clean template group, while a genuine user hook is preserved.

  /** Six Myco hook groups in the wild Windows backslash form. */
  function sixBackslashMycoGroups(event: string): Array<Record<string, unknown>> {
    return Array.from({ length: 6 }, () => ({
      hooks: [{
        type: 'command',
        command: `node C:\\Users\\chris\\.myco\\launcher.cjs hook ${event} --symbiont claude-code`,
        timeout: 30,
      }],
    }));
  }

  it('unbatched merge site (installHooks): collapses 6 backslash duplicates to 1, preserves the user hook', () => {
    // CLAUDE_MANIFEST has separate hooks/mcp/settings targets, so install()
    // routes through installHooks() — the unbatched merge site (~1354).
    const userGroup = { hooks: [{ type: 'command', command: 'my-other-tool start', timeout: 5 }] };
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, {
      hooks: {
        SessionStart: [...sixBackslashMycoGroups('session-start'), userGroup],
      },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const settings = readJson(settingsPath);
    const groups = (settings.hooks as Record<string, Array<{ hooks?: Array<{ command: string }> }>>).SessionStart;
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    // Exactly one Myco-owned group remains (the six backslash duplicates collapsed).
    const mycoCount = commands.filter((c) => c.includes('myco-run.cjs') || c.includes('.myco/launcher.cjs') || c.includes('--myco-managed')).length;
    expect(mycoCount).toBe(1);
    // The user's genuine hook is preserved.
    expect(commands).toContain('my-other-tool start');
    // No backslash canonical entry survived.
    expect(commands.some((c) => c.includes('C:\\Users\\chris\\.myco\\launcher.cjs'))).toBe(false);
  });

  it('batched merge site (installBatchedJson): collapses 6 backslash duplicates to 1, preserves the user hook', () => {
    // CLI_BATCHED_MANIFEST colocates hooks/mcp/settings into one JSON file, so
    // install() routes through installBatchedJson() — the batched merge site
    // (~878). Plant the templates that path reads.
    const dir = path.join(packageRoot, 'src/symbionts/templates/cli-batched');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'hooks.json'), {
      Stop: [{ hooks: [{ type: 'command', command: '{{mycoLauncher}} hook stop --symbiont cli-batched', timeout: 30 }] }],
    });
    writeJson(path.join(dir, 'mcp.json'), MCP_TEMPLATE);
    writeJson(path.join(dir, 'settings.json'), { features: { capture: true } });

    const userGroup = { hooks: [{ type: 'command', command: 'my-other-tool stop', timeout: 5 }] };
    const sharedFile = path.join(projectRoot, '.clibatched/config.json');
    writeJson(sharedFile, {
      hooks: {
        Stop: [...sixBackslashMycoGroups('stop'), userGroup],
      },
    });

    const installer = new SymbiontInstaller(CLI_BATCHED_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const config = readJson(sharedFile);
    const groups = (config.hooks as Record<string, Array<{ hooks?: Array<{ command: string }> }>>).Stop;
    const commands = groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command));
    // Exactly one Myco-owned group remains.
    const mycoCount = commands.filter((c) => c.includes('myco-run.cjs') || c.includes('.myco/launcher.cjs') || c.includes('--myco-managed')).length;
    expect(mycoCount).toBe(1);
    // The user's genuine hook is preserved.
    expect(commands).toContain('my-other-tool stop');
    // No backslash canonical entry survived.
    expect(commands.some((c) => c.includes('C:\\Users\\chris\\.myco\\launcher.cjs'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Direct-binary hook commands (Launcher Unification Phase 2a)
//
// Hook commands invoke the self-contained binary directly — no `node`, no
// `.cjs` trampoline — and carry the `--myco-managed` ownership marker. The
// binary path resolves from the machine `runtime.command` pin (deterministic
// here) falling back to `process.execPath` in production. The claude-code
// template drops its `cd "${CLAUDE_PROJECT_DIR:-.}" &&` prefix; the binary's
// launch preamble anchors cwd in-process.
// ---------------------------------------------------------------------------

describe('direct-binary hook commands', () => {
  // PINNED_BINARY, pinRuntimeBinary, and assertDirectBinaryCommands are
  // module-scope shared helpers (also used by the installHooks suite).

  /**
   * Per-symbiont hooks template using the `{{mycoLauncher}}` placeholder,
   * mirroring the real (post-Phase-2a) template shapes: bare
   * `{{mycoLauncher}} hook <event> --symbiont <agent>` with no `cd` prefix.
   * The `cd`-prefix removal is verified directly against the bundled template
   * and the generated bundle elsewhere in this suite.
   */
  function writeLauncherHooksTemplate(agent: string): void {
    const dir = path.join(packageRoot, `src/symbionts/templates/${agent}`);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'hooks.json'), {
      SessionStart: [
        { hooks: [{ type: 'command', command: `{{mycoLauncher}} hook session-start --symbiont ${agent}`, timeout: 10 }] },
      ],
      Stop: [
        { hooks: [{ type: 'command', command: `{{mycoLauncher}} hook stop --symbiont ${agent}`, timeout: 30 }] },
      ],
    });
  }

  /** Collect every hook command string written to a nested-format target. */
  function readHookCommands(targetPath: string): string[] {
    const settings = readJson(targetPath);
    const hooks = settings.hooks as Record<string, Array<{ hooks?: Array<{ command: string }> }>>;
    return Object.values(hooks).flatMap((groups) => groups.flatMap((g) => (g.hooks ?? []).map((h) => h.command)));
  }

  // Each symbiont with a nested-format JSON hooks template. cursor and
  // windsurf use flat-format / placeholder-prefixed templates exercised in
  // dedicated suites above; here we cover the nested shape uniformly.
  const NESTED_HOOK_SYMBIONTS: Array<{ name: string; manifest: SymbiontManifest; hooksTarget: string }> = [
    { name: 'claude-code', manifest: CLAUDE_MANIFEST, hooksTarget: '.claude/settings.json' },
    { name: 'codex', manifest: CODEX_MANIFEST, hooksTarget: '.codex/hooks.json' },
    { name: 'copilot', manifest: COPILOT_MANIFEST, hooksTarget: '.github/hooks/myco-hooks.json' },
  ];

  for (const { name, manifest, hooksTarget } of NESTED_HOOK_SYMBIONTS) {
    it(`${name}: emits a direct-binary command with the ownership marker and no node/.cjs`, () => {
      pinRuntimeBinary(PINNED_BINARY);
      writeLauncherHooksTemplate(name);

      const installer = new SymbiontInstaller(manifest, projectRoot, packageRoot);
      expect(installer.installHooks()).toBe(true);

      const commands = readHookCommands(path.join(projectRoot, hooksTarget));
      expect(commands.length).toBeGreaterThan(0);
      assertDirectBinaryCommands(commands, name);
    });
  }

  // cursor and windsurf use the FLAT hook shape (`{ command }`, no nested
  // `hooks` array). Their real templates carry the bare placeholder too, so
  // the same direct-binary assertions hold once the flat commands are read.
  const FLAT_HOOK_SYMBIONTS: Array<{ name: string; manifest: SymbiontManifest; hooksTarget: string }> = [
    { name: 'cursor', manifest: CURSOR_MANIFEST, hooksTarget: '.cursor/hooks.json' },
    { name: 'windsurf', manifest: WINDSURF_MANIFEST, hooksTarget: '.windsurf/hooks.json' },
  ];

  /** Write a flat-format hooks template using the launcher placeholder. */
  function writeFlatLauncherHooksTemplate(agent: string): void {
    const dir = path.join(packageRoot, `src/symbionts/templates/${agent}`);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'hooks.json'), {
      sessionStart: [{ command: `{{mycoLauncher}} hook session-start --symbiont ${agent}`, type: 'command', timeout: 10 }],
      stop: [{ command: `{{mycoLauncher}} hook stop --symbiont ${agent}`, type: 'command', timeout: 30 }],
    });
  }

  function readFlatHookCommands(targetPath: string): string[] {
    const settings = readJson(targetPath);
    const hooks = settings.hooks as Record<string, Array<{ command: string }>>;
    return Object.values(hooks).flatMap((groups) => groups.map((g) => g.command));
  }

  for (const { name, manifest, hooksTarget } of FLAT_HOOK_SYMBIONTS) {
    it(`${name}: emits a direct-binary command with the ownership marker and no node/.cjs (flat)`, () => {
      pinRuntimeBinary(PINNED_BINARY);
      writeFlatLauncherHooksTemplate(name);

      const installer = new SymbiontInstaller(manifest, projectRoot, packageRoot);
      expect(installer.installHooks()).toBe(true);

      const commands = readFlatHookCommands(path.join(projectRoot, hooksTarget));
      expect(commands.length).toBeGreaterThan(0);
      assertDirectBinaryCommands(commands, name);
    });
  }

  it('antigravity: plugin-file JSON template emits direct-binary commands with the marker', () => {
    pinRuntimeBinary(PINNED_BINARY);
    const antigravity: SymbiontManifest = {
      name: 'antigravity',
      displayName: 'Antigravity',
      binary: 'antigravity',
      configDir: '.antigravity',
      pluginRootEnvVar: 'ANTIGRAVITY_PLUGIN_ROOT',
      hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
      registration: {
        hooksTarget: '.agents/plugins/myco/hooks.json',
        hooksFormat: 'plugin-file',
        hooksTemplateFile: 'hooks.json',
        skillsTarget: '.agents/skills',
      },
    };
    // Antigravity's real template nests events under a `myco` wrapper key and
    // mixes flat (`{ command }`) and nested (`{ hooks: [{ command }] }`) shapes.
    const dir = path.join(packageRoot, 'src/symbionts/templates/antigravity');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, 'hooks.json'), {
      myco: {
        PreInvocation: [{ type: 'command', command: '{{mycoLauncher}} hook session-start --symbiont antigravity', timeout: 10 }],
        PostToolUse: [{ matcher: '', hooks: [{ type: 'command', command: '{{mycoLauncher}} hook post-tool-use --symbiont antigravity', timeout: 5 }] }],
      },
    });

    const installer = new SymbiontInstaller(antigravity, projectRoot, packageRoot);
    expect(installer.installHooks()).toBe(true);

    const written = readJson(path.join(projectRoot, '.agents/plugins/myco/hooks.json'));
    const commands: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === 'string') { if (v.includes('--symbiont antigravity')) commands.push(v); return; }
      if (Array.isArray(v)) { v.forEach(collect); return; }
      if (v && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(collect);
    };
    collect(written);
    expect(commands.length).toBe(2);
    assertDirectBinaryCommands(commands, 'antigravity');
  });

  it('claude-code: the installed command starts with the binary and carries no cd prefix', () => {
    pinRuntimeBinary(PINNED_BINARY);
    writeLauncherHooksTemplate('claude-code');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const commands = readHookCommands(path.join(projectRoot, '.claude/settings.json'));
    for (const cmd of commands) {
      expect(cmd).not.toContain('cd ');
      expect(cmd).not.toContain('CLAUDE_PROJECT_DIR');
      expect(cmd.startsWith(PINNED_BINARY)).toBe(true);
    }
  });

  it('the bundled claude-code template carries no cd prefix and uses the placeholder', () => {
    const template = JSON.parse(
      fs.readFileSync(path.resolve('packages/myco/src/symbionts/templates/claude-code/hooks.json'), 'utf-8'),
    );
    for (const groups of Object.values(template) as Array<Array<{ hooks?: Array<{ command: string }> }>>) {
      for (const group of groups) {
        for (const hook of group.hooks ?? []) {
          expect(hook.command).not.toContain('cd ');
          expect(hook.command).not.toContain('CLAUDE_PROJECT_DIR');
          expect(hook.command).toMatch(/^\{\{mycoLauncher\}\} hook /);
        }
      }
    }
  });

  it('the generated bundle reflects the cd-prefix removal', async () => {
    const { BUNDLED_TEMPLATES } = await import('@myco/symbionts/templates.generated.js');
    const generated = BUNDLED_TEMPLATES['claude-code/hooks.json'];
    expect(generated).toBeDefined();
    expect(generated).not.toContain('CLAUDE_PROJECT_DIR');
    expect(generated).not.toContain('cd ');
    expect(generated).toContain('{{mycoLauncher}} hook session-start --symbiont claude-code');
  });

  it('forward-slashes a backslash binary path so the command is argv-safe', () => {
    pinRuntimeBinary('C:\\Program\\myco\\bin\\myco.exe');
    writeLauncherHooksTemplate('claude-code');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const commands = readHookCommands(path.join(projectRoot, '.claude/settings.json'));
    for (const cmd of commands) {
      expect(cmd).toContain('C:/Program/myco/bin/myco.exe');
      expect(cmd).not.toContain('\\');
    }
  });

  it('refuses to install when the resolved binary path contains whitespace', () => {
    pinRuntimeBinary('/Users/My Name/.myco/runtime/myco');
    writeLauncherHooksTemplate('claude-code');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    expect(() => installer.installHooks()).toThrow(/whitespace/);
  });

  it('readSymbiontFlag tolerates the trailing --myco-managed marker', () => {
    expect(readSymbiontFlag(['stop', '--symbiont', 'claude-code', '--myco-managed'])).toBe('claude-code');
    expect(readSymbiontFlag(['hook', 'session-start', '--symbiont', 'codex', '--myco-managed'])).toBe('codex');
    // Marker before the flag must not be mistaken for the symbiont value.
    expect(readSymbiontFlag(['--myco-managed', '--symbiont', 'cursor'])).toBe('cursor');
  });

  it('a freshly-emitted command is recognized as Myco-owned and install is idempotent', () => {
    pinRuntimeBinary(PINNED_BINARY);
    writeLauncherHooksTemplate('claude-code');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHooks();

    const target = path.join(projectRoot, '.claude/settings.json');
    const firstCommands = readHookCommands(target);
    for (const cmd of firstCommands) {
      expect(isMycoHookCommand(cmd)).toBe(true);
    }

    // Re-install: the marker-carrying groups are recognized and replaced, not
    // duplicated. Exactly one group remains per event.
    installer.installHooks();
    const settings = readJson(target);
    const hooks = settings.hooks as Record<string, unknown[]>;
    for (const groups of Object.values(hooks)) {
      expect(groups.length).toBe(1);
    }
  });
});
