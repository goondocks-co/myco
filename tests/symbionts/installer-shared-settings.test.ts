import { linkMemberSkills } from '@myco/symbionts/member-skill-links.js';
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { SymbiontInstaller } from '@myco/symbionts/installer.js';
import { ensureManagedSkills } from '@myco/symbionts/managed-skills.js';
import type { SymbiontManifest } from '@myco/symbionts/manifest-schema.js';
import { symbiontManifest, deriveSymbiontManifest } from '../helpers/symbiont-manifest.js';
import { isMycoHookCommand, MYCO_MANAGED_MARKER } from '@myco/symbionts/install-helpers.js';
import { readSymbiontFlag } from '@myco/hooks/normalize.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';


const CLAUDE_MANIFEST = symbiontManifest({
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
    settingsTarget: '.claude/settings.json', globalSettingsTarget: '~/.claude/settings.json',
    instructionsFile: 'CLAUDE.md',
  },
});

const CURSOR_MANIFEST = symbiontManifest({
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
    settingsTarget: '.cursor/settings.json', globalSettingsTarget: '~/.cursor/settings.json',
  },
});

/** Minimal manifest with no hooks — used to test skip-guard behavior. */
const NO_HOOKS_MANIFEST = symbiontManifest({
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
});

const CODEX_MANIFEST = symbiontManifest({
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
    settingsTarget: '.codex/config.toml', globalSettingsTarget: '~/.codex/config.toml',
    settingsFormat: 'toml',
  },
});

const MCP_BATCHED_MANIFEST = symbiontManifest({
  name: 'mcp-batched',
  displayName: 'MCP Batched',
  binary: 'mcpbatched',
  configDir: '.mcpbatched',
  pluginRootEnvVar: 'MCPBATCHED_PLUGIN_ROOT',
  settingsPath: '.mcpbatched/config.json',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.mcpbatched/config.json',
    mcpTarget: '.mcpbatched/config.json',
    mcpFormat: 'json',
    settingsTarget: '.mcpbatched/config.json', globalSettingsTarget: '~/.mcpbatched/config.json',
    skillsTarget: '.agents/skills',
  },
});

/** A symbiont whose hooks, MCP server and settings share one JSON file, for the batched merge site. */
const COLOCATED_MANIFEST = symbiontManifest({
  name: 'cli-batched',
  displayName: 'Colocated',
  binary: 'clibatched',
  configDir: '.clibatched',
  pluginRootEnvVar: 'CLIBATCHED_PLUGIN_ROOT',
  settingsPath: '.clibatched/config.json',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'session_id' },
  registration: {
    hooksTarget: '.clibatched/config.json',
    mcpTarget: '.clibatched/config.json',
    mcpFormat: 'json',
    settingsTarget: '.clibatched/config.json', globalSettingsTarget: '~/.clibatched/config.json',
    skillsTarget: '.agents/skills',
  },
});

const GEMINI_MANIFEST = symbiontManifest({
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
    settingsTarget: '.gemini/settings.json', globalSettingsTarget: '~/.gemini/settings.json',
    instructionsFile: 'GEMINI.md',
  },
});

const COPILOT_MANIFEST = symbiontManifest({
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
    settingsTarget: '.vscode/settings.json', globalSettingsTarget: '~/.vscode/settings.json',
    instructionsFile: '.github/copilot-instructions.md',
  },
});

const WINDSURF_MANIFEST = symbiontManifest({
  name: 'windsurf',
  displayName: 'Windsurf',
  binary: 'windsurf',
  configDir: '.windsurf',
  pluginRootEnvVar: 'WINDSURF_PLUGIN_ROOT',
  hookFields: { transcriptPath: 'transcript_path', lastResponse: 'last_assistant_message', sessionId: 'trajectory_id' },
  registration: {
    hooksTarget: '.windsurf/hooks.json',
    skillsTarget: '.agents/skills',
    settingsTarget: '.windsurf/settings.json', globalSettingsTarget: '~/.windsurf/settings.json',
  },
});

const OPENCODE_MANIFEST = symbiontManifest({
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
    settingsTarget: 'opencode.json', globalSettingsTarget: '~/opencode.json',
    skillsTarget: '.agents/skills',
  },
});

/** Fixture content written as the opencode plugin.ts template in tests. */
const OPENCODE_PLUGIN_TEMPLATE_CONTENT = `// Managed by Myco. Regenerated on \`myco update\`.
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


const settingsHomeBefore = process.env.HOME;
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

/** The `mcpServers` map of an MCP config file, keyed by server name. */
function readMcpServers(filePath: string): Record<string, unknown> {
  const config = readJson(filePath);
  return (config.mcpServers ?? {}) as Record<string, unknown>;
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

  fs.copyFileSync(
    path.resolve('packages/myco/src/symbionts/templates/myco-run.cjs'),
    path.join(packageRoot, 'src/symbionts/templates/myco-run.cjs'),
  );
  writeJson(path.join(windsurfTemplateDir, 'settings.json'), {
    'windsurf.cascadeCommandsAllowList': ['myco', 'myco-dev'],
  });

  const skillDir = path.join(packageRoot, 'skills/myco');
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '# Test Skill\n');
}

let installerMycoHome: string;

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-project-'));
  process.env.HOME = projectRoot;
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-package-'));
  installerMycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-home-'));
  process.env.MYCO_HOME = installerMycoHome;
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



afterEach(() => { if (settingsHomeBefore === undefined) delete process.env.HOME; else process.env.HOME = settingsHomeBefore; });



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
    const srcPath = path.join(packageRoot, 'src/symbionts/templates/claude-code/hooks.json');
    fs.unlinkSync(srcPath);

    const distDir = path.join(packageRoot, 'dist/src/symbionts/templates/claude-code');
    fs.mkdirSync(distDir, { recursive: true });
    writeJson(path.join(distDir, 'hooks.json'), HOOKS_TEMPLATE);

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const template = installer.loadTemplate('hooks');
    expect(template).not.toBeNull();
    expect(template).toHaveProperty('SessionStart');
  });
});



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
    const noSettingsManifest = deriveSymbiontManifest(CODEX_MANIFEST, {
      registration: { ...CODEX_MANIFEST.registration, settingsTarget: undefined },
    });
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
    expect(content).toContain('[features]');
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

  it('settings writer enables hooks in the global TOML file', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.installSettings();

    expect(result).toBe(true);

    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('[features]');
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
  });

  it('preserves keys the current template no longer manages', () => {
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, 'config.toml'),
      '[mcp_servers.myco]\nurl = "http://127.0.0.1:20915/mcp"\n\n[features]\ncodex_hooks = true\n',
    );
    const auditDir = path.join(process.env.MYCO_HOME!, 'installer-audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(
      path.join(auditDir, 'codex-global-settings.json'),
      JSON.stringify({ schema: 1, wroteKeys: ['features.codex_hooks'] }) + '\n',
    );

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const content = fs.readFileSync(path.join(codexDir, 'config.toml'), 'utf-8');
    expect(content).toContain('codex_hooks');
    expect(content).toContain('[features]');
    expect(content).toContain('hooks = true');
    expect(content).toContain('[features]');
  });

  it('preserves user-added sibling keys inside a Myco-managed section', () => {
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
    const codexDir = path.join(projectRoot, '.codex');
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(path.join(codexDir, 'config.toml'), '[features]\nhooks = true\n');

    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const auditPath = path.join(process.env.MYCO_HOME!, 'installer-audit', 'codex-global-settings.json');
    const audit = JSON.parse(fs.readFileSync(auditPath, 'utf-8'));
    expect(audit.wroteKeys).not.toContain('features.hooks');
  });
});



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
    expect(fs.existsSync(path.join(process.env.MYCO_HOME!, 'installer-audit', 'codex-global-settings.json'))).toBe(false);
  });
});