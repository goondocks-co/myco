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
  if (Array.isArray(group.hooks) && group.hooks.some((h: { command?: string }) => h.command?.startsWith(MYCO_HOOK_COMMAND_PREFIX))) return true;
  // Flat format: { command: "myco-run ..." }
  if (typeof group.command === 'string' && group.command.startsWith(MYCO_HOOK_COMMAND_PREFIX)) return true;
  return false;
}

/** Comment header for Myco entries in .gitignore. */
const GITIGNORE_SKILLS_COMMENT = '# Myco skill symlinks (machine-specific)';

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** Canonical cross-agent skills directory. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';

/** Marker text used to identify unmodified instruction stubs. */
const INSTRUCTIONS_STUB_MARKER = 'Edit AGENTS.md, not this file';

/** Start/end markers for the reference block prepended to existing instruction files. */
const INSTRUCTIONS_REF_START = '<!-- myco:agents-ref:start -->';
const INSTRUCTIONS_REF_END = '<!-- myco:agents-ref:end -->';

/** Reference block prepended to existing instruction files. */
const INSTRUCTIONS_REF_BLOCK = `${INSTRUCTIONS_REF_START}
> **Project intelligence:** This project uses [Myco](https://myco.sh). The canonical project rules are in [\`AGENTS.md\`](AGENTS.md) — read and follow it alongside this file.
${INSTRUCTIONS_REF_END}

`;

export interface InstallResult {
  hooks: boolean;
  mcp: boolean;
  skills: boolean;
  settings: boolean;
  instructions: boolean;
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
    const reg = this.manifest.registration;
    const result = this.shouldBatchJsonTargets(reg)
      ? this.installBatchedJson(reg!)
      : {
          hooks: this.installHooks(),
          mcp: this.installMcp(),
          skills: this.installSkills(),
          settings: this.installSettings(),
          instructions: this.installInstructions(),
        };
    this.updateGitignore();
    return result;
  }

  /**
   * Check if ALL non-null JSON targets share the same file (e.g., Gemini).
   * Only batches when every target resolves to one path — partial overlaps
   * (e.g., Claude Code: hooks+settings share but MCP is separate) use normal path.
   */
  private shouldBatchJsonTargets(reg: typeof this.manifest.registration): boolean {
    if (!reg) return false;
    const mcpFormat = reg.mcpFormat ?? 'json';
    if (mcpFormat !== 'json') return false;
    const targets = [reg.hooksTarget, reg.mcpTarget, reg.settingsTarget].filter(Boolean);
    return targets.length > 1 && new Set(targets).size === 1;
  }

  /**
   * Batched install for agents where hooks, MCP, and settings share one JSON file.
   * Single read → apply all transforms in memory → single write.
   */
  private installBatchedJson(reg: NonNullable<typeof this.manifest.registration>): InstallResult {
    const targetPath = path.join(this.projectRoot, reg.hooksTarget ?? reg.mcpTarget ?? reg.settingsTarget!);
    let data = readJsonFile(targetPath);
    let hooks = false, mcp = false, settings = false;

    // Apply hooks transform
    const hooksTemplate = reg.hooksTarget ? this.loadTemplate('hooks') : null;
    if (hooksTemplate) {
      const existingHooks = (data.hooks ?? {}) as Record<string, unknown[]>;
      const mergedHooks: Record<string, unknown[]> = {};
      for (const [event, groups] of Object.entries(existingHooks)) {
        const nonMyco = (groups as Array<Record<string, unknown>>).filter((g) => !isMycoHookGroup(g));
        if (nonMyco.length > 0) mergedHooks[event] = nonMyco;
      }
      for (const [event, groups] of Object.entries(hooksTemplate)) {
        mergedHooks[event] = [...(mergedHooks[event] ?? []), ...(groups as unknown[])];
      }
      data.hooks = mergedHooks;
      hooks = true;
    }

    // Apply MCP transform
    const mcpTemplate = reg.mcpTarget ? this.loadTemplate('mcp') : null;
    if (mcpTemplate) {
      const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
      for (const [name, def] of Object.entries(mcpTemplate)) {
        servers[name] = def;
      }
      data.mcpServers = servers;
      mcp = true;
    }

    // Apply settings transform
    const settingsTemplate = reg.settingsTarget ? this.loadTemplate('settings') : null;
    if (settingsTemplate) {
      data = deepMergeSettings(data, settingsTemplate);
      settings = true;
    }

    writeJsonFile(targetPath, data);

    return {
      hooks,
      mcp,
      skills: this.installSkills(),
      settings,
      instructions: this.installInstructions(),
    };
  }

  /** Remove all Myco registration from this symbiont's project files. */
  uninstall(): InstallResult {
    const reg = this.manifest.registration;
    const result = this.shouldBatchJsonTargets(reg)
      ? this.uninstallBatchedJson(reg!)
      : {
          hooks: this.uninstallHooks(),
          mcp: this.uninstallMcp(),
          skills: this.uninstallSkills(),
          settings: this.uninstallSettings(),
          instructions: this.uninstallInstructions(),
        };
    this.cleanGitignore();
    return result;
  }

  /**
   * Batched uninstall for agents where hooks, MCP, and settings share one JSON file.
   */
  private uninstallBatchedJson(reg: NonNullable<typeof this.manifest.registration>): InstallResult {
    const targetPath = path.join(this.projectRoot, reg.hooksTarget ?? reg.mcpTarget ?? reg.settingsTarget!);
    const data = readJsonFile(targetPath);
    if (Object.keys(data).length === 0) {
      return { hooks: false, mcp: false, skills: this.uninstallSkills(), settings: false, instructions: this.uninstallInstructions() };
    }

    let hooks = false, mcp = false, settings = false;

    // Remove hooks
    if (reg.hooksTarget) {
      const existingHooks = (data.hooks ?? {}) as Record<string, unknown[]>;
      if (Object.keys(existingHooks).length > 0) {
        const cleaned: Record<string, unknown[]> = {};
        for (const [event, groups] of Object.entries(existingHooks)) {
          const nonMyco = (groups as Array<Record<string, unknown>>).filter((g) => !isMycoHookGroup(g));
          if (nonMyco.length > 0) cleaned[event] = nonMyco;
        }
        if (Object.keys(cleaned).length === 0) {
          delete data.hooks;
        } else {
          data.hooks = cleaned;
        }
        hooks = true;
      }
    }

    // Remove MCP
    if (reg.mcpTarget) {
      const servers = (data.mcpServers ?? {}) as Record<string, unknown>;
      if (servers[MYCO_MCP_SERVER_NAME]) {
        delete servers[MYCO_MCP_SERVER_NAME];
        if (Object.keys(servers).length === 0) delete data.mcpServers;
        else data.mcpServers = servers;
        mcp = true;
      }
    }

    // Remove settings
    const settingsTemplate = reg.settingsTarget ? this.loadTemplate('settings') : null;
    if (settingsTemplate) {
      settings = deepRemoveSettings(data, settingsTemplate);
    }

    writeOrDeleteJsonFile(targetPath, data);

    return { hooks, mcp, skills: this.uninstallSkills(), settings, instructions: this.uninstallInstructions() };
  }

  /**
   * Ensure the instruction file references AGENTS.md.
   * - File doesn't exist: write the full stub template.
   * - File exists without reference: prepend a reference block.
   * - File already has reference: skip (idempotent).
   *
   * Also ensures AGENTS.md exists — creates a starter if missing.
   */
  installInstructions(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.instructionsFile) return false;

    // Ensure AGENTS.md exists before creating stubs that reference it
    ensureAgentsMd(this.projectRoot, this.packageRoot);

    const targetPath = path.join(this.projectRoot, reg.instructionsFile);

    // Check if file already exists
    let existing: string | null = null;
    try { existing = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    if (existing !== null) {
      // File exists — check if it already has our reference
      if (existing.includes(INSTRUCTIONS_REF_START) || existing.includes(INSTRUCTIONS_STUB_MARKER)) {
        return false; // Already has reference — idempotent
      }
      // Prepend reference block to existing content
      fs.writeFileSync(targetPath, INSTRUCTIONS_REF_BLOCK + existing, 'utf-8');
      return true;
    }

    // File doesn't exist — write the full stub template
    const templateCandidates = [
      path.join(this.packageRoot, 'src/symbionts/templates/instructions-stub.md'),
      path.join(this.packageRoot, 'dist/src/symbionts/templates/instructions-stub.md'),
    ];
    let stub: string | null = null;
    for (const p of templateCandidates) {
      try { stub = fs.readFileSync(p, 'utf-8'); break; } catch { /* try next */ }
    }
    if (!stub) return false;

    stub = stub.replace('{agentDisplayName}', this.manifest.displayName);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, stub, 'utf-8');
    return true;
  }

  /**
   * Remove Myco's instruction file reference.
   * - If file is the full stub (only Myco content): delete it.
   * - If file has user content + prepended reference: remove just the reference block.
   */
  uninstallInstructions(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.instructionsFile) return false;

    const targetPath = path.join(this.projectRoot, reg.instructionsFile);
    let content: string;
    try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }

    // Case 1: Full stub — delete the file entirely
    if (content.includes(INSTRUCTIONS_STUB_MARKER)) {
      fs.unlinkSync(targetPath);
      return true;
    }

    // Case 2: Prepended reference block — remove just the block
    if (content.includes(INSTRUCTIONS_REF_START)) {
      const startIdx = content.indexOf(INSTRUCTIONS_REF_START);
      const endIdx = content.indexOf(INSTRUCTIONS_REF_END);
      if (endIdx > startIdx) {
        // Remove from start marker through end marker + trailing whitespace
        const afterEnd = endIdx + INSTRUCTIONS_REF_END.length;
        const cleaned = (content.slice(0, startIdx) + content.slice(afterEnd)).replace(/^\n+/, '');
        fs.writeFileSync(targetPath, cleaned, 'utf-8');
        return true;
      }
    }

    return false;
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
    const block = `${separator}\n${GITIGNORE_SKILLS_COMMENT}\n${newEntries.join('\n')}\n`;
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

  /**
   * Remove Myco entries from the target settings file.
   * Template-driven: loads the settings template and removes matching values.
   * Arrays: filter out values present in the template.
   * Objects: delete keys present in the template.
   */
  uninstallSettings(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.settingsTarget);
    const settings = readJsonFile(targetPath);
    if (Object.keys(settings).length === 0) return false;

    const changed = deepRemoveSettings(settings, template);
    if (!changed) return false;

    writeOrDeleteJsonFile(targetPath, settings);
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

    writeOrDeleteJsonFile(targetPath, settings);
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

    writeOrDeleteJsonFile(targetPath, config);
    return true;
  }

  private uninstallMcpToml(targetPath: string): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }

    const sectionHeader = `[mcp_servers.${MYCO_MCP_SERVER_NAME}]`;
    if (!raw.includes(sectionHeader)) return false;

    const startIdx = raw.indexOf(sectionHeader);
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, MYCO_MCP_SERVER_NAME);
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
      if (line === GITIGNORE_SKILLS_COMMENT) return false;
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

/** Find where a [mcp_servers.<name>] section ends in a TOML string. */
function findTomlSectionEnd(raw: string, searchStart: number, serverName: string): number {
  const subsectionPrefix = `mcp_servers.${serverName}.`;
  const rawLines = raw.slice(searchStart).split('\n');
  let offset = searchStart;
  for (const line of rawLines) {
    offset += line.length + 1;
    const m = line.match(TOML_SECTION_RE);
    if (m && !m[1].startsWith(subsectionPrefix) && m[1] !== `mcp_servers.${serverName}`) {
      return offset - line.length - 1;
    }
  }
  return raw.length;
}

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
    const startIdx = raw.indexOf(sectionHeader);
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, serverName);
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

/**
 * Remove values from target that match the template structure.
 * Arrays: filter out values present in the template array.
 * Objects: delete keys present in the template object, recurse into nested objects.
 * Returns true if anything was removed.
 */
function deepRemoveSettings(
  target: Record<string, unknown>,
  template: Record<string, unknown>,
): boolean {
  let changed = false;
  for (const [key, templateVal] of Object.entries(template)) {
    const targetVal = target[key];
    if (targetVal === undefined) continue;

    if (Array.isArray(templateVal) && Array.isArray(targetVal)) {
      // Filter out values that appear in the template array
      const templateSet = new Set(templateVal.map(String));
      const filtered = targetVal.filter((v) => !templateSet.has(String(v)));
      if (filtered.length !== targetVal.length) {
        if (filtered.length > 0) {
          target[key] = filtered;
        } else {
          delete target[key];
        }
        changed = true;
      }
    } else if (isPlainObject(templateVal) && isPlainObject(targetVal)) {
      // Recurse into nested objects, then prune if empty
      if (deepRemoveSettings(targetVal, templateVal)) {
        if (Object.keys(targetVal).length === 0) {
          delete target[key];
        }
        changed = true;
      }
    } else {
      // Scalar: delete if value matches
      if (String(targetVal) === String(templateVal)) {
        delete target[key];
        changed = true;
      }
    }
  }
  return changed;
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

/** Write a JSON file, or delete it if the object is empty. */
function writeOrDeleteJsonFile(filePath: string, data: Record<string, unknown>): void {
  if (Object.keys(data).length === 0) {
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }
  } else {
    writeJsonFile(filePath, data);
  }
}

/**
 * Create a starter AGENTS.md if the project doesn't have one.
 * Idempotent — skips if AGENTS.md already exists.
 */
function ensureAgentsMd(projectRoot: string, packageRoot: string): void {
  const agentsMdPath = path.join(projectRoot, 'AGENTS.md');
  if (fs.existsSync(agentsMdPath)) return;

  const candidates = [
    path.join(packageRoot, 'src/symbionts/templates/agents-starter.md'),
    path.join(packageRoot, 'dist/src/symbionts/templates/agents-starter.md'),
  ];
  for (const p of candidates) {
    try {
      const content = fs.readFileSync(p, 'utf-8');
      fs.writeFileSync(agentsMdPath, content, 'utf-8');
      return;
    } catch { /* try next */ }
  }
}

function ensureSymlink(linkPath: string, target: string): void {
  try {
    if (fs.readlinkSync(linkPath) === target) return;
  } catch { /* does not exist or is not a symlink — proceed */ }
  try { fs.rmSync(linkPath, { recursive: true, force: true }); } catch { /* ignore */ }
  fs.symlinkSync(target, linkPath);
}
