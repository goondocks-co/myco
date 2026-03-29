import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { SymbiontInstaller } from '../../src/symbionts/installer.js';
import type { SymbiontManifest } from '../../src/symbionts/manifest-schema.js';
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

const VSCODE_MANIFEST: SymbiontManifest = {
  name: 'vscode-copilot',
  displayName: 'VS Code Copilot',
  binary: 'code',
  configDir: '.vscode',
  pluginRootEnvVar: 'VSCODE_PLUGIN_ROOT',
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

// --- Minimal hooks template for tests ---

const HOOKS_TEMPLATE = {
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: 'node .agents/myco-hook.cjs hook session-start', timeout: 10 },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: 'command', command: 'node .agents/myco-hook.cjs hook stop', timeout: 30 },
      ],
    },
  ],
};

const MCP_TEMPLATE = {
  myco: {
    type: 'stdio',
    command: 'myco-run',
    args: ['mcp'],
  },
};

// --- Test helpers ---

let projectRoot: string;
let packageRoot: string;

function writeJson(filePath: string, data: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function setupPackageRoot(): void {
  // Create template files in packageRoot
  const claudeTemplateDir = path.join(packageRoot, 'src/symbionts/templates/claude-code');
  const cursorTemplateDir = path.join(packageRoot, 'src/symbionts/templates/cursor');
  const codexTemplateDir = path.join(packageRoot, 'src/symbionts/templates/codex');
  const vscodeTemplateDir = path.join(packageRoot, 'src/symbionts/templates/vscode-copilot');
  const geminiTemplateDir = path.join(packageRoot, 'src/symbionts/templates/gemini');
  fs.mkdirSync(claudeTemplateDir, { recursive: true });
  fs.mkdirSync(cursorTemplateDir, { recursive: true });
  fs.mkdirSync(codexTemplateDir, { recursive: true });
  fs.mkdirSync(vscodeTemplateDir, { recursive: true });
  fs.mkdirSync(geminiTemplateDir, { recursive: true });

  writeJson(path.join(claudeTemplateDir, 'hooks.json'), HOOKS_TEMPLATE);
  writeJson(path.join(claudeTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(claudeTemplateDir, 'settings.json'), {
    permissions: { allow: ['Bash(myco-run *)', 'Bash(myco-run:*)', 'Bash(myco *)', 'Bash(myco:*)'] },
  });
  writeJson(path.join(cursorTemplateDir, 'hooks.json'), {
    sessionStart: [{ command: 'node .agents/myco-hook.cjs hook session-start', type: 'command', timeout: 10 }],
    stop: [{ command: 'node .agents/myco-hook.cjs hook stop', type: 'command', timeout: 30 }],
  });
  writeJson(path.join(cursorTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(cursorTemplateDir, 'settings.json'), {
    'chat.tools.terminal.autoApprove': { 'myco-run': true, 'myco': true },
  });
  writeJson(path.join(codexTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node .agents/myco-hook.cjs hook session-start', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node .agents/myco-hook.cjs hook stop', timeout: 30 }] }],
  });
  writeJson(path.join(codexTemplateDir, 'mcp.json'), {
    myco: { command: 'myco-run', args: ['mcp'] },
  });
  writeJson(path.join(vscodeTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node .agents/myco-hook.cjs hook session-start', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'node .agents/myco-hook.cjs hook stop', timeout: 30 }] }],
  });
  writeJson(path.join(vscodeTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(vscodeTemplateDir, 'settings.json'), {
    'chat.tools.terminal.autoApprove': { 'myco-run': true, 'myco': true },
  });
  writeJson(path.join(geminiTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ name: 'myco-session-start', type: 'command', command: 'node .agents/myco-hook.cjs hook session-start', timeout: 10000 }] }],
    AfterAgent: [{ hooks: [{ name: 'myco-stop', type: 'command', command: 'node .agents/myco-hook.cjs hook stop', timeout: 30000 }] }],
  });
  writeJson(path.join(geminiTemplateDir, 'mcp.json'), {
    myco: { command: 'myco-run', args: ['mcp'] },
  });
  writeJson(path.join(geminiTemplateDir, 'settings.json'), {
    coreTools: ['ShellTool(myco-run *)', 'ShellTool(myco *)'],
  });

  const windsurfTemplateDir = path.join(packageRoot, 'src/symbionts/templates/windsurf');
  fs.mkdirSync(windsurfTemplateDir, { recursive: true });
  writeJson(path.join(windsurfTemplateDir, 'hooks.json'), {
    pre_user_prompt: [{ command: 'node .agents/myco-hook.cjs hook user-prompt-submit' }],
    post_cascade_response: [{ command: 'node .agents/myco-hook.cjs hook stop' }],
  });

  // Copy hook-guard template so installHookGuard can find it
  fs.copyFileSync(
    path.resolve('src/symbionts/templates/hook-guard.cjs'),
    path.join(packageRoot, 'src/symbionts/templates/hook-guard.cjs'),
  );
  writeJson(path.join(windsurfTemplateDir, 'settings.json'), {
    'windsurf.cascadeCommandsAllowList': ['myco-run', 'myco'],
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

beforeEach(() => {
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-project-'));
  packageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-installer-package-'));
  setupPackageRoot();
});

afterEach(() => {
  fs.rmSync(projectRoot, { recursive: true, force: true });
  fs.rmSync(packageRoot, { recursive: true, force: true });
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
    expect(commands).toContain('node .agents/myco-hook.cjs hook session-start');
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
    expect((servers.myco as Record<string, unknown>).command).toBe('myco-run');
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
    const secondSkill = path.join(packageRoot, 'skills/rules');
    fs.mkdirSync(secondSkill, { recursive: true });
    fs.writeFileSync(path.join(secondSkill, 'SKILL.md'), '# Rules\n');

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSkills();

    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/rules'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/rules'))).toBe(true);
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
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco-run *)');
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco *)');
  });

  it('writes auto-approve to Cursor settings', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.cursor/settings.json'));
    expect((settings as Record<string, unknown>)['chat.tools.terminal.autoApprove']).toEqual({
      'myco-run': true,
      'myco': true,
    });
  });

  it('writes auto-approve to VS Code settings', () => {
    const installer = new SymbiontInstaller(VSCODE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.vscode/settings.json'));
    expect((settings as Record<string, unknown>)['chat.tools.terminal.autoApprove']).toEqual({
      'myco-run': true,
      'myco': true,
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
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco-run *)');
  });

  it('deduplicates on repeated install', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();
    installer.installSettings();

    const settings = readJson(path.join(projectRoot, '.claude/settings.json'));
    const allow = (settings.permissions as { allow: string[] }).allow;
    const mycoEntries = allow.filter((e: string) => e === 'Bash(myco-run *)');
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

    const installer = new SymbiontInstaller(VSCODE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const autoApprove = (settings as Record<string, unknown>)['chat.tools.terminal.autoApprove'] as Record<string, boolean>;
    expect(autoApprove['other-tool']).toBe(true);
    expect(autoApprove['myco-run']).toBe(true);
    expect(autoApprove['myco']).toBe(true);
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
    expect((settings.permissions as { allow: string[] }).allow).toContain('Bash(myco-run *)');

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
    const installer = new SymbiontInstaller(VSCODE_MANIFEST, projectRoot, packageRoot);
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
      'myco-run': true,
      'myco': true,
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
    expect((settings as Record<string, unknown>).coreTools).toContain('ShellTool(myco-run *)');
  });

  it('is idempotent — running twice produces same result', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);

    const result1 = installer.install();
    const result2 = installer.install();

    // Instructions is false on second run (file already exists — never overwritten)
    expect(result1.instructions).toBe(true);
    expect(result2.instructions).toBe(false);

    // All other fields should be identical
    expect({ ...result1, instructions: undefined }).toEqual({ ...result2, instructions: undefined });

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

  it('adds agent-specific skill symlinks to .gitignore', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.claude/skills/myco');
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
});

// =====================
// installMcp (TOML)
// =====================

describe('installMcp (TOML)', () => {
  it('writes MCP server entry to TOML config', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.installMcp();

    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.myco]');
    expect(content).toContain('command = "myco-run"');
    expect(content).toContain('args = ["mcp"]');
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
    expect(content).toContain('command = "myco-run"');
    expect(content).not.toContain('old-command');
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
    expect((settingsBefore.permissions as { allow: string[] }).allow).toContain('Bash(myco-run *)');

    installer.uninstallSettings();

    // settings.json still exists because it has hooks, but permissions.allow entries are gone
    // (hooks were separately installed and not uninstalled here)
    const settingsAfter = readJson(path.join(projectRoot, '.claude/settings.json'));
    expect(settingsAfter.permissions).toBeUndefined();
  });

  it('removes auto-approve from VS Code settings', () => {
    const installer = new SymbiontInstaller(VSCODE_MANIFEST, projectRoot, packageRoot);
    installer.installSettings();

    installer.uninstallSettings();

    // File removed when empty
    expect(fs.existsSync(path.join(projectRoot, '.vscode/settings.json'))).toBe(false);
  });

  it('preserves non-Myco auto-approve entries on uninstall', () => {
    const settingsDir = path.join(projectRoot, '.vscode');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      'chat.tools.terminal.autoApprove': { 'other-tool': true, 'myco-run': true, 'myco': true },
    });

    const installer = new SymbiontInstaller(VSCODE_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const autoApprove = (settings as Record<string, unknown>)['chat.tools.terminal.autoApprove'] as Record<string, boolean>;
    expect(autoApprove['other-tool']).toBe(true);
    expect(autoApprove['myco-run']).toBeUndefined();
    expect(autoApprove['myco']).toBeUndefined();
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
      coreTools: ['ShellTool(other-tool *)', 'ShellTool(myco-run *)', 'ShellTool(myco *)'],
    });

    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(geminiDir, 'settings.json'));
    const coreTools = settings.coreTools as string[];
    expect(coreTools).toContain('ShellTool(other-tool *)');
    expect(coreTools).not.toContain('ShellTool(myco-run *)');
    expect(coreTools).not.toContain('ShellTool(myco *)');
  });

  it('preserves non-Myco permissions on uninstall', () => {
    const settingsDir = path.join(projectRoot, '.claude');
    fs.mkdirSync(settingsDir, { recursive: true });
    writeJson(path.join(settingsDir, 'settings.json'), {
      permissions: { allow: ['Bash(git *)', 'Bash(myco-run *)', 'Bash(myco *)'] },
    });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const allow = (settings.permissions as { allow: string[] }).allow;
    expect(allow).toContain('Bash(git *)');
    expect(allow).not.toContain('Bash(myco-run *)');
    expect(allow).not.toContain('Bash(myco *)');
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
    expect(groups[0].command).toBe('node .agents/myco-hook.cjs hook user-prompt-submit');
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
    expect(commands).toContain('node .agents/myco-hook.cjs hook user-prompt-submit');
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
    expect(commands).toContain('node .agents/myco-hook.cjs hook user-prompt-submit');
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
    expect((settings as Record<string, unknown>)['windsurf.cascadeCommandsAllowList']).toContain('myco-run');
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
      'windsurf.cascadeCommandsAllowList': ['other-cmd', 'myco-run', 'myco'],
    });

    const installer = new SymbiontInstaller(WINDSURF_MANIFEST, projectRoot, packageRoot);
    installer.uninstallSettings();

    const settings = readJson(path.join(settingsDir, 'settings.json'));
    const allowList = (settings as Record<string, unknown>)['windsurf.cascadeCommandsAllowList'] as string[];
    expect(allowList).toContain('other-cmd');
    expect(allowList).not.toContain('myco-run');
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

  it('creates .github/ directory for VS Code instructions', () => {
    const installer = new SymbiontInstaller(VSCODE_MANIFEST, projectRoot, packageRoot);
    installer.installInstructions();
    expect(fs.existsSync(path.join(projectRoot, '.github/copilot-instructions.md'))).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, '.github/copilot-instructions.md'), 'utf-8');
    expect(content).toContain('VS Code Copilot');
  });

  it('creates instruction stub for Gemini CLI', () => {
    const installer = new SymbiontInstaller(GEMINI_MANIFEST, projectRoot, packageRoot);
    const result = installer.installInstructions();
    expect(result).toBe(true);
    const content = fs.readFileSync(path.join(projectRoot, 'GEMINI.md'), 'utf-8');
    expect(content).toContain('AGENTS.md');
    expect(content).toContain('Gemini CLI');
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
    // Simulate: user had custom rules, then myco init prepended the reference
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
  it('writes .agents/myco-hook.cjs', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.installHookGuard();

    expect(result).toBe(true);
    const guardPath = path.join(projectRoot, '.agents/myco-hook.cjs');
    expect(fs.existsSync(guardPath)).toBe(true);
    const content = fs.readFileSync(guardPath, 'utf-8');
    expect(content).toContain('hook guard');
  });

  it('is idempotent — second install does not rewrite if content identical', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHookGuard();

    const guardPath = path.join(projectRoot, '.agents/myco-hook.cjs');
    const stat1 = fs.statSync(guardPath);

    // Second install should return false (no change)
    const result = installer.installHookGuard();
    expect(result).toBe(false);

    // File should still exist with same content
    expect(fs.existsSync(guardPath)).toBe(true);
  });

  it('skips guard for symbionts without hooksTarget', () => {
    const installer = new SymbiontInstaller(NO_HOOKS_MANIFEST, projectRoot, packageRoot);
    const result = installer.installHookGuard();

    expect(result).toBe(false);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-hook.cjs'))).toBe(false);
  });

  it('install() writes hook guard before hooks', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();

    // Hook guard should exist
    const guardPath = path.join(projectRoot, '.agents/myco-hook.cjs');
    expect(fs.existsSync(guardPath)).toBe(true);
  });
});

// =====================
// uninstallHookGuard
// =====================

describe('uninstallHookGuard', () => {
  it('removes .agents/myco-hook.cjs', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installHookGuard();
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-hook.cjs'))).toBe(true);

    const result = installer.uninstallHookGuard();
    expect(result).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-hook.cjs'))).toBe(false);
  });

  it('does not fail if guard does not exist', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const result = installer.uninstallHookGuard();
    expect(result).toBe(false);
  });

  it('skips uninstall guard for symbionts without hooksTarget', () => {
    const installer = new SymbiontInstaller(NO_HOOKS_MANIFEST, projectRoot, packageRoot);
    const result = installer.uninstallHookGuard();
    expect(result).toBe(false);
  });

  it('uninstall() removes hook guard', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install();
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-hook.cjs'))).toBe(true);

    installer.uninstall();
    expect(fs.existsSync(path.join(projectRoot, '.agents/myco-hook.cjs'))).toBe(false);
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
    expect(command).toBe('node .agents/myco-hook.cjs hook session-start');
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
    expect(commands).toContain('node .agents/myco-hook.cjs hook user-prompt-submit');
    // No duplication
    expect(commands).toHaveLength(1);
  });
});

// =====================
// Hook template validation
// =====================

describe('hook template validation', () => {
  it('all hook templates use the guard prefix', () => {
    const templateDirs = ['claude-code', 'codex', 'cursor', 'gemini', 'vscode-copilot', 'windsurf'];
    for (const dir of templateDirs) {
      const filePath = path.resolve(`src/symbionts/templates/${dir}/hooks.json`);
      const template = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      for (const [event, groups] of Object.entries(template)) {
        for (const group of groups as Array<Record<string, unknown>>) {
          // Nested format
          if (Array.isArray(group.hooks)) {
            for (const hook of group.hooks as Array<{ command?: string }>) {
              if (hook.command) {
                expect(hook.command).toMatch(/^node \.agents\/myco-hook\.cjs /);
              }
            }
          }
          // Flat format
          if (typeof group.command === 'string') {
            expect(group.command).toMatch(/^node \.agents\/myco-hook\.cjs /);
          }
        }
      }
    }
  });
});

