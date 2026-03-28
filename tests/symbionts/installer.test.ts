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
    envTarget: 'settings',
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
    mcpTarget: '.cursor/mcp.json',
    mcpFormat: 'json',
    skillsTarget: '.cursor/skills',
    envTarget: 'mcp-server',
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
    envTarget: 'mcp-server',
  },
};

// --- Minimal hooks template for tests ---

const HOOKS_TEMPLATE = {
  SessionStart: [
    {
      hooks: [
        { type: 'command', command: 'myco-run hook session-start', timeout: 10 },
      ],
    },
  ],
  Stop: [
    {
      hooks: [
        { type: 'command', command: 'myco-run hook stop', timeout: 30 },
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
  fs.mkdirSync(claudeTemplateDir, { recursive: true });
  fs.mkdirSync(cursorTemplateDir, { recursive: true });
  fs.mkdirSync(codexTemplateDir, { recursive: true });

  writeJson(path.join(claudeTemplateDir, 'hooks.json'), HOOKS_TEMPLATE);
  writeJson(path.join(claudeTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(cursorTemplateDir, 'mcp.json'), MCP_TEMPLATE);
  writeJson(path.join(codexTemplateDir, 'hooks.json'), {
    SessionStart: [{ hooks: [{ type: 'command', command: 'myco-run hook session-start', timeout: 10 }] }],
    Stop: [{ hooks: [{ type: 'command', command: 'myco-run hook stop', timeout: 30 }] }],
  });
  writeJson(path.join(codexTemplateDir, 'mcp.json'), {
    myco: { command: 'myco-run', args: ['mcp'] },
  });

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

  it('returns null for hooks when symbiont has no hooks template (cursor)', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const template = installer.loadTemplate('hooks');
    expect(template).toBeNull();
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
    expect(commands).toContain('myco-run hook session-start');
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

  it('returns false when no hooksTarget in manifest (cursor)', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
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
// installEnv
// =====================

describe('installEnv', () => {
  it('writes MYCO_VAULT_DIR to Claude Code settings.json', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const vaultDir = '/home/user/.myco/vaults/test';
    const result = installer.installEnv(vaultDir);

    expect(result).toBe(true);
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    const settings = readJson(settingsPath);
    expect((settings.env as Record<string, string>).MYCO_VAULT_DIR).toBe(vaultDir);
  });

  it('preserves existing env vars', () => {
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    writeJson(settingsPath, { env: { EXISTING_VAR: 'keep-me' } });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.installEnv('/vault/path');

    const settings = readJson(settingsPath);
    const env = settings.env as Record<string, string>;
    expect(env.EXISTING_VAR).toBe('keep-me');
    expect(env.MYCO_VAULT_DIR).toBe('/vault/path');
  });

  it('writes env to Cursor MCP server entry', () => {
    // Pre-create the cursor mcp.json with the myco server (required)
    const mcpPath = path.join(projectRoot, '.cursor/mcp.json');
    writeJson(mcpPath, {
      mcpServers: {
        myco: { type: 'stdio', command: 'myco-run', args: ['mcp'] },
      },
    });

    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const result = installer.installEnv('/vault/path');

    expect(result).toBe(true);
    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    const mycoEnv = servers.myco.env as Record<string, string>;
    expect(mycoEnv.MYCO_VAULT_DIR).toBe('/vault/path');
  });

  it('returns false for Cursor when myco server entry does not exist', () => {
    // Create cursor mcp.json without myco server
    const mcpPath = path.join(projectRoot, '.cursor/mcp.json');
    writeJson(mcpPath, { mcpServers: {} });

    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const result = installer.installEnv('/vault/path');
    expect(result).toBe(false);
  });

  it('preserves existing env on Cursor MCP server entry', () => {
    const mcpPath = path.join(projectRoot, '.cursor/mcp.json');
    writeJson(mcpPath, {
      mcpServers: {
        myco: { type: 'stdio', command: 'myco-run', args: ['mcp'], env: { OTHER_VAR: 'hello' } },
      },
    });

    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    installer.installEnv('/vault/path');

    const config = readJson(mcpPath);
    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    const mycoEnv = servers.myco.env as Record<string, string>;
    expect(mycoEnv.OTHER_VAR).toBe('hello');
    expect(mycoEnv.MYCO_VAULT_DIR).toBe('/vault/path');
  });

  it('returns false when no settingsPath in manifest', () => {
    const noSettingsManifest: SymbiontManifest = {
      ...CLAUDE_MANIFEST,
      settingsPath: undefined,
    };
    const installer = new SymbiontInstaller(noSettingsManifest, projectRoot, packageRoot);
    const result = installer.installEnv('/vault/path');
    expect(result).toBe(false);
  });
});

// =====================
// install (integration)
// =====================

describe('install', () => {
  it('runs all four steps and returns results for Claude Code', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const vaultDir = '/home/user/.myco/vaults/test';
    const result = installer.install(vaultDir);

    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.env).toBe(true);
  });

  it('verifies all files exist after Claude Code install', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install('/vault/path');

    // Hooks and env in settings.json
    const settingsPath = path.join(projectRoot, '.claude/settings.json');
    expect(fs.existsSync(settingsPath)).toBe(true);
    const settings = readJson(settingsPath);
    expect(settings.hooks).toBeDefined();
    expect(settings.env).toBeDefined();

    // MCP config
    const mcpPath = path.join(projectRoot, '.mcp.json');
    expect(fs.existsSync(mcpPath)).toBe(true);

    // Skills
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
    expect(fs.existsSync(path.join(projectRoot, '.claude/skills/myco'))).toBe(true);
  });

  it('runs all four steps and returns results for Cursor', () => {
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const result = installer.install('/vault/path');

    // Cursor has no hooks
    expect(result.hooks).toBe(false);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.env).toBe(true);

    // Verify env was merged into MCP server entry
    const config = readJson(path.join(projectRoot, '.cursor/mcp.json'));
    const servers = config.mcpServers as Record<string, Record<string, unknown>>;
    expect((servers.myco.env as Record<string, string>).MYCO_VAULT_DIR).toBe('/vault/path');
  });

  it('is idempotent — running twice produces same result', () => {
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    const vaultDir = '/vault/path';

    const result1 = installer.install(vaultDir);
    const result2 = installer.install(vaultDir);

    expect(result1).toEqual(result2);

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
  it('adds .agents/skills/ to project .gitignore', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install('~/vaults/myco');

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.agents/skills/');
  });

  it('adds agent-specific skill symlinks to .gitignore', () => {
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install('~/vaults/myco');

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('.claude/skills/myco');
  });

  it('does not duplicate existing entries', () => {
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), '.agents/skills/\n');
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install('~/vaults/myco');
    installer.install('~/vaults/myco'); // Second run

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    const matches = gitignore.match(/\.agents\/skills\//g);
    expect(matches?.length).toBe(1);
  });

  it('appends to existing .gitignore content', () => {
    fs.writeFileSync(path.join(projectRoot, '.gitignore'), 'node_modules/\n.env\n');
    fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });

    const installer = new SymbiontInstaller(CLAUDE_MANIFEST, projectRoot, packageRoot);
    installer.install('~/vaults/myco');

    const gitignore = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf-8');
    expect(gitignore).toContain('node_modules/');
    expect(gitignore).toContain('.agents/skills/');
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

  it('includes env when vaultDir is provided', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    installer.installMcp('~/vaults/myco');

    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('[mcp_servers.myco.env]');
    expect(content).toContain('MYCO_VAULT_DIR = "~/vaults/myco"');
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
// install (mcp-server envTarget)
// =====================

describe('install (mcp-server envTarget)', () => {
  it('writes env in MCP pass for Cursor, skips separate installEnv', () => {
    fs.mkdirSync(path.join(projectRoot, '.cursor'), { recursive: true });
    const installer = new SymbiontInstaller(CURSOR_MANIFEST, projectRoot, packageRoot);
    const result = installer.install('~/vaults/myco');

    expect(result.mcp).toBe(true);
    expect(result.env).toBe(true);

    const config = readJson(path.join(projectRoot, '.cursor/mcp.json'));
    expect((config.mcpServers as Record<string, Record<string, unknown>>).myco.env).toEqual({ MYCO_VAULT_DIR: '~/vaults/myco' });
  });

  it('writes env in TOML MCP pass for Codex', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.install('~/vaults/myco');

    expect(result.mcp).toBe(true);
    expect(result.env).toBe(true);

    const content = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(content).toContain('MYCO_VAULT_DIR = "~/vaults/myco"');
  });

  it('runs all steps for Codex including hooks and skills', () => {
    fs.mkdirSync(path.join(projectRoot, '.codex'), { recursive: true });
    const installer = new SymbiontInstaller(CODEX_MANIFEST, projectRoot, packageRoot);
    const result = installer.install('~/vaults/myco');

    expect(result.hooks).toBe(true);
    expect(result.mcp).toBe(true);
    expect(result.skills).toBe(true);
    expect(result.env).toBe(true);

    // Hooks file
    const hooks = readJson(path.join(projectRoot, '.codex/hooks.json'));
    expect(hooks.hooks).toBeDefined();

    // TOML MCP config
    const toml = fs.readFileSync(path.join(projectRoot, '.codex/config.toml'), 'utf-8');
    expect(toml).toContain('[mcp_servers.myco]');

    // Skills — canonical only (skillsTarget === CANONICAL_SKILLS_DIR)
    expect(fs.existsSync(path.join(projectRoot, '.agents/skills/myco'))).toBe(true);
  });
});
