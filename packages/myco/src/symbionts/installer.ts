import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import path from 'node:path';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSection, removeTomlSectionKeys } from './toml-helpers.js';
import { deepMergeSettings, deepRemoveSettings } from './settings-merge.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { ensureAgentsMd, ensureSymlink, isMycoHookGroup } from './install-helpers.js';
import { loadMergedConfig } from '../config/loader.js';

/** Current comment header for Myco-managed .gitignore block. */
const GITIGNORE_COMMENT = '# Myco managed (machine-specific)';

/** Legacy comment header — recognized for cleanup during reconciliation. */
const GITIGNORE_SKILLS_COMMENT_LEGACY = '# Myco skill symlinks (machine-specific)';

/** Wrangler cache directory created by team sync operations. */
const WRANGLER_CACHE_DIR = '.wrangler/';
const AGENTS_MANAGED_START = '<!-- myco:managed:start -->';
const AGENTS_MANAGED_END = '<!-- myco:managed:end -->';
const AGENTS_MANAGED_BLOCK = `${AGENTS_MANAGED_START}
## Myco Managed Guidance

- When \`capture.ignore_plan_dirs_in_git\` is enabled, custom directories in \`capture.plan_dirs\` may be intentionally gitignored after capture into Myco.
- Do not force-add files from intentionally gitignored custom plan directories unless the user explicitly asks.
${AGENTS_MANAGED_END}
`;

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Filename of the hook guard template in the templates directory. */
const HOOK_GUARD_TEMPLATE_FILENAME = 'myco-run.cjs';

/** Filename when installed into the project .agents/ directory. */
const HOOK_GUARD_INSTALLED_FILENAME = 'myco-run.cjs';

/** Project-relative path where the hook guard is installed. */
const HOOK_GUARD_PROJECT_PATH = `.agents/${HOOK_GUARD_INSTALLED_FILENAME}`;

/**
 * Legacy guard filename we still delete on install to clean up previous
 * installations that used `.agents/myco-hook.cjs` before the rename.
 */
const LEGACY_HOOK_GUARD_PATH = '.agents/myco-hook.cjs';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** Canonical cross-agent skills directory. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';
const MCP_ENV_PROJECT_ROOT_TOKEN = '{projectRoot}';
const MCP_ENV_VAULT_DIR_TOKEN = '{vaultDir}';

interface McpLaunchOverrides {
  cwd?: string;
  env: Record<string, string>;
}

/**
 * Marker substring written into plugin-file hook templates (e.g., opencode's plugin.ts).
 * Uninstall only deletes plugin files whose content contains this marker, so
 * contributors who hand-edit a plugin file without removing the marker are protected.
 */
const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';

/** `hooksFormat` value selecting verbatim plugin-file install over JSON merge. */
const HOOKS_FORMAT_PLUGIN_FILE = 'plugin-file';

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
   * Read a template file as raw text, checking both source and dist layouts.
   * `relPath` is relative to `TEMPLATES_SUBDIR` — e.g. `'hook-guard.cjs'` for
   * a shared template or `'opencode/plugin.ts'` for a per-agent template.
   */
  private readTemplateFile(relPath: string): string | null {
    const candidates = [
      path.join(this.packageRoot, TEMPLATES_SUBDIR, relPath),
      // tsup preserves the src/ prefix under dist/, so the same subdir works in both layouts
      path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, relPath),
    ];
    for (const filePath of candidates) {
      try { return fs.readFileSync(filePath, 'utf-8'); } catch { /* try next */ }
    }
    return null;
  }

  /**
   * Write a Myco-managed file with a content-diff gate. Creates parent dirs as
   * needed. Returns `true` if the file was written (new or updated), `false` if
   * the on-disk content already matches and the write was skipped.
   */
  private writeManagedFile(absPath: string, content: string): boolean {
    try {
      if (fs.readFileSync(absPath, 'utf-8') === content) return false;
    } catch { /* doesn't exist — proceed */ }
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf-8');
    return true;
  }

  /**
   * Copy the hook guard script into .agents/myco-run.cjs and delete the
   * legacy .agents/myco-hook.cjs if present.
   *
   * The guard is the cross-platform entry point for lifecycle hooks.
   * Hook commands invoke `node .agents/myco-run.cjs …`, and the guard
   * resolves which myco binary to exec via `.myco/runtime.command`.
   * MCP server spawn continues to use the published `myco-run` binary.
   * Returns true if the file was written (or updated); false if skipped
   * or N/A.
   */
  installHookGuard(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const guardTemplate = this.readTemplateFile(HOOK_GUARD_TEMPLATE_FILENAME);
    if (!guardTemplate) return false;

    // Sweep legacy guard file on every install — harmless no-op if absent.
    // Prevents the old and new guard files coexisting for projects that
    // were last installed under the `myco-hook.cjs` naming.
    try {
      fs.unlinkSync(path.join(this.projectRoot, LEGACY_HOOK_GUARD_PATH));
    } catch { /* no legacy file present */ }

    return this.writeManagedFile(
      path.join(this.projectRoot, HOOK_GUARD_PROJECT_PATH),
      guardTemplate,
    );
  }

  /**
   * Remove the hook guard script from .agents/myco-run.cjs.
   * Also deletes the legacy .agents/myco-hook.cjs if present.
   * Returns true if any file was removed; false otherwise.
   */
  uninstallHookGuard(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    let removed = false;
    for (const relPath of [HOOK_GUARD_PROJECT_PATH, LEGACY_HOOK_GUARD_PATH]) {
      try {
        fs.unlinkSync(path.join(this.projectRoot, relPath));
        removed = true;
      } catch { /* not present */ }
    }
    return removed;
  }

  /** Load a JSON template file for this symbiont. Returns null if not found. */
  loadTemplate(name: string): Record<string, unknown> | null {
    const raw = this.readTemplateFile(path.join(this.manifest.name, `${name}.json`));
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  /**
   * Load a template file verbatim (no JSON parsing).
   * Used for plugin-file hook templates (e.g., opencode's plugin.ts) and any
   * other template that is copied to the project without structural merging.
   */
  loadTemplateRaw(filename: string): string | null {
    return this.readTemplateFile(path.join(this.manifest.name, filename));
  }

  /** Run all registration steps. */
  install(): InstallResult {
    const reg = this.manifest.registration;
    this.reconcileAgentsMd();
    // Install hook guard before hooks so the guard script is in place when hooks reference it
    this.installHookGuard();
    // One-time migration: sweep legacy MYCO_CMD / myco-run entries that
    // the pre-runtime.command dispatch pattern wrote into symbiont config
    // files. Idempotent — no-op on clean files. Runs before installSettings
    // so the stale entries don't survive a deep-merge into the new template.
    this.cleanupLegacyMycoCmdEntries();
    const result = this.shouldBatchJsonTargets(reg)
      ? this.installBatchedJson(reg!)
      : {
          hooks: this.installHooks(),
          mcp: this.installMcp(),
          skills: this.installSkills(),
          settings: this.installSettings(),
          instructions: this.installInstructions(),
          pluginPackage: this.installPluginPackage(),
        };
    this.updateGitignore();
    return result;
  }

  private reconcileAgentsMd(): void {
    ensureAgentsMd(this.projectRoot, this.packageRoot);
    const agentsPath = path.join(this.projectRoot, 'AGENTS.md');
    let content = '';
    try {
      content = fs.readFileSync(agentsPath, 'utf-8');
    } catch {
      return;
    }

    const stripped = this.stripManagedAgentsBlock(content);
    const separator = stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : '';
    const spacer = stripped.trimEnd().length > 0 ? '\n\n' : '';
    const result = `${stripped}${separator}${spacer}${AGENTS_MANAGED_BLOCK}`;
    if (result === content) return;
    fs.writeFileSync(agentsPath, result, 'utf-8');
  }

  private stripManagedAgentsBlock(content: string): string {
    const startIdx = content.indexOf(AGENTS_MANAGED_START);
    if (startIdx === -1) return content.trimEnd();
    const endIdx = content.indexOf(AGENTS_MANAGED_END, startIdx);
    if (endIdx === -1) return content.trimEnd();
    const afterEnd = endIdx + AGENTS_MANAGED_END.length;
    return (content.slice(0, startIdx) + content.slice(afterEnd)).trimEnd();
  }

  private getCustomPlanGitignoreEntries(): string[] {
    const config = this.loadProjectConfig();
    if (!config?.capture.ignore_plan_dirs_in_git) return [];

    return [...new Set(
      config.capture.plan_dirs
        .map((dir) => this.normalizeProjectRelativeDir(dir))
        .filter((dir): dir is string => dir !== null),
    )];
  }

  private loadProjectConfig() {
    try {
      return loadMergedConfig(path.join(this.projectRoot, '.myco'));
    } catch {
      return null;
    }
  }

  private normalizeProjectRelativeDir(dir: string): string | null {
    const slashNormalized = dir.trim().replaceAll('\\', '/');
    if (!slashNormalized) return null;
    if (slashNormalized.startsWith('~/')) return null;
    if (path.posix.isAbsolute(slashNormalized) || path.win32.isAbsolute(slashNormalized)) return null;

    const withoutDotPrefix = slashNormalized.replace(/^\.\//, '');
    const normalized = path.posix.normalize(withoutDotPrefix);
    if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
    return normalized.endsWith('/') ? normalized : `${normalized}/`;
  }

  /**
   * Sweep legacy `MYCO_CMD` env-var writes and `myco-run` command-name
   * entries from this symbiont's installed config files.
   *
   * Background: prior to the `.myco/runtime.command` refactor, `make
   * dev-link` injected `MYCO_CMD=myco-dev` into each symbiont's env
   * block (`.claude/settings.json` → `env`, `.cursor/mcp.json` →
   * `mcp.myco.env`, `.codex/config.toml` →
   * `[shell_environment_policy.set]`), and each symbiont's template
   * permission allowlist listed `myco-run` as a callable command. The
   * env-var pattern is now obsolete — `.myco/runtime.command` is the
   * hook-side source of truth — while the old allowlist entries remain
   * legacy noise after the permissions refactor.
   *
   * This cleanup runs automatically on every install/update pass so
   * contributors upgrading across this refactor don't need to manually
   * edit any config file. Idempotent: a second run after cleanup is a
   * no-op. Safe to remove from the install pipeline once every known
   * contributor has updated at least once.
   */
  private cleanupLegacyMycoCmdEntries(): void {
    const reg = this.manifest.registration;
    if (!reg) return;

    if (reg.settingsTarget) {
      const settingsPath = path.join(this.projectRoot, reg.settingsTarget);
      const format = reg.settingsFormat ?? 'json';
      if (format === 'toml') {
        this.stripLegacyFromToml(settingsPath);
      } else {
        this.stripLegacyFromJson(settingsPath);
      }
    }

    if (reg.mcpTarget && reg.mcpFormat !== 'toml') {
      // MCP server env blocks — cursor writes MYCO_CMD here under
      // `mcp.myco.env` / `mcpServers.myco.env`. TOML MCP targets live
      // inside the same config.toml already handled above.
      this.stripLegacyFromJson(path.join(this.projectRoot, reg.mcpTarget));
    }
  }

  /**
   * Walk a JSON settings/MCP file and delete legacy MYCO_CMD + myco-run
   * entries. Writes back only if something changed.
   *
   * Removes:
   * - `MYCO_CMD` key from any object named `env` anywhere in the tree
   * - `myco-run` / `myco-run *` / `myco-run:*` / `Bash(myco-run *)` /
   *   `Bash(myco-run:*)` / `ShellTool(myco-run *)` from string arrays
   * - `myco-run` / `myco-run *` keys from object-boolean maps like
   *   `chat.tools.terminal.autoApprove`
   */
  private stripLegacyFromJson(filePath: string): void {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
    let data: unknown;
    try { data = JSON.parse(raw); } catch { return; }

    let changed = false;
    const LEGACY_STRINGS = new Set([
      'myco-run',
      'myco-run *',
      'myco-run:*',
      'Bash(myco-run *)',
      'Bash(myco-run:*)',
      'ShellTool(myco-run *)',
    ]);
    const LEGACY_OBJECT_KEYS = ['myco-run', 'myco-run *'];
    // Fields whose array values are exec argvs (process invocation arrays),
    // NOT allowlist tokens. The cleanup sweep must not touch these because
    // `myco-run` remains the PUBLISHED MCP launcher command — stripping it
    // from an opencode-style `command: ["myco-run", "mcp"]` array would
    // corrupt the MCP spawn. Only works today because installMcp() deep-
    // merges the template back in after cleanup; don't rely on that mask.
    const EXEC_ARGV_KEYS = new Set(['command', 'args']);

    const walk = (node: unknown, parentKey?: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        // Exec argv arrays are process invocations (e.g. opencode's
        // `command: ["myco-run", "mcp"]`). Never strip tokens from these
        // — `myco-run` is the intended MCP command.
        if (parentKey !== undefined && EXEC_ARGV_KEYS.has(parentKey)) return;
        // String arrays: filter out legacy allowlist tokens in place.
        for (let i = node.length - 1; i >= 0; i--) {
          if (typeof node[i] === 'string' && LEGACY_STRINGS.has(node[i] as string)) {
            node.splice(i, 1);
            changed = true;
          } else {
            walk(node[i]);
          }
        }
        return;
      }
      const obj = node as Record<string, unknown>;
      // Env blocks: strip MYCO_CMD specifically. We check by key name so
      // we match any `env` object at any nesting level.
      if (parentKey === 'env' && 'MYCO_CMD' in obj) {
        delete obj.MYCO_CMD;
        changed = true;
      }
      // Object-boolean maps keyed on command name: strip legacy keys.
      // Skip inside exec argv scalar fields (e.g. `command: "myco-run"`)
      // would be caught by the LEGACY_OBJECT_KEYS lookup only when the
      // key is literally `myco-run`, which is a command-name key in
      // allowlist objects — exec argv scalars are fine because the
      // scalar value `"myco-run"` is walked as a string and skipped.
      for (const key of LEGACY_OBJECT_KEYS) {
        if (key in obj) {
          delete obj[key];
          changed = true;
        }
      }
      for (const [k, v] of Object.entries(obj)) {
        walk(v, k);
      }
    };

    walk(data);

    if (changed) {
      fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
    }
  }

  /**
   * Strip `MYCO_CMD = "..."` from the `[shell_environment_policy.set]`
   * section of a TOML settings file. Leaves the rest of the file
   * untouched. Drops the `[shell_environment_policy.set]` header entirely
   * when the section becomes empty.
   */
  private stripLegacyFromToml(filePath: string): void {
    let raw: string;
    try { raw = fs.readFileSync(filePath, 'utf-8'); } catch { return; }
    const next = removeTomlSectionKeys(raw, 'shell_environment_policy.set', ['MYCO_CMD']);
    if (next !== raw) {
      fs.writeFileSync(filePath, next, 'utf-8');
    }
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
      pluginPackage: this.installPluginPackage(),
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
      ...this.getCustomPlanGitignoreEntries(),
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
    let stripped = content;

    const managedStart = stripped.indexOf(GITIGNORE_COMMENT);
    if (managedStart !== -1) {
      const managedEndMatch = stripped.slice(managedStart).match(/\n\n/);
      const managedEnd = managedEndMatch
        ? managedStart + managedEndMatch.index! + managedEndMatch[0].length
        : stripped.length;
      stripped = stripped.slice(0, managedStart) + stripped.slice(managedEnd);
    }

    const reg = this.manifest.registration;
    const legacyOwnedLines = new Set<string>([
      GITIGNORE_SKILLS_COMMENT_LEGACY,
      `${CANONICAL_SKILLS_DIR}/`,
      WRANGLER_CACHE_DIR,
    ]);
    for (const name of skillNames) {
      legacyOwnedLines.add(`${CANONICAL_SKILLS_DIR}/${name}`);
      if (reg?.skillsTarget && reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
        legacyOwnedLines.add(`${reg.skillsTarget}/${name}`);
      }
    }

    const filtered = stripped
      .split('\n')
      .filter((line) => !legacyOwnedLines.has(line));
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

    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) return this.installPluginHookFile();

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
   */
  private installPluginHookFile(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const templateContent = this.loadTemplateRaw('plugin.ts');
    if (templateContent === null) return false;

    return this.writeManagedFile(
      path.join(this.projectRoot, reg.hooksTarget),
      templateContent,
    );
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
   */
  private installPluginPackage(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.pluginPackageTarget) return false;

    const templateContent = this.loadTemplateRaw('package.json');
    if (templateContent === null) return false;

    return this.writeManagedFile(
      path.join(this.projectRoot, reg.pluginPackageTarget),
      templateContent,
    );
  }

  /**
   * Merge MCP server template into the target config file.
   * Replaces the `myco` server entry; preserves other servers.
   */
  installMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.mcpTarget) return false;

    const template = this.buildMcpTemplate(this.loadTemplate('mcp'));
    if (!template) return false;

    const targetPath = path.join(this.projectRoot, reg.mcpTarget);
    if (reg.mcpFormat === 'toml') {
      return this.installMcpToml(targetPath, template);
    }
    return this.installMcpJson(targetPath, template);
  }

  private buildMcpTemplate(
    template: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!template) return null;

    const overrides = this.resolveMcpLaunchOverrides();
    if (!overrides.cwd && Object.keys(overrides.env).length === 0) return template;

    return Object.fromEntries(
      Object.entries(template).map(([name, def]) => {
        if (!def || typeof def !== 'object' || Array.isArray(def)) return [name, def];
        const server = def as Record<string, unknown>;
        const mergedEnv = {
          ...(
            server.env && typeof server.env === 'object' && !Array.isArray(server.env)
              ? server.env
              : {}
          ),
          ...overrides.env,
        } as Record<string, unknown>;
        return [
          name,
          {
            ...server,
            ...(overrides.cwd ? { cwd: overrides.cwd } : {}),
            ...(Object.keys(mergedEnv).length > 0 ? { env: mergedEnv } : {}),
          },
        ];
      }),
    );
  }

  private resolveMcpLaunchOverrides(): McpLaunchOverrides {
    const vaultDir = path.join(this.projectRoot, '.myco');
    const registration = this.manifest.registration;
    const envEntries = Object.entries(registration?.mcpEnv ?? {});
    return {
      cwd: this.resolveMcpPlaceholderValue(registration?.mcpCwd, vaultDir),
      env: Object.fromEntries(
        envEntries.flatMap(([key, value]) => {
          const resolved = this.resolveMcpPlaceholderValue(value, vaultDir);
          return resolved ? [[key, resolved] as const] : [];
        }),
      ),
    };
  }

  private resolveMcpPlaceholderValue(
    value: string | undefined,
    vaultDir: string,
  ): string | undefined {
    if (!value) return value;
    return value
      .replaceAll(MCP_ENV_PROJECT_ROOT_TOKEN, this.projectRoot)
      .replaceAll(MCP_ENV_VAULT_DIR_TOKEN, vaultDir);
  }

  /**
   * Write MCP servers to a JSON config file under the manifest-configured key.
   * Most agents use the canonical `mcpServers` key; opencode uses `mcp`.
   *
   * The `?? 'mcpServers'` fallback protects against test fixtures that construct
   * manifests as plain object literals and bypass the schema's default.
   */
  private installMcpJson(targetPath: string, template: Record<string, unknown>): boolean {
    const serversKey = this.manifest.registration!.mcpServersKey ?? 'mcpServers';
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

    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) return this.uninstallPluginHookFile();

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
    if (reg.mcpFormat === 'toml') {
      return this.uninstallMcpToml(targetPath);
    }
    return this.uninstallMcpJson(targetPath);
  }

  private uninstallMcpJson(targetPath: string): boolean {
    // Fallback matches the schema default; protects test fixtures that bypass .parse().
    const serversKey = this.manifest.registration!.mcpServersKey ?? 'mcpServers';
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
