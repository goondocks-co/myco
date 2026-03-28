import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import path from 'node:path';

/** Prefix used to identify Myco-owned hooks in settings files. */
const MYCO_HOOK_COMMAND_PREFIX = 'myco-run';

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** Canonical cross-agent skills directory. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';

/** Environment variable name for the vault directory. */
export const MYCO_VAULT_DIR_ENV = 'MYCO_VAULT_DIR';

export interface InstallResult {
  hooks: boolean;
  mcp: boolean;
  skills: boolean;
  env: boolean;
}

export class SymbiontInstaller {
  constructor(
    private manifest: SymbiontManifest,
    private projectRoot: string,
    private packageRoot: string,
  ) {}

  /** Load a JSON template file for this symbiont. Returns null if not found. */
  loadTemplate(name: string): Record<string, unknown> | null {
    // Check both source layout and dist layout
    const candidates = [
      path.join(this.packageRoot, TEMPLATES_SUBDIR, this.manifest.name, `${name}.json`),
      // tsup preserves the src/ prefix under dist/, so the same subdir works in both layouts
      path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, this.manifest.name, `${name}.json`),
    ];
    for (const filePath of candidates) {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      } catch { /* not found or malformed — try next */ }
    }
    return null;
  }

  /** Run all registration steps. */
  install(vaultDir: string): InstallResult {
    const result = {
      hooks: this.installHooks(),
      mcp: this.installMcp(),
      skills: this.installSkills(),
      env: this.installEnv(vaultDir),
    };
    this.updateGitignore();
    return result;
  }

  /** List skill directory names from the package root. Returns empty array if not found. */
  private listSkillDirs(): string[] {
    try {
      return fs.readdirSync(path.join(this.packageRoot, SKILLS_SUBDIR), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch { return []; }
  }

  /** Add skill symlink paths to project .gitignore. */
  private updateGitignore(): void {
    const reg = this.manifest.registration;
    if (!reg?.skillsTarget) return;

    const skillNames = this.listSkillDirs();

    const entries = [
      `${CANONICAL_SKILLS_DIR}/`,
      ...(reg.skillsTarget !== CANONICAL_SKILLS_DIR
        ? skillNames.map((name) => `${reg.skillsTarget}/${name}`)
        : []
      ),
    ];

    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    let existing = '';
    try { existing = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* doesn't exist yet */ }

    const newEntries = entries.filter((e) => !existing.includes(e));
    if (newEntries.length === 0) return;

    const separator = existing.endsWith('\n') || existing === '' ? '' : '\n';
    const block = `${separator}\n# Myco skill symlinks (machine-specific)\n${newEntries.join('\n')}\n`;
    fs.writeFileSync(gitignorePath, existing + block, 'utf-8');
  }

  /**
   * Merge hooks template into the target settings file.
   * Replaces all Myco-owned hook groups; preserves non-Myco hooks.
   */
  installHooks(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const template = this.loadTemplate('hooks');
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.hooksTarget);
    const settings = readJsonFile(targetPath);
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;

    // Build merged hooks: for each event, keep non-Myco groups + add template groups
    const mergedHooks: Record<string, unknown[]> = {};

    // Preserve non-Myco hooks from existing config
    for (const [event, groups] of Object.entries(existingHooks)) {
      const nonMycoGroups = (groups as Array<{ hooks?: Array<{ command?: string }> }>).filter(
        (group) => !group.hooks?.some((h) => h.command?.startsWith(MYCO_HOOK_COMMAND_PREFIX)),
      );
      if (nonMycoGroups.length > 0) {
        mergedHooks[event] = nonMycoGroups;
      }
    }

    // Add template hooks
    for (const [event, groups] of Object.entries(template)) {
      mergedHooks[event] = [...(mergedHooks[event] ?? []), ...(groups as unknown[])];
    }

    settings.hooks = mergedHooks;
    writeJsonFile(targetPath, settings);
    return true;
  }

  /**
   * Merge MCP server template into the target config file.
   * Replaces the `myco` server entry; preserves other servers.
   */
  installMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.mcpTarget) return false;

    const template = this.loadTemplate('mcp');
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.mcpTarget);
    const config = readJsonFile(targetPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

    for (const [name, def] of Object.entries(template)) {
      servers[name] = def;
    }

    config.mcpServers = servers;
    writeJsonFile(targetPath, config);
    return true;
  }

  /**
   * Create symlinks for skills through .agents/skills/ canonical layer.
   * Canonical: .agents/skills/<name> -> <packageRoot>/skills/<name>
   * Agent-specific: <skillsTarget>/<name> -> ../../.agents/skills/<name>
   */
  installSkills(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.skillsTarget) return false;

    const skillNames = this.listSkillDirs();
    if (skillNames.length === 0) return false;

    const skillsSrc = path.join(this.packageRoot, SKILLS_SUBDIR);

    // Create canonical symlinks: .agents/skills/<name> -> package skills
    const canonicalDir = path.join(this.projectRoot, CANONICAL_SKILLS_DIR);
    fs.mkdirSync(canonicalDir, { recursive: true });

    for (const name of skillNames) {
      const canonicalLink = path.join(canonicalDir, name);
      const target = path.join(skillsSrc, name);
      ensureSymlink(canonicalLink, target);
    }

    // Create agent-specific symlinks if skillsTarget differs from canonical
    const agentSkillsDir = path.join(this.projectRoot, reg.skillsTarget);
    const canonicalRel = path.relative(agentSkillsDir, canonicalDir);

    if (reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      for (const name of skillNames) {
        const agentLink = path.join(agentSkillsDir, name);
        const relTarget = path.join(canonicalRel, name);
        ensureSymlink(agentLink, relTarget);
      }
    }

    return true;
  }

  /**
   * Write MYCO_VAULT_DIR to the symbiont's settings file.
   * Dispatch is manifest-driven via registration.envTarget:
   *   'settings'    → top-level env key in settingsPath (Claude Code)
   *   'mcp-server'  → env on the myco server entry in settingsPath (Cursor)
   */
  installEnv(vaultDir: string): boolean {
    const settingsPath = this.manifest.settingsPath;
    if (!settingsPath) return false;

    const targetPath = path.join(this.projectRoot, settingsPath);
    const envTarget = this.manifest.registration?.envTarget;

    if (envTarget === 'mcp-server') {
      // Env goes on the MCP server entry (must already exist — written by installMcp)
      const config = readJsonFile(targetPath);
      const servers = (config.mcpServers ?? {}) as Record<string, Record<string, unknown>>;
      if (servers[MYCO_MCP_SERVER_NAME]) {
        servers[MYCO_MCP_SERVER_NAME].env = {
          ...(servers[MYCO_MCP_SERVER_NAME].env as Record<string, string> ?? {}),
          [MYCO_VAULT_DIR_ENV]: vaultDir,
        };
        config.mcpServers = servers;
        writeJsonFile(targetPath, config);
        return true;
      }
      return false;
    }

    // Default ('settings' or unset): env goes in settings.json under env key
    const settings = readJsonFile(targetPath);
    const env = (settings.env ?? {}) as Record<string, string>;
    env[MYCO_VAULT_DIR_ENV] = vaultDir;
    settings.env = env;
    writeJsonFile(targetPath, settings);
    return true;
  }
}

// --- Helpers ---

function readJsonFile(filePath: string): Record<string, unknown> {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return {};
  }
}

function writeJsonFile(filePath: string, data: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (fs.readlinkSync(linkPath) === target) return;
  } catch { /* does not exist or is not a symlink — proceed */ }
  try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.symlinkSync(target, linkPath);
}
