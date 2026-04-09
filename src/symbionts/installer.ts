import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSection, removeTomlSectionKeys } from './toml-helpers.js';
import { deepMergeSettings, deepRemoveSettings } from './settings-merge.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { ensureAgentsMd, ensureSymlink, isMycoHookGroup } from './install-helpers.js';

/** Current comment header for Myco-managed .gitignore block. */
const GITIGNORE_COMMENT = '# Myco managed (machine-specific)';

/** Legacy comment header — recognized for cleanup during reconciliation. */
const GITIGNORE_SKILLS_COMMENT_LEGACY = '# Myco skill symlinks (machine-specific)';

/** Wrangler cache directory created by team sync operations. */
const WRANGLER_CACHE_DIR = '.wrangler/';

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Filename of the hook guard template in the templates directory. */
const HOOK_GUARD_TEMPLATE_FILENAME = 'hook-guard.cjs';

/** Filename when installed into the project .agents/ directory. */
const HOOK_GUARD_INSTALLED_FILENAME = 'myco-hook.cjs';

/** Project-relative path where the hook guard is installed. */
const HOOK_GUARD_PROJECT_PATH = `.agents/${HOOK_GUARD_INSTALLED_FILENAME}`;

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** Canonical cross-agent skills directory. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';

/**
 * Marker substring written into plugin-file hook templates (e.g., opencode's plugin.ts).
 * Uninstall only deletes plugin files whose content contains this marker, so
 * contributors who hand-edit a plugin file without removing the marker are protected.
 */
const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';

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
  /**
   * Plugin deps package.json (e.g., .opencode/package.json). Only present for agents
   * with `registration.pluginPackageTarget` set. False otherwise.
   */
  pluginPackage: boolean;
}

export class SymbiontInstaller {
  constructor(
    private manifest: SymbiontManifest,
    private projectRoot: string,
    private packageRoot: string,
  ) {}

  /**
   * Copy the hook-guard script into .agents/myco-hook.cjs.
   * Returns true if the file was written (or updated); false if skipped or N/A.
   */
  installHookGuard(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const guardTemplate = this.loadHookGuardTemplate();
    if (!guardTemplate) return false;

    const targetPath = path.join(this.projectRoot, HOOK_GUARD_PROJECT_PATH);

    // Skip if already current
    try {
      if (fs.readFileSync(targetPath, 'utf-8') === guardTemplate) return false;
    } catch { /* doesn't exist — proceed */ }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, guardTemplate, 'utf-8');
    return true;
  }

  /**
   * Remove the hook-guard script from .agents/myco-hook.cjs.
   * Returns true if the file was removed; false otherwise.
   */
  uninstallHookGuard(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const targetPath = path.join(this.projectRoot, HOOK_GUARD_PROJECT_PATH);
    try {
      fs.unlinkSync(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /** Load the hook-guard template from package root. */
  private loadHookGuardTemplate(): string | null {
    const candidates = [
      path.join(this.packageRoot, TEMPLATES_SUBDIR, HOOK_GUARD_TEMPLATE_FILENAME),
      path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, HOOK_GUARD_TEMPLATE_FILENAME),
    ];
    for (const p of candidates) {
      try { return fs.readFileSync(p, 'utf-8'); } catch { /* try next */ }
    }
    return null;
  }

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

  /**
   * Load a template file verbatim (no JSON parsing).
   * Used for plugin-file hook templates (e.g., opencode's plugin.ts) and any
   * other template that is copied to the project without structural merging.
   */
  loadTemplateRaw(filename: string): string | null {
    const candidates = [
      path.join(this.packageRoot, TEMPLATES_SUBDIR, this.manifest.name, filename),
      path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, this.manifest.name, filename),
    ];
    for (const filePath of candidates) {
      try {
        return fs.readFileSync(filePath, 'utf-8');
      } catch { /* not found — try next */ }
    }
    return null;
  }

  /** Run all registration steps. */
  install(): InstallResult {
    const reg = this.manifest.registration;
    // Install hook guard before hooks so the guard script is in place when hooks reference it
    this.installHookGuard();
    const result = this.shouldBatchJsonTargets(reg)
      ? this.installBatchedJson(reg!)
      : {
          hooks: this.installHooks(),
          mcp: this.installMcp(),
          skills: this.installSkills(),
          settings: this.installSettings(),
          instructions: this.installInstructions(),
          pluginPackage: false,
        };
    // Plugin deps package.json (plugin-file agents only)
    result.pluginPackage = this.installPluginPackage();
    this.updateGitignore();
    return result;
  }

  /**
   * Check if ALL non-null JSON targets share the same file (e.g., Gemini).
   * Only batches when every target resolves to one path — partial overlaps
   * (e.g., Claude Code: hooks+settings share but MCP is separate) use normal path.
   *
   * Plugin-file hooks (e.g., opencode) naturally fall out of batching because their
   * hooksTarget is a distinct .ts file path, yielding a Set size ≥ 2.
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
      const serversKey = reg.mcpServersKey ?? 'mcpServers';
      const servers = (data[serversKey] ?? {}) as Record<string, unknown>;
      for (const [name, def] of Object.entries(mcpTemplate)) {
        servers[name] = def;
      }
      data[serversKey] = servers;
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
      // Batched agents (Gemini) don't have plugin-file hooks, but install() sets this
      // correctly after the dispatch returns.
      pluginPackage: false,
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
          pluginPackage: false,
        };
    // Remove hook guard after hooks/settings so the file is cleaned up last
    this.uninstallHookGuard();
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
      return {
        hooks: false,
        mcp: false,
        skills: this.uninstallSkills(),
        settings: false,
        instructions: this.uninstallInstructions(),
        pluginPackage: false,
      };
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
      const serversKey = reg.mcpServersKey ?? 'mcpServers';
      const servers = (data[serversKey] ?? {}) as Record<string, unknown>;
      if (servers[MYCO_MCP_SERVER_NAME]) {
        delete servers[MYCO_MCP_SERVER_NAME];
        if (Object.keys(servers).length === 0) delete data[serversKey];
        else data[serversKey] = servers;
        mcp = true;
      }
    }

    // Remove settings
    const settingsTemplate = reg.settingsTarget ? this.loadTemplate('settings') : null;
    if (settingsTemplate) {
      settings = deepRemoveSettings(data, settingsTemplate);
    }

    writeOrDeleteJsonFile(targetPath, data);

    return {
      hooks,
      mcp,
      skills: this.uninstallSkills(),
      settings,
      instructions: this.uninstallInstructions(),
      pluginPackage: false,
    };
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

  /**
   * Reconcile Myco-owned skill entries in project .gitignore.
   * Computes the desired entry set, strips any existing Myco block
   * (and legacy entries), then writes the current block if changed.
   */
  private updateGitignore(): void {
    const reg = this.manifest.registration;
    if (!reg?.skillsTarget) return;

    const skillNames = this.listSkillDirs();

    // Desired state: canonical per-skill entries + infrastructure artifacts.
    // Agent-specific targets (e.g. .claude/skills/) use local .gitignore files
    // instead of polluting the project-level .gitignore.
    const desired = [
      ...skillNames.map((name) => `${CANONICAL_SKILLS_DIR}/${name}`),
      WRANGLER_CACHE_DIR,
    ];

    const gitignorePath = path.join(this.projectRoot, '.gitignore');
    let content = '';
    try { content = fs.readFileSync(gitignorePath, 'utf-8'); } catch { /* doesn't exist yet */ }

    // Strip existing Myco block and any legacy entries
    const stripped = this.stripMycoGitignoreBlock(content, skillNames);

    // Build the new block
    const desiredBlock = desired.length > 0
      ? `${GITIGNORE_COMMENT}\n${desired.join('\n')}\n`
      : '';

    // Check if anything changed
    if (stripped === content && desiredBlock === '') return;
    const separator = stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : '';
    const spacer = stripped.length > 0 && desiredBlock.length > 0 ? '\n' : '';
    const result = stripped + separator + spacer + desiredBlock;
    if (result === content) return;

    fs.writeFileSync(gitignorePath, result, 'utf-8');
  }

  /**
   * Remove all Myco-owned gitignore entries: the comment header, per-skill
   * entries for both canonical and agent-specific paths, and legacy blanket
   * directory entries. Returns the cleaned content.
   */
  private stripMycoGitignoreBlock(content: string, skillNames: string[]): string {
    const reg = this.manifest.registration;
    const ownedLines = new Set<string>([
      GITIGNORE_COMMENT,
      GITIGNORE_SKILLS_COMMENT_LEGACY,
      `${CANONICAL_SKILLS_DIR}/`, // legacy blanket entry
      WRANGLER_CACHE_DIR,
    ]);
    for (const name of skillNames) {
      ownedLines.add(`${CANONICAL_SKILLS_DIR}/${name}`);
      if (reg?.skillsTarget && reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
        ownedLines.add(`${reg.skillsTarget}/${name}`);
      }
    }

    const lines = content.split('\n');
    const filtered = lines.filter((line) => !ownedLines.has(line));
    return filtered.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + (filtered.length > 0 ? '\n' : '');
  }

  /**
   * Merge hooks template into the target settings file.
   * Replaces all Myco-owned hook groups; preserves non-Myco hooks.
   *
   * For plugin-file agents (e.g., opencode) this dispatches to `installPluginHookFile()`
   * which writes a verbatim .ts plugin source to hooksTarget instead of merging JSON.
   */
  installHooks(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    if (reg.hooksFormat === 'plugin-file') return this.installPluginHookFile();

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
   * Install a plugin-file hook target by copying a verbatim template.
   * Used for agents whose hook system is plugin-based rather than JSON entry-based
   * (e.g., opencode's TypeScript plugin system).
   *
   * Content-diff gated: skips the write if the target already matches the template,
   * so `myco update` is quiet when nothing changes.
   */
  private installPluginHookFile(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const templateContent = this.loadTemplateRaw('plugin.ts');
    if (templateContent === null) return false;

    const targetPath = path.join(this.projectRoot, reg.hooksTarget);

    // Content-diff gate: skip if already current
    try {
      if (fs.readFileSync(targetPath, 'utf-8') === templateContent) return false;
    } catch { /* doesn't exist — proceed */ }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, templateContent, 'utf-8');
    return true;
  }

  /**
   * Remove a plugin-file hook target.
   * Only deletes files whose content contains the Myco plugin marker — contributors
   * who hand-edit the plugin file without removing the marker are protected.
   */
  private uninstallPluginHookFile(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const targetPath = path.join(this.projectRoot, reg.hooksTarget);
    let content: string;
    try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }

    if (!content.includes(MYCO_PLUGIN_FILE_MARKER)) return false;

    try {
      fs.unlinkSync(targetPath);
      // Remove parent plugins dir if now empty
      try { fs.rmdirSync(path.dirname(targetPath)); } catch { /* not empty or missing */ }
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Install a plugin deps package.json for plugin-file agents (e.g., opencode).
   * Writes the template verbatim so the agent's package manager can install the SDK.
   * Content-diff gated to keep `myco update` quiet.
   */
  private installPluginPackage(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.pluginPackageTarget) return false;

    const templateContent = this.loadTemplateRaw('package.json');
    if (templateContent === null) return false;

    const targetPath = path.join(this.projectRoot, reg.pluginPackageTarget);

    try {
      if (fs.readFileSync(targetPath, 'utf-8') === templateContent) return false;
    } catch { /* doesn't exist — proceed */ }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, templateContent, 'utf-8');
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
    const serversKey = reg.mcpServersKey ?? 'mcpServers';
    return this.installMcpJson(targetPath, template, serversKey);
  }

  /**
   * Write MCP servers to a JSON config file under the configured key.
   * Most agents use the canonical `mcpServers` key, but opencode uses `mcp`.
   */
  private installMcpJson(
    targetPath: string,
    template: Record<string, unknown>,
    serversKey: string,
  ): boolean {
    const config = readJsonFile(targetPath);
    const servers = (config[serversKey] ?? {}) as Record<string, unknown>;

    for (const [name, def] of Object.entries(template)) {
      servers[name] = def;
    }

    config[serversKey] = servers;
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
      ensureLocalSkillsGitignore(agentSkillsDir);
    }

    return true;
  }

  /**
   * Merge settings template into the target settings file.
   * JSON targets: deep-merges objects and deduplicates arrays.
   * TOML targets: emits each top-level template key as a [section] with scalar children.
   */
  installSettings(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.settingsTarget);
    const settingsFormat = reg.settingsFormat ?? 'json';

    if (settingsFormat === 'toml') {
      return this.installSettingsToml(targetPath, template);
    }

    const existing = readJsonFile(targetPath);
    const merged = deepMergeSettings(existing, template);
    writeJsonFile(targetPath, merged);
    return true;
  }

  /**
   * Merge a settings template into a TOML config file.
   * Each top-level key in the template becomes a [section] header, with its
   * children written as scalar key = value lines. Existing sections and keys
   * outside the template (including unrelated sections like [mcp_servers.*])
   * are preserved.
   */
  private installSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    for (const [sectionName, values] of Object.entries(template)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      raw = upsertTomlSection(raw, sectionName, values as Record<string, unknown>);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, raw, 'utf-8');
    return true;
  }

  /**
   * Remove Myco entries from the target settings file.
   * Template-driven: loads the settings template and removes matching values.
   * JSON: arrays filtered by template values, object keys deleted by name.
   * TOML: removes each template key from its section; empty sections are dropped.
   */
  uninstallSettings(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.settingsTarget) return false;

    const template = this.loadTemplate('settings');
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.settingsTarget);
    const settingsFormat = reg.settingsFormat ?? 'json';

    if (settingsFormat === 'toml') {
      return this.uninstallSettingsToml(targetPath, template);
    }

    const settings = readJsonFile(targetPath);
    if (Object.keys(settings).length === 0) return false;

    const changed = deepRemoveSettings(settings, template);
    if (!changed) return false;

    writeOrDeleteJsonFile(targetPath, settings);
    return true;
  }

  /**
   * Remove template-defined keys from TOML settings file.
   * For each section in the template, deletes only the keys the template owns;
   * other keys and unrelated sections stay intact. Empty sections are stripped.
   * Deletes the file entirely if no TOML content remains.
   */
  private uninstallSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }
    if (!raw.trim()) return false;

    let changed = false;
    for (const [sectionName, values] of Object.entries(template)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const keys = Object.keys(values as Record<string, unknown>);
      const next = removeTomlSectionKeys(raw, sectionName, keys);
      if (next !== raw) {
        raw = next;
        changed = true;
      }
    }

    if (!changed) return false;

    if (!raw.trim()) {
      try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
    } else {
      fs.writeFileSync(targetPath, raw, 'utf-8');
    }
    return true;
  }

  /**
   * Remove Myco hook groups from the target settings file.
   *
   * For plugin-file agents (e.g., opencode) this dispatches to `uninstallPluginHookFile()`
   * which deletes the verbatim plugin file (guarded by the Myco plugin marker).
   */
  uninstallHooks(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    if (reg.hooksFormat === 'plugin-file') return this.uninstallPluginHookFile();

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
    const serversKey = reg.mcpServersKey ?? 'mcpServers';
    return this.uninstallMcpJson(targetPath, serversKey);
  }

  private uninstallMcpJson(targetPath: string, serversKey: string): boolean {
    const config = readJsonFile(targetPath);
    const servers = (config[serversKey] ?? {}) as Record<string, unknown>;
    if (!servers[MYCO_MCP_SERVER_NAME]) return false;

    delete servers[MYCO_MCP_SERVER_NAME];

    if (Object.keys(servers).length === 0) {
      delete config[serversKey];
    } else {
      config[serversKey] = servers;
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
    const endIdx = findTomlSectionEnd(raw, startIdx + sectionHeader.length, `mcp_servers.${MYCO_MCP_SERVER_NAME}`);
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

    const cleaned = this.stripMycoGitignoreBlock(content, this.listSkillDirs()).trim();
    if (cleaned) {
      fs.writeFileSync(gitignorePath, cleaned + '\n', 'utf-8');
    } else {
      try { fs.unlinkSync(gitignorePath); } catch { /* ignore */ }
    }
  }
}

/**
 * Create agent-specific symlinks for a skill in `.agents/skills/<name>`.
 *
 * Reads all symbiont manifests to find skillsTarget paths that differ
 * from the canonical `.agents/skills/` directory, then creates relative
 * symlinks from each target to the canonical location.
 *
 * Called by vault_write_skill after writing a generated skill to disk.
 * Also handles removal: when `remove` is true, deletes the symlinks.
 */
export function syncSkillSymlinks(
  projectRoot: string,
  skillName: string,
  opts?: { remove?: boolean },
): void {
  // Resolve manifests dir — try sibling (source layout) then dist layout
  // (tsup bundles into dist/chunk-*.js, but manifests are at dist/src/symbionts/manifests/)
  const selfDir = path.dirname(new URL(import.meta.url).pathname);
  const candidates = [
    path.join(selfDir, 'manifests'),
    path.join(selfDir, 'src', 'symbionts', 'manifests'),
  ];
  const manifestDir = candidates.find((d) => fs.existsSync(d));
  if (!manifestDir) return;

  const targets = new Set<string>();
  for (const file of fs.readdirSync(manifestDir).filter((f) => f.endsWith('.yaml'))) {
    try {
      const content = fs.readFileSync(path.join(manifestDir, file), 'utf-8');
      const match = content.match(/skillsTarget:\s*(.+)/);
      if (match) targets.add(match[1].trim());
    } catch { /* skip unreadable manifests */ }
  }

  for (const target of targets) {
    if (target === CANONICAL_SKILLS_DIR) continue; // canonical is the source, not a link target

    const agentSkillsDir = path.join(projectRoot, target);
    const linkPath = path.join(agentSkillsDir, skillName);

    if (opts?.remove) {
      try { fs.unlinkSync(linkPath); } catch { /* doesn't exist */ }
      try { fs.rmdirSync(agentSkillsDir); } catch { /* not empty or missing */ }
    } else {
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      const canonicalDir = path.join(projectRoot, CANONICAL_SKILLS_DIR);
      const relTarget = path.join(path.relative(agentSkillsDir, canonicalDir), skillName);
      ensureSymlink(linkPath, relTarget);
      // Ensure a local .gitignore ignores all symlinks in this directory.
      // Localized to the agent's skills dir — doesn't pollute the project .gitignore.
      ensureLocalSkillsGitignore(agentSkillsDir);
    }
  }
}

/** Content for the local .gitignore that ignores Myco-created symlinks. */
const LOCAL_SKILLS_GITIGNORE = `# Myco-managed symlinks — generated skills are symlinked here automatically.
# The canonical location for all skills is .agents/skills/.
#
# To add your own skill to this directory, un-ignore it:
#   !my-skill
*
!.gitignore
`;

/**
 * Write a .gitignore inside an agent's skills directory that ignores all
 * symlinks Myco creates there. Idempotent — skips if already present.
 */
function ensureLocalSkillsGitignore(agentSkillsDir: string): void {
  const gitignorePath = path.join(agentSkillsDir, '.gitignore');
  try {
    if (fs.readFileSync(gitignorePath, 'utf-8') === LOCAL_SKILLS_GITIGNORE) return;
  } catch { /* doesn't exist — proceed */ }
  fs.writeFileSync(gitignorePath, LOCAL_SKILLS_GITIGNORE, 'utf-8');
}
