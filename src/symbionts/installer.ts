import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import path from 'node:path';

/** Prefix used to identify Myco-owned hooks in settings files. */
const MYCO_HOOK_COMMAND_PREFIX = 'myco-run';

/**
 * Check if a hook group is Myco-owned.
 * Handles both nested format (Claude Code, Codex, etc.) and flat format (Windsurf).
 *
 * Nested: { hooks: [{ command: "myco-run ..." }] }
 * Flat:   { command: "myco-run ..." }
 */
function isMycoHookGroup(group: Record<string, unknown>): boolean {
  // Nested format: { hooks: [{ command: "myco-run ..." }] }
  const nestedHooks = group.hooks as Array<{ command?: string }> | undefined;
  if (nestedHooks?.some((h) => h.command?.startsWith(MYCO_HOOK_COMMAND_PREFIX))) return true;
  // Flat format: { command: "myco-run ..." }
  if (typeof group.command === 'string' && group.command.startsWith(MYCO_HOOK_COMMAND_PREFIX)) return true;
  return false;
}

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** Canonical cross-agent skills directory. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';

/** Command names used to identify Myco entries in settings files. */
const MYCO_COMMAND_NAMES = ['myco-run', 'myco'] as const;

export interface InstallResult {
  hooks: boolean;
  mcp: boolean;
  skills: boolean;
  settings: boolean;
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
  install(): InstallResult {
    const result = {
      hooks: this.installHooks(),
      mcp: this.installMcp(),
      skills: this.installSkills(),
      settings: this.installSettings(),
    };
    this.updateGitignore();
    return result;
  }

  /** Remove all Myco registration from this symbiont's project files. */
  uninstall(): InstallResult {
    const result = {
      hooks: this.uninstallHooks(),
      mcp: this.uninstallMcp(),
      skills: this.uninstallSkills(),
      settings: this.uninstallSettings(),
    };
    this.cleanGitignore();
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
      const nonMycoGroups = (groups as Array<Record<string, unknown>>).filter(
        (group) => !isMycoHookGroup(group),
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
    const mcpFormat = reg.mcpFormat ?? 'json';

    if (mcpFormat === 'toml') {
      return this.installMcpToml(targetPath, template);
    }
    return this.installMcpJson(targetPath, template);
  }

  /** Write MCP servers to a JSON config file. */
  private installMcpJson(targetPath: string, template: Record<string, unknown>): boolean {
    const config = readJsonFile(targetPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;

    for (const [name, def] of Object.entries(template)) {
      servers[name] = def;
    }

    config.mcpServers = servers;
    writeJsonFile(targetPath, config);
    return true;
  }

  /** Write MCP servers to a TOML config file. */
  private installMcpToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    for (const [name, def] of Object.entries(template)) {
      raw = buildTomlMcpSection(raw, name, def as Record<string, unknown>);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, raw, 'utf-8');
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
   * Merge settings template into the target settings file.
   * Deep merges objects and deduplicates arrays.
   */
  installSettings(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.settingsTarget);
    const existing = readJsonFile(targetPath);
    const merged = deepMergeSettings(existing, template);
    writeJsonFile(targetPath, merged);
    return true;
  }

  /** Remove Myco entries from the target settings file. */
  uninstallSettings(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const targetPath = path.join(this.projectRoot, reg.settingsTarget);
    const settings = readJsonFile(targetPath);
    if (Object.keys(settings).length === 0) return false;

    let changed = false;

    // Remove permissions.allow entries containing myco
    const perms = settings.permissions as Record<string, unknown> | undefined;
    if (perms?.allow && Array.isArray(perms.allow)) {
      const filtered = (perms.allow as string[]).filter(
        (p) => !MYCO_COMMAND_NAMES.some((cmd) => p.includes(cmd)),
      );
      if (filtered.length !== (perms.allow as string[]).length) {
        perms.allow = filtered.length > 0 ? filtered : undefined;
        if (!perms.allow) delete perms.allow;
        if (Object.keys(perms).length === 0) delete settings.permissions;
        changed = true;
      }
    }

    // Remove chat.tools.terminal.autoApprove entries
    const autoApprove = settings['chat.tools.terminal.autoApprove'] as Record<string, unknown> | undefined;
    if (autoApprove) {
      for (const cmd of MYCO_COMMAND_NAMES) {
        if (cmd in autoApprove) {
          delete autoApprove[cmd];
          changed = true;
        }
      }
      if (Object.keys(autoApprove).length === 0) {
        delete settings['chat.tools.terminal.autoApprove'];
      }
    }

    // Remove coreTools entries containing myco
    const coreTools = settings.coreTools as string[] | undefined;
    if (Array.isArray(coreTools)) {
      const filtered = coreTools.filter(
        (t) => !MYCO_COMMAND_NAMES.some((cmd) => t.includes(cmd)),
      );
      if (filtered.length !== coreTools.length) {
        if (filtered.length > 0) {
          settings.coreTools = filtered;
        } else {
          delete settings.coreTools;
        }
        changed = true;
      }
    }

    // Remove windsurf.cascadeCommandsAllowList entries
    const allowList = settings['windsurf.cascadeCommandsAllowList'] as string[] | undefined;
    if (Array.isArray(allowList)) {
      const filtered = allowList.filter(
        (cmd) => !MYCO_COMMAND_NAMES.some((name) => cmd === name),
      );
      if (filtered.length !== allowList.length) {
        if (filtered.length > 0) {
          settings['windsurf.cascadeCommandsAllowList'] = filtered;
        } else {
          delete settings['windsurf.cascadeCommandsAllowList'];
        }
        changed = true;
      }
    }

    if (!changed) return false;

    if (Object.keys(settings).length === 0) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    } else {
      writeJsonFile(targetPath, settings);
    }
    return true;
  }

  /** Remove Myco hook groups from the target settings file. */
  uninstallHooks(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const targetPath = path.join(this.projectRoot, reg.hooksTarget);
    const settings = readJsonFile(targetPath);
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    if (Object.keys(existingHooks).length === 0) return false;

    const cleaned: Record<string, unknown[]> = {};
    for (const [event, groups] of Object.entries(existingHooks)) {
      const nonMyco = (groups as Array<Record<string, unknown>>).filter(
        (group) => !isMycoHookGroup(group),
      );
      if (nonMyco.length > 0) {
        cleaned[event] = nonMyco;
      }
    }

    if (Object.keys(cleaned).length === 0) {
      delete settings.hooks;
    } else {
      settings.hooks = cleaned;
    }

    // Clean up empty settings file
    if (Object.keys(settings).length === 0) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    } else {
      writeJsonFile(targetPath, settings);
    }
    return true;
  }

  /** Remove Myco MCP server entry from the target config file. */
  uninstallMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.mcpTarget) return false;

    const targetPath = path.join(this.projectRoot, reg.mcpTarget);
    const mcpFormat = reg.mcpFormat ?? 'json';

    if (mcpFormat === 'toml') {
      return this.uninstallMcpToml(targetPath);
    }
    return this.uninstallMcpJson(targetPath);
  }

  private uninstallMcpJson(targetPath: string): boolean {
    const config = readJsonFile(targetPath);
    const servers = (config.mcpServers ?? {}) as Record<string, unknown>;
    if (!servers[MYCO_MCP_SERVER_NAME]) return false;

    delete servers[MYCO_MCP_SERVER_NAME];

    if (Object.keys(servers).length === 0) {
      delete config.mcpServers;
    } else {
      config.mcpServers = servers;
    }

    if (Object.keys(config).length === 0) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    } else {
      writeJsonFile(targetPath, config);
    }
    return true;
  }

  private uninstallMcpToml(targetPath: string): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }

    const sectionHeader = `[mcp_servers.${MYCO_MCP_SERVER_NAME}]`;
    if (!raw.includes(sectionHeader)) return false;

    // Remove the myco section (header + all lines until next non-subsection)
    const startIdx = raw.indexOf(sectionHeader);
    const subsectionPrefix = `mcp_servers.${MYCO_MCP_SERVER_NAME}.`;
    const searchStart = startIdx + sectionHeader.length;
    const rawLines = raw.slice(searchStart).split('\n');
    let offset = searchStart;
    let afterIdx = -1;
    for (const line of rawLines) {
      offset += line.length + 1;
      const m = line.match(TOML_SECTION_RE);
      if (m && !m[1].startsWith(subsectionPrefix) && m[1] !== `mcp_servers.${MYCO_MCP_SERVER_NAME}`) {
        afterIdx = offset - line.length - 1;
        break;
      }
    }
    const endIdx = afterIdx === -1 ? raw.length : afterIdx;
    const before = raw.slice(0, startIdx).trimEnd();
    const after = raw.slice(endIdx).trimStart();
    const updated = (before + (before && after ? '\n\n' : '') + after).trimEnd();

    if (!updated.trim()) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    } else {
      fs.writeFileSync(targetPath, updated + '\n', 'utf-8');
    }
    return true;
  }

  /** Remove skill symlinks (canonical + agent-specific). */
  uninstallSkills(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.skillsTarget) return false;

    const skillNames = this.listSkillDirs();
    if (skillNames.length === 0) return false;

    let removed = false;

    // Remove agent-specific symlinks
    if (reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
      for (const name of skillNames) {
        const link = path.join(this.projectRoot, reg.skillsTarget, name);
        try { fs.unlinkSync(link); removed = true; } catch { /* doesn't exist */ }
      }
      // Remove agent skills dir if now empty (rmdirSync fails atomically if non-empty)
      try { fs.rmdirSync(path.join(this.projectRoot, reg.skillsTarget)); } catch { /* not empty or missing */ }
    }

    // Remove canonical symlinks
    const canonicalDir = path.join(this.projectRoot, CANONICAL_SKILLS_DIR);
    for (const name of skillNames) {
      const link = path.join(canonicalDir, name);
      try { fs.unlinkSync(link); removed = true; } catch { /* doesn't exist */ }
    }
    // Remove empty dirs (rmdirSync fails atomically if non-empty)
    try { fs.rmdirSync(canonicalDir); } catch { /* not empty or missing */ }
    try { fs.rmdirSync(path.join(this.projectRoot, '.agents')); } catch { /* not empty or missing */ }

    return removed;
  }

  /** Remove Myco entries from project .gitignore. */
  private cleanGitignore(): void {
    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    let content = '';
    try { content = fs.readFileSync(gitignorePath, 'utf-8'); } catch { return; }

    // Remove the Myco skill symlinks block and individual entries
    const reg = this.manifest.registration;
    const skillNames = reg?.skillsTarget && reg.skillsTarget !== CANONICAL_SKILLS_DIR
      ? this.listSkillDirs()
      : [];
    const lines = content.split('\n');
    const filtered = lines.filter((line) => {
      if (line === '# Myco skill symlinks (machine-specific)') return false;
      if (line === `${CANONICAL_SKILLS_DIR}/`) return false;
      if (skillNames.some((name) => line === `${reg!.skillsTarget}/${name}`)) return false;
      return true;
    });

    // Clean up consecutive blank lines left by removal
    const cleaned = filtered.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    if (cleaned) {
      fs.writeFileSync(gitignorePath, cleaned + '\n', 'utf-8');
    } else {
      try { fs.unlinkSync(gitignorePath); } catch { /* ignore */ }
    }
  }
}

// --- TOML helpers ---

/** TOML section header pattern. */
const TOML_SECTION_RE = /^\[([^\]]+)\]/;

/**
 * Build/update a specific mcp_servers entry in a TOML string.
 * Pure transformation — returns updated content without writing to disk.
 */
function buildTomlMcpSection(
  raw: string,
  serverName: string,
  server: Record<string, unknown>,
): string {
  const sectionHeader = `[mcp_servers.${serverName}]`;

  // Build the TOML block for this server
  const lines: string[] = [sectionHeader];
  for (const [key, val] of Object.entries(server)) {
    if (key === 'env' && typeof val === 'object' && val !== null) continue; // Handle env as subtable
    if (typeof val === 'string') {
      lines.push(`${key} = "${val}"`);
    } else if (Array.isArray(val)) {
      lines.push(`${key} = [${val.map((v: unknown) => `"${v}"`).join(', ')}]`);
    } else if (typeof val === 'boolean') {
      lines.push(`${key} = ${val}`);
    }
  }

  // Add env subtable if present
  const env = server.env as Record<string, string> | undefined;
  if (env && Object.keys(env).length > 0) {
    lines.push('');
    lines.push(`[mcp_servers.${serverName}.env]`);
    for (const [key, val] of Object.entries(env)) {
      lines.push(`${key} = "${val}"`);
    }
  }

  const block = lines.join('\n');

  let updated: string;
  if (raw.includes(sectionHeader)) {
    // Replace existing section (from header to next top-level section or EOF)
    const startIdx = raw.indexOf(sectionHeader);
    const searchStart = startIdx + sectionHeader.length;
    // Find the next section that is NOT a subsection of this server
    const subsectionPrefix = `mcp_servers.${serverName}.`;
    let afterIdx = -1;
    const rawLines = raw.slice(searchStart).split('\n');
    let offset = searchStart;
    for (const line of rawLines) {
      offset += line.length + 1; // +1 for newline
      const m = line.match(TOML_SECTION_RE);
      if (m && !m[1].startsWith(subsectionPrefix) && m[1] !== `mcp_servers.${serverName}`) {
        afterIdx = offset - line.length - 1;
        break;
      }
    }
    const endIdx = afterIdx === -1 ? raw.length : afterIdx;
    const before = raw.slice(0, startIdx).trimEnd();
    const after = raw.slice(endIdx);
    const separator = before ? '\n\n' : '';
    updated = (before + separator + block + after).trimEnd() + '\n';
  } else {
    // Append new section
    const separator = raw.trim() ? '\n\n' : '';
    updated = (raw.trimEnd() + separator + block).trimEnd() + '\n';
  }

  return updated;
}

// --- Settings merge helpers ---

/** Deep merge two settings objects. Arrays are appended + deduplicated; objects recurse. */
function deepMergeSettings(
  target: Record<string, unknown>,
  source: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...target };
  for (const [key, sourceVal] of Object.entries(source)) {
    const targetVal = result[key];
    if (Array.isArray(sourceVal) && Array.isArray(targetVal)) {
      result[key] = [...new Set([...targetVal, ...sourceVal])];
    } else if (isPlainObject(sourceVal) && isPlainObject(targetVal)) {
      result[key] = deepMergeSettings(
        targetVal as Record<string, unknown>,
        sourceVal as Record<string, unknown>,
      );
    } else {
      result[key] = sourceVal;
    }
  }
  return result;
}

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val);
}

// --- JSON helpers ---

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
