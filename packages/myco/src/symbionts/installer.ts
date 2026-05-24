import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { installGlobalLaunchers } from '../grove/launcher-install.js';
import { expandHome, resolveMycoHome } from '../grove/paths.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSection, upsertTomlSectionKeys, removeTomlSectionKeys, readTomlSectionKey } from './toml-helpers.js';
import { deepMergeSettings, deepRemoveSettings } from './settings-merge.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { ensureAgentsMd, ensureSymlink, isMycoHookGroup, containsMycoLauncherReference } from './install-helpers.js';
import { loadMergedConfig } from '../config/loader.js';
import { resolveDaemonServiceState } from '../daemon/service-state.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';

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
- When orienting in this codebase — finding a feature, locating files relevant to a change, or understanding an unfamiliar subsystem — use Myco first: call \`node .agents/myco-cli.cjs tool call myco_cortex --json --input '{"op":"canopy_map"}'\` as the project-resolved CLI path, or \`myco_cortex({"op":"canopy_map"})\` via MCP when the host exposes Myco tools cleanly, before falling back to Glob/Grep.
${AGENTS_MANAGED_END}
`;

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Filename of the hook guard template in the templates directory. */
const HOOK_GUARD_TEMPLATE_FILENAME = 'myco-run.cjs';

/** Filename when installed into the project .agents/ directory. */
const HOOK_GUARD_INSTALLED_FILENAME = 'myco-run.cjs';

/** Project-local CLI launcher installed beside the capture hook guard. */
const CLI_LAUNCHER_INSTALLED_FILENAME = 'myco-cli.cjs';

/** Project-relative path where the hook guard is installed. */
const HOOK_GUARD_PROJECT_PATH = `.agents/${HOOK_GUARD_INSTALLED_FILENAME}`;

/** Project-relative path where the CLI launcher is installed. */
const CLI_LAUNCHER_PROJECT_PATH = `.agents/${CLI_LAUNCHER_INSTALLED_FILENAME}`;

/**
 * Legacy guard filename we still delete on install to clean up previous
 * installations that used `.agents/myco-hook.cjs` before the rename.
 */
const LEGACY_HOOK_GUARD_PATH = '.agents/myco-hook.cjs';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** Canonical cross-agent skills directory. */
const CANONICAL_SKILLS_DIR = '.agents/skills';

/** Built-in skill names retired from the package but still present in older installs. */
const LEGACY_BUILTIN_SKILL_NAMES = ['myco-curate', 'rules'];

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';

/**
 * All top-level JSON keys agents are known to use to hold their MCP
 * server map. The installer sweeps every entry in this set on every
 * install/uninstall so that a stale `myco` entry under a previously-
 * configured key (e.g., a VS Code mcp.json migrated from `mcpServers`
 * to `servers` when Copilot CLI + VS Code unified under one symbiont)
 * is cleaned up rather than left behind as orphaned config.
 *
 * Keep in sync with every `mcpServersKey` value across the manifest
 * registry. If a new symbiont introduces a new key, add it here so
 * future shape migrations clean up old shapes too.
 */
const KNOWN_MCP_SERVERS_KEYS = ['mcpServers', 'servers', 'mcp'] as const;

/**
 * Marker substring written into plugin-file hook templates (e.g., opencode's plugin.ts).
 * Uninstall only deletes plugin files whose content contains this marker, so
 * contributors who hand-edit a plugin file without removing the marker are protected.
 */
const MYCO_PLUGIN_FILE_MARKER = 'myco:plugin-marker';

/** `hooksFormat` value selecting verbatim plugin-file install over JSON merge. */
const HOOKS_FORMAT_PLUGIN_FILE = 'plugin-file';

/**
 * Marker pair delimiting the shared-helpers block inside plugin-file templates
 * (e.g., opencode and pi plugins). At install time the region between these
 * markers is replaced with the canonical snippet content from
 * `_shared/plugin-helpers.ts.snippet`. The on-disk template files also carry
 * an inline copy so they stay valid TypeScript for Vitest imports — a
 * dedicated test enforces the inline copy matches the snippet.
 */
const PLUGIN_SHARED_HELPERS_START = '// <myco:shared-helpers>';
const PLUGIN_SHARED_HELPERS_END = '// </myco:shared-helpers>';

/** Relative path (from TEMPLATES_SUBDIR) to the shared-helpers snippet. */
const PLUGIN_SHARED_HELPERS_SNIPPET = '_shared/plugin-helpers.ts.snippet';

/**
 * Placeholder substituted into cursor's hooks.json `command` fields at install
 * time. Keeping the cd-to-project-root prefix in one place avoids the nine-way
 * duplication the template used to carry — a single edit here updates every hook.
 */
const CURSOR_PROJECT_ROOT_PLACEHOLDER = '{{projectRootCd}}';
const CURSOR_PROJECT_ROOT_CD =
  'cd "$(git rev-parse --show-toplevel 2>/dev/null || echo ${CURSOR_PROJECT_DIR:-.})"';

/**
 * Placeholder substituted into every hook template's `command` field at
 * install time. Resolves to the launcher binary that should handle hooks
 * for the active `installScope`:
 *
 *   - `'project'`: `node .agents/myco-run.cjs` — invokes the project-local
 *     guard, which is what historical templates hard-coded. Templates
 *     remain meaningful in project-scope installs (e.g. `myco init
 *     --project`).
 *   - `'global'`: `node "<home>/.myco/launcher.cjs"` — invokes the shared
 *     absolute-path launcher installed by `installGlobalLaunchers`. The
 *     launcher itself layers a project-local override (`<projectRoot>/.agents/
 *     myco-run.cjs`) before falling through to runtime resolution, so a
 *     project that happens to ship a dev pin still wins.
 *
 * Centralizing the placeholder here means a single edit per scope rewrites
 * every hook in every template. The legacy "global install writes
 * project-local launcher path into a global file" bug class is impossible
 * once every template path runs through this substitution.
 */
const MYCO_LAUNCHER_PLACEHOLDER = '{{mycoLauncher}}';
const PROJECT_LAUNCHER_CMD = 'node .agents/myco-run.cjs';

/**
 * Resolve `{{mycoLauncher}}` to the absolute launcher command for the
 * given scope. `mycoHome` is the directory `installGlobalLaunchers()`
 * writes the launcher to (i.e. `resolveMycoHome()` — honors `MYCO_HOME`),
 * not the OS home dir. Two are aligned so the hook command always
 * points to a real file: in tests that override `MYCO_HOME`, in
 * production deployments that override `MYCO_HOME`, and in the default
 * case where both fall back to `os.homedir() + '/.myco'`.
 *
 * The path is emitted UNQUOTED. Symbionts diverge in how they spawn
 * hook commands: claude-code / codex / antigravity / copilot
 * route through a shell (their templates prefix with `cd ... &&` or
 * the symbiont's runtime defaults to shell), while cursor / windsurf /
 * pi spawn the command via direct argv split. A quoted path survives
 * the shell flavor (quotes get stripped) but breaks direct-argv: the
 * literal `"` characters end up in the file-path argument, and `node`
 * fails to find a file at `'"/Users/.../launcher.cjs"'`. Unquoted
 * works in both worlds — provided the home path has no whitespace,
 * which `assertSafeHomeForUnquotedPath` enforces at install time.
 */
function resolveLauncherCmd(scope: InstallScope, mycoHome: string): string {
  if (scope === 'project') return PROJECT_LAUNCHER_CMD;
  const launcherPath = path.join(mycoHome, 'launcher.cjs');
  assertSafeHomeForUnquotedPath(launcherPath);
  return `node ${launcherPath}`;
}

/**
 * Refuse to emit a hook command whose launcher path contains whitespace.
 * Quoting would survive shell symbionts but break direct-argv symbionts
 * (cursor / windsurf / pi). Failing loudly at install time beats silent
 * capture failure after the agent's next launch.
 */
function assertSafeHomeForUnquotedPath(launcherPath: string): void {
  if (!/\s/.test(launcherPath)) return;
  throw new Error(
    `Refusing to install global symbiont hooks: launcher path "${launcherPath}" ` +
    `contains whitespace, which breaks direct-argv hook spawn for cursor / windsurf / pi. ` +
    `Move Myco out of a path with spaces, or run \`myco init --project\` to use the ` +
    `project-local launcher instead.`,
  );
}

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
  /**
   * Plugin-bundle marker file (e.g., antigravity's `plugin.json`). Only
   * present for agents with `registration.pluginManifestTarget` (or its
   * global counterpart) set. False otherwise. Distinct from
   * `pluginPackage`: this is the agent's plugin-discovery marker, not a
   * runtime dependency declaration.
   */
  pluginManifest: boolean;
}

export type InstallScope = 'project' | 'global';

/**
 * Per-scope capability switch. Centralizes the "which operations run
 * under which scope" decision so it lives in one declarative table
 * instead of scattered `if (installScope === 'global')` guards through
 * every install / uninstall method.
 *
 * Project scope: full project-content management (AGENTS.md stub,
 * .gitignore, instruction files), per-project launcher writes, and a
 * canonical-symlink skills layer.
 *
 * Global scope: project-content surfaces are skipped (the install
 * doesn't touch the project tree), the hook guard becomes the shared
 * `~/.myco/launcher.cjs` + `mcp-launcher.cjs`, skills symlink directly
 * into the agent's globalSkillsTarget, and plugin package deps are
 * irrelevant.
 */
interface ScopeCapabilities {
  agentsMd: boolean;
  gitignore: boolean;
  instructions: boolean;
  pluginPackage: boolean;
  globalLauncher: boolean;
  flatSkills: boolean;
  detectionGate: boolean;
}

const SCOPE_CAPABILITIES: Record<InstallScope, ScopeCapabilities> = {
  project: {
    agentsMd: true, gitignore: true, instructions: true, pluginPackage: true,
    globalLauncher: false, flatSkills: false, detectionGate: false,
  },
  global: {
    agentsMd: false, gitignore: false, instructions: false, pluginPackage: false,
    globalLauncher: true, flatSkills: true, detectionGate: true,
  },
};

export class SymbiontInstaller {
  /**
   * `vaultDir` defaults to `<projectRoot>/.myco` for ordinary installs.
   * It's separately settable so the worktree-bootstrap path can write hook
   * files into the worktree (`projectRoot = worktreeRoot`) while still
   * reading config from the main repo's shared vault.
   */
  private readonly vaultDir: string;
  /** Grove id for config loading — undefined triggers a dev-mode warning. */
  private readonly groveId: string | null | undefined;
  /**
   * Scope governs *which operations execute* and *where files land*.
   *
   *   - `'project'`: today's behavior. Files write under `projectRoot`;
   *     project-content surfaces (AGENTS.md, `.gitignore`, instruction
   *     stubs) are managed in step.
   *   - `'global'`: user-global install. Target paths come from each
   *     manifest's `global*Target` fields; project-content surfaces are
   *     skipped entirely; the hook guard is replaced by the absolute-path
   *     launchers at `~/.myco/launcher.cjs` + `~/.myco/mcp-launcher.cjs`.
   *     A detection gate refuses to install when the agent's
   *     `manifest.detectionDir` does not exist on disk.
   */
  private readonly installScope: InstallScope;

  constructor(
    private manifest: SymbiontManifest,
    private projectRoot: string,
    private packageRoot: string,
    // When true, the bundled-templates fallback is suppressed. Tests use
    // this to exercise scenarios where a specific template file is absent
    // from the packageRoot without inheriting the baked-in copy.
    private suppressBundledTemplates: boolean = false,
    vaultDir?: string,
    groveId?: string | null,
    installScope: InstallScope = 'project',
  ) {
    this.vaultDir = vaultDir ?? path.join(projectRoot, '.myco');
    this.groveId = groveId;
    this.installScope = installScope;
  }

  /** Capability switch for the active scope. */
  private get capabilities(): ScopeCapabilities {
    return SCOPE_CAPABILITIES[this.installScope];
  }

  /**
   * Absolute path for a manifest target field, resolved by scope:
   *
   *   - `'project'` joins the project-relative manifest field
   *     (`reg.hooksTarget`, etc.) onto `projectRoot`.
   *   - `'global'` expands `~` in the corresponding `globalXxxTarget`
   *     field. Returns `null` when the manifest declares no global
   *     surface for that field (explicit `null` per Decision 7).
   */
  private resolveAbsoluteTarget(field: 'hooks' | 'skills' | 'settings'): string | null {
    const reg = this.manifest.registration;
    if (!reg) return null;
    if (this.installScope === 'global') {
      // Settings under global scope:
      //   1. If the manifest declares an explicit `globalSettingsTarget`,
      //      honor it — this is the right surface when settingsFormat
      //      doesn't share shape with the hooks file (codex: TOML
      //      settings + JSON hooks). The dedicated path keeps
      //      installSettingsToml from corrupting a JSON hooks file with
      //      a TOML section.
      //   2. Plugin-file hooks: return null — settings template would
      //      clobber the plugin source if it landed at the hooks path.
      //   3. Otherwise: share the hooks file (Claude-Code-style merge).
      const settingsTarget = reg.globalSettingsTarget !== undefined
        ? reg.globalSettingsTarget
        : (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE ? null : reg.globalHooksTarget);
      const target = field === 'hooks' ? reg.globalHooksTarget
        : field === 'skills' ? reg.globalSkillsTarget
        : settingsTarget;
      if (!target) return null;
      return expandHome(target);
    }
    const target = field === 'hooks' ? reg.hooksTarget
      : field === 'skills' ? reg.skillsTarget
      : reg.settingsTarget;
    if (!target) return null;
    return path.join(this.projectRoot, target);
  }

  /**
   * Resolve every absolute MCP target the active install scope needs
   * to write. Returns an empty array when the manifest declares no
   * MCP surface (e.g. Pi, whose tools route through the extension
   * runtime). Each entry carries its expanded absolute path and the
   * top-level JSON key it expects (`serversKey`) — required because
   * one agent runtime can have multiple surfaces with diverging
   * shapes (Copilot CLI uses `mcpServers`, VS Code Copilot extension
   * uses `servers` — same `myco` server entry, different parent key).
   *
   * `serversKey` falls through manifest.registration.mcpServersKey
   * (existing field), and finally to `mcpServers` (Claude/standard
   * MCP convention). Single-target manifests with no override behave
   * exactly as before.
   */
  private resolveAbsoluteMcpTargets(): Array<{ path: string; serversKey: string }> {
    const reg = this.manifest.registration;
    if (!reg) return [];
    const defaultKey = reg.mcpServersKey ?? 'mcpServers';
    if (this.installScope === 'global') {
      const targets = reg.globalMcpTarget;
      if (!targets || targets.length === 0) return [];
      return targets.map((entry) => ({
        path: expandHome(entry.path),
        serversKey: entry.serversKey ?? defaultKey,
      }));
    }
    const target = reg.mcpTarget;
    if (!target) return [];
    return [{
      path: path.join(this.projectRoot, target),
      serversKey: defaultKey,
    }];
  }

  /**
   * Whether Myco is currently configured for this symbiont under the
   * active scope. Inspects the agent's hooks file using the same
   * marker logic the installer uses to write the block: a JSON
   * settings file contains a hook group flagged by `isMycoHookGroup`,
   * or a plugin-file template contains the `MYCO_PLUGIN_FILE_MARKER`.
   *
   * Pattern: the answer to "is Myco configured here?" lives in the
   * same module that owns marker semantics — substring-scanning the
   * file from elsewhere drifts the moment markers change.
   */
  isConfigured(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (!targetPath) return false;
    let raw: string;
    try {
      raw = fs.readFileSync(targetPath, 'utf-8');
    } catch {
      return false;
    }
    // Plugin-file targets: prefer the bundle marker (opencode/pi
    // ship it inline). For plugin-file targets whose template is JSON
    // (antigravity's hooks.json), the marker comment isn't present;
    // fall through to the launcher-command substring scan below.
    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) {
      if (raw.includes(MYCO_PLUGIN_FILE_MARKER)) return true;
      return containsMycoLauncherReference(raw);
    }
    // JSON path: prefer the structured walk (catches a Myco-marked
    // group even if the command field gets renamed in a future
    // template). Fall back to substring detection when the file
    // isn't strict JSON — Codex's `~/.codex/hooks.json` ships with
    // a TOML `[features]` footer that JSON.parse rejects but the
    // agent itself reads happily. An inspector must answer "are we
    // wired in" correctly across both shapes; the writer (installHooks)
    // still owns the strict-JSON contract.
    try {
      const parsed = JSON.parse(raw) as { hooks?: Record<string, unknown[]> };
      const hooks = parsed.hooks ?? {};
      for (const groups of Object.values(hooks)) {
        for (const group of groups as Array<Record<string, unknown>>) {
          if (isMycoHookGroup(group)) return true;
        }
      }
    } catch {
      /* fall through to substring scan */
    }
    return containsMycoLauncherReference(raw);
  }

  /**
   * Detection gate for the global install. Returns false when the agent
   * isn't installed on this machine (its declared `detectionDir` is
   * absent) — the installer should silently skip rather than create the
   * agent's config dir on its behalf (Decision 7's "never create the
   * agent's dir" rule).
   *
   * Always returns true for `installScope: 'project'` — project-local
   * installs are explicitly opted into by `myco init --project`, so the
   * gate doesn't apply.
   */
  isAvailableForScope(): boolean {
    if (this.installScope !== 'global') return true;
    const dir = this.manifest.detectionDir;
    if (!dir) return false;
    try {
      return fs.statSync(expandHome(dir)).isDirectory();
    } catch {
      return false;
    }
  }

  /**
   * Read a template file as raw text, checking both source and dist layouts.
   * `relPath` is relative to `TEMPLATES_SUBDIR` — e.g. `'hook-guard.cjs'` for
   * a shared template or `'opencode/plugin.ts'` for a per-agent template.
   */
  private readTemplateFile(relPath: string): string | null {
    // Prefer on-disk templates in dev/test so local edits and fixture package
    // roots are reflected immediately. The bundled map remains the compiled
    // binary fallback when those package files are unavailable under /$bunfs/.
    const candidates = [
      path.join(this.packageRoot, TEMPLATES_SUBDIR, relPath),
      // tsup preserves the src/ prefix under dist/, so the same subdir works in both layouts
      path.join(this.packageRoot, 'dist', TEMPLATES_SUBDIR, relPath),
    ];
    for (const filePath of candidates) {
      try { return fs.readFileSync(filePath, 'utf-8'); } catch { /* try next */ }
    }

    if (this.suppressBundledTemplates) return null;
    const key = relPath.split(path.sep).join('/');
    const bundled = BUNDLED_TEMPLATES[key];
    if (bundled !== undefined) return bundled;
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
    // Atomic write so a torn write to a shared user-home agent config
    // (under `installScope: 'global'`) can never leave the file
    // half-written. Same discipline as launcher-install.ts.
    atomicWriteFileSync(absPath, content);
    return true;
  }

  /**
   * Copy runtime launchers into .agents/ and delete the legacy
   * .agents/myco-hook.cjs if present.
   *
   * `myco-run.cjs` is the capture launcher for lifecycle hooks.
   * `myco-cli.cjs` is the project-local launcher for CLI/tool calls.
   * Both use the same template and resolve runtime scope from filename.
   * MCP server spawn continues to use the published `myco-run` binary.
   * Returns true if any file was written (or updated); false if skipped
   * or N/A.
   */
  installHookGuard(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget && !this.capabilities.globalLauncher) return false;

    if (this.capabilities.globalLauncher) {
      // Global launcher path: the absolute-path launchers at
      // `~/.myco/launcher.cjs` and `~/.myco/mcp-launcher.cjs` replace
      // the project-local `.agents/myco-run.cjs` / `myco-cli.cjs`.
      // `installGlobalLaunchers()` is idempotent and shared across every
      // symbiont's global install — the first symbiont's install pass
      // writes them; subsequent passes see content matches and skip.
      const report = installGlobalLaunchers();
      return report.written.length > 0;
    }

    const guardTemplate = this.readTemplateFile(HOOK_GUARD_TEMPLATE_FILENAME);
    if (!guardTemplate) return false;

    // Sweep legacy guard file on every install — harmless no-op if absent.
    // Prevents the old and new guard files coexisting for projects that
    // were last installed under the `myco-hook.cjs` naming.
    try {
      fs.unlinkSync(path.join(this.projectRoot, LEGACY_HOOK_GUARD_PATH));
    } catch { /* no legacy file present */ }

    const wroteHookGuard = this.writeManagedFile(
      path.join(this.projectRoot, HOOK_GUARD_PROJECT_PATH),
      guardTemplate,
    );
    const wroteCliLauncher = this.writeManagedFile(
      path.join(this.projectRoot, CLI_LAUNCHER_PROJECT_PATH),
      guardTemplate,
    );
    return wroteHookGuard || wroteCliLauncher;
  }

  /**
   * Remove runtime launchers from .agents/.
   *
   * Thin instance wrapper around the module-level `removeProjectLaunchers`
   * helper — kept so existing callers (tests, init.ts) don't need to know
   * about the project-root boundary. New callers should prefer the
   * module-level helper directly; it makes the project-level scope of
   * the operation explicit in the call site.
   *
   * Returns true if any file was removed; false otherwise.
   */
  uninstallHookGuard(): boolean {
    if (this.capabilities.globalLauncher) return false;
    return removeProjectLaunchers(this.projectRoot).length > 0;
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
    if (this.capabilities.detectionGate && !this.isAvailableForScope()) {
      // Agent isn't installed on this machine — skip silently, never
      // create the agent's config dir on its behalf.
      return {
        hooks: false, mcp: false, skills: false, settings: false,
        instructions: false, pluginPackage: false, pluginManifest: false,
      };
    }
    // Project-content surfaces (AGENTS.md, .gitignore, instruction stubs)
    // are intentionally project-scope-only — they live in the repo tree.
    if (this.capabilities.agentsMd) this.reconcileAgentsMd();
    // Install hook guard before hooks so the guard script is in place when hooks reference it.
    // Write-ordering invariant: launchers MUST land before any agent's
    // global config is updated to reference them.
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
          instructions: this.capabilities.instructions ? this.installInstructions() : false,
          pluginPackage: this.installPluginPackage(),
          pluginManifest: this.installPluginManifest(),
        };
    if (this.capabilities.gitignore) this.updateGitignore();
    return result;
  }

  private reconcileAgentsMd(): void {
    ensureAgentsMd(this.projectRoot);
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
      return loadMergedConfig(this.vaultDir, { groveId: this.groveId });
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
      const settingsPath = this.resolveAbsoluteTarget("settings");
      const format = reg.settingsFormat ?? 'json';
      if (settingsPath) {
        if (format === 'toml') {
          this.stripLegacyFromToml(settingsPath);
        } else {
          this.stripLegacyFromJson(settingsPath);
        }
      }
    }

    if (reg.mcpTarget && reg.mcpFormat !== 'toml') {
      // MCP server env blocks — cursor writes MYCO_CMD here under
      // `mcp.myco.env` / `mcpServers.myco.env`. TOML MCP targets live
      // inside the same config.toml already handled above. Multi-target
      // manifests (Copilot) get the legacy strip applied to every MCP
      // file they own.
      for (const target of this.resolveAbsoluteMcpTargets()) {
        this.stripLegacyFromJson(target.path);
      }
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
    // stripping tokens from an opencode-style `command` array would corrupt
    // the MCP spawn. Only works today because installMcp() deep-merges the
    // template back in after cleanup; don't rely on that mask.
    const EXEC_ARGV_KEYS = new Set(['command', 'args']);

    const walk = (node: unknown, parentKey?: string): void => {
      if (node === null || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        // Exec argv arrays are process invocations (e.g. opencode's
        // MCP `command` array). Never strip tokens from these.
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
    const targetPath = this.resolveAbsoluteTarget("hooks")!;
    let data = readJsonFile(targetPath);
    let hooks = false, mcp = false, settings = false;

    // Apply hooks transform
    const rawHooksTemplate = reg.hooksTarget ? this.loadTemplate('hooks') : null;
    const hooksTemplate = rawHooksTemplate
      ? this.resolveHookTemplatePlaceholders(rawHooksTemplate)
      : null;
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

    // Apply MCP transform — sweep stale entries under historical
    // server-list keys before writing under the current one, so a
    // shape migration (mcpServersKey rename) doesn't leave behind a
    // duplicate `myco` registration under the old key.
    const mcpTemplate = reg.mcpTarget ? this.loadTemplate('mcp') : null;
    if (mcpTemplate) {
      const serversKey = reg.mcpServersKey ?? 'mcpServers';
      for (const candidateKey of KNOWN_MCP_SERVERS_KEYS) {
        if (candidateKey === serversKey) continue;
        const candidate = data[candidateKey];
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const bag = candidate as Record<string, unknown>;
        if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
        delete bag[MYCO_MCP_SERVER_NAME];
        if (Object.keys(bag).length === 0) delete data[candidateKey];
      }
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
      pluginManifest: this.installPluginManifest(),
    };
  }

  /**
   * Remove all Myco registration from this symbiont's project files.
   *
   * Scope: only this symbiont's own config files. The project-shared
   * launcher (`.agents/myco-run.cjs` / `myco-cli.cjs`) is NOT removed
   * here — uninstalling symbiont A must not break symbiont B's hooks.
   * Callers that want full project-level teardown (`myco remove`) call
   * `removeProjectLaunchers(projectRoot)` explicitly after looping
   * uninstall over every symbiont.
   *
   * Project-content surfaces (`.gitignore` Myco block, instruction
   * stubs) are scrubbed by default, because `myco remove` wants them
   * gone too. The migration walker passes `keepProjectContent: true`
   * to retain those — they're project-level concerns that survive a
   * per-symbiont config cleanup (e.g., plan-capture `.gitignore`
   * entries stay relevant whether the symbiont install is project- or
   * global-scoped, and instruction stubs reference AGENTS.md which
   * outlives any individual symbiont).
   */
  uninstall(options: { keepProjectContent?: boolean } = {}): InstallResult {
    const reg = this.manifest.registration;
    const keepProjectContent = options.keepProjectContent === true;
    const result = this.shouldBatchJsonTargets(reg)
      ? this.uninstallBatchedJson(reg!)
      : {
          hooks: this.uninstallHooks(),
          mcp: this.uninstallMcp(),
          skills: this.uninstallSkills(),
          settings: this.uninstallSettings(),
          instructions: this.capabilities.instructions && !keepProjectContent
            ? this.uninstallInstructions()
            : false,
          pluginPackage: false,
          // Plugin-bundle marker (e.g., antigravity's `plugin.json`) is
          // a per-symbiont config file, not project-content. Always
          // safe to remove on uninstall — even from the walker's
          // keepProjectContent=true path — because the marker only
          // means anything when the symbiont's hooks/MCP are also
          // present, which the walker has just removed.
          pluginManifest: this.uninstallPluginManifest(),
        };
    if (this.capabilities.gitignore && !keepProjectContent) {
      this.cleanGitignore();
    }
    return result;
  }

  /**
   * Batched uninstall for agents where hooks, MCP, and settings share one JSON file.
   */
  private uninstallBatchedJson(reg: NonNullable<typeof this.manifest.registration>): InstallResult {
    const targetPath = this.resolveAbsoluteTarget("hooks")!;
    const data = readJsonFile(targetPath);
    if (Object.keys(data).length === 0) {
      return {
        hooks: false,
        mcp: false,
        skills: this.uninstallSkills(),
        settings: false,
        instructions: this.uninstallInstructions(),
        pluginPackage: false,
        pluginManifest: false,
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

    // Remove MCP — sweep every known server-list key so a legacy
    // entry under a previously-configured `mcpServersKey` is cleaned
    // up too, not just the current one.
    if (reg.mcpTarget) {
      const serversKey = reg.mcpServersKey ?? 'mcpServers';
      const candidateKeys = Array.from(new Set([serversKey, ...KNOWN_MCP_SERVERS_KEYS]));
      for (const key of candidateKeys) {
        const bag = data[key];
        if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
        const servers = bag as Record<string, unknown>;
        if (!(MYCO_MCP_SERVER_NAME in servers)) continue;
        delete servers[MYCO_MCP_SERVER_NAME];
        if (Object.keys(servers).length === 0) delete data[key];
        else data[key] = servers;
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
      pluginManifest: false,
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
    ensureAgentsMd(this.projectRoot);

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
    let stub = this.readTemplateFile('instructions-stub.md');
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
        atomicWriteFileSync(targetPath, cleaned);
        return true;
      }
    }

    return false;
  }

  /** List skill directory names from the package root. Returns empty array if not found. */
  private listSkillDirs(): string[] {
    try {
      const skillsRoot = path.join(this.packageRoot, SKILLS_SUBDIR);
      return fs.readdirSync(skillsRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .filter((d) => fs.existsSync(path.join(skillsRoot, d.name, 'SKILL.md')))
        .map((d) => d.name);
    } catch { return []; }
  }

  /** Remove symlinks for retired built-in skills from older installs. */
  private cleanupLegacySkillSymlinks(currentSkillNames: string[]): void {
    const reg = this.manifest.registration;
    if (!reg?.skillsTarget) return;

    const staleSkillNames = LEGACY_BUILTIN_SKILL_NAMES.filter((name) => !currentSkillNames.includes(name));
    if (staleSkillNames.length === 0) return;

    const canonicalDir = path.join(this.projectRoot, CANONICAL_SKILLS_DIR);
    for (const name of staleSkillNames) {
      try { fs.unlinkSync(path.join(canonicalDir, name)); } catch { /* doesn't exist */ }
      if (reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
        try { fs.unlinkSync(path.join(this.resolveAbsoluteTarget("skills")!, name)); } catch { /* doesn't exist */ }
      }
    }

    if (reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
      try { fs.rmdirSync(this.resolveAbsoluteTarget("skills")!); } catch { /* not empty or missing */ }
    }
    try { fs.rmdirSync(canonicalDir); } catch { /* not empty or missing */ }
  }

  /**
   * Reconcile the Myco-managed `.gitignore` block for the project this
   * installer is rooted at. Public so the migration walker / detect-
   * tick can re-assert the block once per project regardless of which
   * scope the symbiont install lives in — `.gitignore` plan-capture
   * entries are a project-level concern that must survive even when
   * per-symbiont configs are uninstalled.
   *
   * Idempotent: when the strip-and-rewrite cycle produces identical
   * content the function returns without writing. Safe to call on
   * every detect tick.
   */
  reconcileProjectGitignore(): void {
    this.updateGitignore();
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
    for (const name of LEGACY_BUILTIN_SKILL_NAMES) {
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

    const rawTemplate = this.loadTemplate('hooks');
    if (!rawTemplate) return false;
    const template = this.resolveHookTemplatePlaceholders(rawTemplate);

    const targetPath = this.resolveAbsoluteTarget("hooks")!;
    // Defensive: writeJsonFile would silently overwrite a TOML file with
    // JSON, corrupting the user's mcp_servers / profiles / etc. We don't
    // currently support TOML hook merging, so refuse loudly rather than
    // produce a divergent-state failure mode.
    if (targetPath.endsWith('.toml')) {
      throw new Error(
        `Refusing to write JSON hooks to a TOML target: ${targetPath} ` +
        `(manifest ${this.manifest.name}). Point hooksTarget / globalHooksTarget ` +
        `at a .json file or add explicit TOML hook merging support.`,
      );
    }
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
    if (reg.hooksConfigVersion !== undefined) {
      settings.version = reg.hooksConfigVersion;
    }
    return writeJsonFile(targetPath, settings);
  }

  /**
   * Single substitution pass for the `{{mycoLauncher}}` placeholder.
   * Both the JSON-template walker below and the plugin-file install
   * path go through this — one source of truth for scope→launcher
   * resolution means the two install paths can't drift apart.
   */
  private substituteMycoLauncher(content: string): string {
    if (!content.includes(MYCO_LAUNCHER_PLACEHOLDER)) return content;
    // Use `resolveMycoHome()` rather than `os.homedir()` so the embedded
    // hook command points at the SAME path `installGlobalLaunchers()` wrote
    // the launcher to. Two cases this aligns:
    //   - Tests that override `MYCO_HOME` to a tmp vault (Bun's
    //     `os.homedir()` ignores in-process changes to `$HOME`, so the
    //     previous `os.homedir()` path embedded the developer's real
    //     `~/.myco/launcher.cjs` and only passed by accident on machines
    //     where Myco was dogfooded into that directory).
    //   - Production users who point `MYCO_HOME` at a custom location —
    //     the launcher writes there, the hook command should too.
    const launcherCmd = resolveLauncherCmd(this.installScope, resolveMycoHome());
    return content.split(MYCO_LAUNCHER_PLACEHOLDER).join(launcherCmd);
  }

  /**
   * Walk a JSON hooks template and substitute install-time placeholders.
   *
   * Two placeholders today:
   *   - `{{projectRootCd}}` (cursor) → cd-to-project-root prefix.
   *   - `{{mycoLauncher}}` (every template) → scope-resolved launcher
   *     command, delegated to `substituteMycoLauncher` so the JSON
   *     path and the plugin-file path share one resolver.
   *
   * Returns a new object — never mutates the input.
   */
  private resolveHookTemplatePlaceholders(
    template: Record<string, unknown>,
  ): Record<string, unknown> {
    const substitute = (value: unknown): unknown => {
      if (typeof value === 'string') {
        let next = value;
        if (next.includes(CURSOR_PROJECT_ROOT_PLACEHOLDER)) {
          next = next.split(CURSOR_PROJECT_ROOT_PLACEHOLDER).join(CURSOR_PROJECT_ROOT_CD);
        }
        next = this.substituteMycoLauncher(next);
        return next;
      }
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]),
        );
      }
      return value;
    };

    return substitute(template) as Record<string, unknown>;
  }

  /**
   * Install a plugin-file hook target by copying a verbatim template.
   * Used for agents whose hook system is plugin-based rather than JSON entry-based
   * (e.g., opencode's TypeScript plugin system).
   */
  private installPluginHookFile(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    // Most plugin-file symbionts ship a TS plugin under `plugin.ts`
    // (opencode, pi). Antigravity's bundle layout differs — its hook config
    // is a verbatim `hooks.json` file inside the bundle — so the manifest
    // can declare an alternate template filename via `hooksTemplateFile`.
    const templateFile = reg.hooksTemplateFile ?? 'plugin.ts';
    const templateContent = this.loadTemplateRaw(templateFile);
    if (templateContent === null) return false;

    const withHelpers = this.injectSharedPluginHelpers(templateContent);

    // JSON-shaped plugin templates (e.g. antigravity's `hooks.json`)
    // must substitute placeholders INSIDE string values rather than as
    // raw bytes — the resolved launcher command contains literal `"`
    // characters that would invalidate the surrounding JSON if injected
    // textually. Route through the same JSON walker the JSON-merge
    // install path uses so escaping is handled by JSON.stringify.
    // .ts plugin templates (opencode, pi) keep the raw-string path —
    // TS string literals are tolerant of embedded quotes.
    let resolved: string;
    if (templateFile.endsWith('.json')) {
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(withHelpers) as Record<string, unknown>;
      } catch (err) {
        throw new Error(
          `Plugin-file template ${templateFile} for symbiont ${this.manifest.name} ` +
          `is declared as a .json file but does not parse as JSON: ${(err as Error).message}`,
        );
      }
      const substituted = this.resolveHookTemplatePlaceholders(parsed);
      resolved = JSON.stringify(substituted, null, 2) + '\n';
    } else {
      resolved = this.substituteMycoLauncher(withHelpers);
    }

    return this.writeManagedFile(
      this.resolveAbsoluteTarget("hooks")!,
      resolved,
    );
  }

  /**
   * Replace the `<myco:shared-helpers>` block in a plugin template with the
   * canonical snippet content. When either the snippet or the markers are
   * missing, return the input unchanged — plugin templates that don't use
   * the shared-helpers pattern (future agents, older installs in flight)
   * stay valid without needing to opt in.
   */
  private injectSharedPluginHelpers(templateContent: string): string {
    const startIdx = templateContent.indexOf(PLUGIN_SHARED_HELPERS_START);
    if (startIdx === -1) return templateContent;
    const endIdx = templateContent.indexOf(PLUGIN_SHARED_HELPERS_END, startIdx);
    if (endIdx === -1) return templateContent;

    const snippet = this.readTemplateFile(PLUGIN_SHARED_HELPERS_SNIPPET);
    if (snippet === null) return templateContent;

    // Walk forward to the newline that ends the end-marker line so the
    // replacement slots in cleanly between whole lines.
    const endLine = templateContent.indexOf('\n', endIdx);
    const afterEnd = endLine === -1 ? templateContent.length : endLine;

    // Snippet is authored without surrounding markers — wrap it so the
    // installed file retains the same self-describing boundary contributors
    // use to navigate the source.
    const replacement =
      `${PLUGIN_SHARED_HELPERS_START}\n` +
      `${snippet.trimEnd()}\n` +
      `${PLUGIN_SHARED_HELPERS_END}`;

    return templateContent.slice(0, startIdx) + replacement + templateContent.slice(afterEnd);
  }

  /**
   * Remove a plugin-file hook target.
   *
   * A file is Myco-owned when it carries the plugin marker OR
   * references a Myco launcher path — the same contract `isConfigured`
   * uses for detection. The two predicates MUST stay symmetric: any
   * file we detect as Myco-wired must also be removable by uninstall,
   * or it leaks across reinstalls.
   *
   * Contributors who hand-edit a plugin file are protected: stripping
   * ALL of (marker, launcher reference) takes the file out of Myco's
   * ownership set and uninstall leaves it alone.
   */
  private uninstallPluginHookFile(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget) return false;

    const targetPath = this.resolveAbsoluteTarget("hooks")!;
    let content: string;
    try { content = fs.readFileSync(targetPath, 'utf-8'); } catch { return false; }

    // A plugin file counts as Myco-owned when it carries the marker
    // or references a Myco launcher path. The launcher-name list
    // lives in `install-helpers.ts` so detection and deletion can't
    // drift apart on a future rename.
    const hasMarker = content.includes(MYCO_PLUGIN_FILE_MARKER);
    if (!hasMarker && !containsMycoLauncherReference(content)) return false;

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
    // Plugin deps package.json is a project-local concept (e.g.
    // opencode's `.opencode/package.json` for Bun-installed deps).
    if (!this.capabilities.pluginPackage) return false;

    const templateContent = this.loadTemplateRaw('package.json');
    if (templateContent === null) return false;

    return this.writeManagedFile(
      path.join(this.projectRoot, reg.pluginPackageTarget),
      templateContent,
    );
  }

  /**
   * Install the plugin-bundle manifest (`plugin.json`) for symbionts
   * whose plugin loader requires a marker file at the bundle root.
   * Antigravity is the canonical case — `~/.gemini/config/plugins/<name>/`
   * is only recognized as a plugin when `plugin.json` is present (per
   * Google's reference plugins `google-antigravity-sdk` and
   * `modern-web-guidance-plugin`, which both ship metadata-only
   * `plugin.json` files alongside their hooks/skills siblings).
   *
   * Resolves the target from `pluginManifestTarget` (project scope) or
   * `globalPluginManifestTarget` (global scope); skips silently when
   * neither is declared (every JSON-merge symbiont).
   */
  private installPluginManifest(): boolean {
    const reg = this.manifest.registration;
    if (!reg) return false;
    const rawTarget = this.installScope === 'global'
      ? reg.globalPluginManifestTarget
      : reg.pluginManifestTarget;
    if (!rawTarget) return false;
    const targetPath = this.installScope === 'global'
      ? expandHome(rawTarget)
      : path.join(this.projectRoot, rawTarget);

    const templateContent = this.loadTemplateRaw('plugin.json');
    if (templateContent === null) return false;

    return this.writeManagedFile(targetPath, templateContent);
  }

  /**
   * Remove the plugin-bundle manifest. Symmetric counterpart to
   * `installPluginManifest()`. Idempotent — silently no-ops when the
   * file doesn't exist or the manifest declares no target.
   */
  private uninstallPluginManifest(): boolean {
    const reg = this.manifest.registration;
    if (!reg) return false;
    const rawTarget = this.installScope === 'global'
      ? reg.globalPluginManifestTarget
      : reg.pluginManifestTarget;
    if (!rawTarget) return false;
    const targetPath = this.installScope === 'global'
      ? expandHome(rawTarget)
      : path.join(this.projectRoot, rawTarget);

    try {
      fs.unlinkSync(targetPath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Merge MCP server template into every MCP target the manifest
   * declares for the active scope. Replaces the `myco` server entry;
   * preserves other servers. Multi-target manifests (Copilot:
   * terminal CLI + VS Code extension) get the identical payload
   * written to every file the schema lists; single-target manifests
   * iterate exactly once.
   *
   * Returns `true` when at least one target accepted the write —
   * preserves the historical boolean contract used by callers like
   * `runFullInstall()` and `isConfigured()`.
   */
  installMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg) return false;

    const targets = this.resolveAbsoluteMcpTargets();
    if (targets.length === 0) return false;

    const template = this.buildMcpTemplate(this.loadTemplate('mcp'));
    if (!template) return false;

    let anyWritten = false;
    for (const target of targets) {
      const written = reg.mcpFormat === 'toml'
        ? this.installMcpToml(target.path, template)
        : this.installMcpJson(target.path, template, target.serversKey);
      if (written) anyWritten = true;
    }
    return anyWritten;
  }

  private buildMcpTemplate(
    template: Record<string, unknown> | null,
  ): Record<string, unknown> | null {
    if (!template) return null;

    const daemonPort = this.resolveDaemonPort();

    return Object.fromEntries(
      Object.entries(template).map(([name, def]) => {
        if (!def || typeof def !== 'object' || Array.isArray(def)) return [name, def];
        const next = this.interpolateMcpTemplate({ ...(def as Record<string, unknown>) }, daemonPort);
        return [name, next];
      }),
    );
  }

  private interpolateMcpTemplate(
    server: Record<string, unknown>,
    daemonPort: number,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(server).map(([key, value]) => [
        key,
        typeof value === 'string'
          ? value.replace(/\{\{daemonPort\}\}/g, String(daemonPort))
          : value,
      ]),
    );
  }

  private resolveDaemonPort(): number {
    const vaultDir = path.join(this.projectRoot, '.myco');
    return resolveDaemonServiceState(vaultDir, { env: process.env }).canonicalPort;
  }

  /**
   * Write MCP servers to a JSON config file under the configured key.
   * Most agents use the canonical `mcpServers`; VS Code's Copilot
   * extension uses `servers`; opencode uses `mcp`.
   *
   * Sweep stale entries first: a `myco` server under any other known
   * MCP-list key (e.g., the previous `mcpServersKey` for this surface)
   * is deleted before the new entry lands under `serversKey`. This is
   * the on-upgrade migration path — without it, renaming a symbiont's
   * server key would leave the old entry behind and produce duplicate
   * (or shape-mismatched) registrations in the agent's MCP picker.
   */
  private installMcpJson(targetPath: string, template: Record<string, unknown>, serversKey: string): boolean {
    const config = readJsonFile(targetPath);

    for (const candidateKey of KNOWN_MCP_SERVERS_KEYS) {
      if (candidateKey === serversKey) continue;
      const candidate = config[candidateKey];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const bag = candidate as Record<string, unknown>;
      if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
      delete bag[MYCO_MCP_SERVER_NAME];
      if (Object.keys(bag).length === 0) delete config[candidateKey];
    }

    const servers = (config[serversKey] ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(template)) {
      servers[name] = def;
    }
    config[serversKey] = servers;
    return writeJsonFile(targetPath, config);
  }

  /** Write MCP servers to a TOML config file. */
  private installMcpToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    for (const [name, def] of Object.entries(template)) {
      raw = buildTomlMcpSection(raw, name, def as Record<string, unknown>);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, raw);
    return true;
  }

  /**
   * Create symlinks for skills through .agents/skills/ canonical layer.
   * Canonical: .agents/skills/<name> -> <packageRoot>/skills/<name>
   * Agent-specific: <skillsTarget>/<name> -> ../../.agents/skills/<name>
   */
  installSkills(): boolean {
    const reg = this.manifest.registration;
    if (this.capabilities.flatSkills) {
      if (!reg?.globalSkillsTarget) return false;
    } else if (!reg?.skillsTarget) {
      return false;
    }

    const skillNames = this.listSkillDirs();
    if (skillNames.length === 0) return false;

    const skillsSrc = path.join(this.packageRoot, SKILLS_SUBDIR);
    const agentSkillsDir = this.resolveAbsoluteTarget("skills")!;

    if (this.capabilities.flatSkills) {
      // No canonical-symlink layer under global scope — the `.agents/skills/`
      // cross-agent dir is a project-local convention. Symlink each skill
      // directly under the agent's globalSkillsTarget.
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      for (const name of skillNames) {
        ensureSymlink(path.join(agentSkillsDir, name), path.join(skillsSrc, name));
      }
      return true;
    }

    this.cleanupLegacySkillSymlinks(skillNames);

    // Create canonical symlinks: .agents/skills/<name> -> package skills
    const canonicalDir = path.join(this.projectRoot, CANONICAL_SKILLS_DIR);
    fs.mkdirSync(canonicalDir, { recursive: true });

    for (const name of skillNames) {
      const canonicalLink = path.join(canonicalDir, name);
      const target = path.join(skillsSrc, name);
      ensureSymlink(canonicalLink, target);
    }

    // Create agent-specific symlinks if skillsTarget differs from canonical
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

    const targetPath = this.resolveAbsoluteTarget("settings");
    // Plugin-file hook targets don't share their file with settings;
    // resolveAbsoluteTarget returns null in that case under global
    // scope so the settings template can't clobber the plugin source.
    if (!targetPath) return false;
    const settingsFormat = reg.settingsFormat ?? 'json';

    if (settingsFormat === 'toml') {
      return this.installSettingsToml(targetPath, template);
    }

    const existing = readJsonFile(targetPath);
    const merged = deepMergeSettings(existing, template);
    return writeJsonFile(targetPath, merged);
  }

  /**
   * Per-symbiont audit file recording the (section, key) pairs Myco actually
   * mutated when writing its settings template. Used at uninstall time to
   * strip only what Myco wrote, never user-pre-existing values that happened
   * to overlap with the template (the data-loss bug the audit closes).
   *
   * Stored under Myco's own state dir so removal of the symbiont's config
   * directory doesn't lose the audit, and one path per (symbiont, scope) so
   * project and global installs track independently.
   */
  private getSettingsAuditPath(): string {
    const stateRoot = this.installScope === 'global' ? resolveMycoHome() : this.vaultDir;
    const scopeTag = this.installScope === 'global' ? 'global' : 'project';
    return path.join(stateRoot, 'installer-audit', `${this.manifest.name}-${scopeTag}-settings.json`);
  }

  /** Read the audit list of section.key entries Myco wrote, or [] if absent. */
  private readSettingsAudit(): string[] {
    const auditPath = this.getSettingsAuditPath();
    try {
      const raw = fs.readFileSync(auditPath, 'utf-8');
      const parsed = JSON.parse(raw) as { wroteKeys?: unknown };
      if (!Array.isArray(parsed.wroteKeys)) return [];
      return parsed.wroteKeys.filter((k): k is string => typeof k === 'string');
    } catch {
      return [];
    }
  }

  /** Persist the audit list. Creates parent dir as needed. */
  private writeSettingsAudit(wroteKeys: string[]): void {
    const auditPath = this.getSettingsAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    atomicWriteFileSync(auditPath, JSON.stringify({ schema: 1, wroteKeys }, null, 2) + '\n');
  }

  /** Remove the audit file after a successful uninstall. */
  private deleteSettingsAudit(): void {
    try { fs.unlinkSync(this.getSettingsAuditPath()); } catch { /* not present */ }
  }

  /**
   * Merge a settings template into a TOML config file.
   *
   * Sibling-safe: only the (section, key) pairs the template declares are
   * touched; any other keys the user has added to a Myco-managed section
   * (e.g. user-added flags under `[features]`) are preserved.
   *
   * Records each key Myco actually mutated in a per-symbiont audit file so
   * uninstall can strip exactly what Myco wrote — never a value the user
   * pre-set that happened to match the template.
   */
  private installSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    const audit = new Set(this.readSettingsAudit());
    const templateKeys = new Set<string>();

    for (const [sectionName, values] of Object.entries(template)) {
      if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
      const sectionValues = values as Record<string, unknown>;

      const mutate: Record<string, unknown> = {};
      for (const [key, templateVal] of Object.entries(sectionValues)) {
        const auditKey = `${sectionName}.${key}`;
        templateKeys.add(auditKey);
        const currentVal = readTomlSectionKey(raw, sectionName, key);
        const equal = currentVal !== undefined && String(currentVal) === String(templateVal);
        if (!equal) {
          mutate[key] = templateVal;
          audit.add(auditKey);
        }
        // If the value already matches but we previously recorded ownership,
        // keep the audit entry so uninstall still strips on Myco's behalf.
      }

      if (Object.keys(mutate).length > 0) {
        raw = upsertTomlSectionKeys(raw, sectionName, mutate);
      }
    }

    // Sweep stale audit entries — keys Myco used to own but the current
    // template no longer claims (e.g. a template-rename migration). Strip
    // the value from the file and drop the audit record so uninstall stays
    // consistent with the live template surface.
    const staleEntries = Array.from(audit).filter((e) => !templateKeys.has(e));
    if (staleEntries.length > 0) {
      const bySection = new Map<string, string[]>();
      for (const entry of staleEntries) {
        const dot = entry.indexOf('.');
        if (dot < 0) continue;
        const section = entry.slice(0, dot);
        const key = entry.slice(dot + 1);
        const bucket = bySection.get(section) ?? [];
        bucket.push(key);
        bySection.set(section, bucket);
      }
      for (const [section, keys] of bySection) {
        raw = removeTomlSectionKeys(raw, section, keys);
      }
      for (const entry of staleEntries) audit.delete(entry);
    }

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, raw);
    this.writeSettingsAudit(Array.from(audit).sort());
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

    const targetPath = this.resolveAbsoluteTarget("settings");
    if (!targetPath) return false;
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
   * Remove Myco-owned keys from a TOML settings file.
   *
   * Consults the per-symbiont audit recorded at install time; only keys Myco
   * actually wrote are stripped. Without an audit (no recorded Myco install)
   * the uninstall is a no-op — protecting any user value that pre-dated Myco
   * and happened to overlap with the template. Deletes the file entirely if
   * no TOML content remains, and clears the audit on success.
   */
  private uninstallSettingsToml(targetPath: string, template: Record<string, unknown>): boolean {
    const audit = this.readSettingsAudit();
    if (audit.length === 0) return false;

    let raw = '';
    try { raw = fs.readFileSync(targetPath, 'utf-8'); } catch { /* file gone — clear audit below */ }

    // Only strip audit entries whose section is actually declared by the
    // current template. This guards against a stale audit from a previous
    // template version naming a section the manifest no longer manages.
    const templateSections = new Set<string>();
    for (const [sectionName, values] of Object.entries(template)) {
      if (values && typeof values === 'object' && !Array.isArray(values)) {
        templateSections.add(sectionName);
      }
    }

    const bySection = new Map<string, string[]>();
    for (const entry of audit) {
      const dot = entry.indexOf('.');
      if (dot < 0) continue;
      const section = entry.slice(0, dot);
      const key = entry.slice(dot + 1);
      if (!templateSections.has(section)) continue;
      const bucket = bySection.get(section) ?? [];
      bucket.push(key);
      bySection.set(section, bucket);
    }

    let changed = false;
    for (const [sectionName, keys] of bySection) {
      const next = removeTomlSectionKeys(raw, sectionName, keys);
      if (next !== raw) {
        raw = next;
        changed = true;
      }
    }

    if (changed) {
      if (!raw.trim()) {
        try { fs.unlinkSync(targetPath); } catch { /* ignore */ }
      } else {
        atomicWriteFileSync(targetPath, raw);
      }
    }

    this.deleteSettingsAudit();
    return changed;
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

    const targetPath = this.resolveAbsoluteTarget("hooks")!;
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

  /**
   * Remove the Myco MCP server entry from every MCP target the manifest
   * declares for the active scope. Multi-target manifests (Copilot) get
   * the uninstall applied to every file the schema lists; single-target
   * manifests iterate exactly once. Returns `true` when at least one
   * target had a Myco entry to remove.
   */
  uninstallMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg) return false;

    const targets = this.resolveAbsoluteMcpTargets();
    if (targets.length === 0) return false;

    let anyRemoved = false;
    for (const target of targets) {
      const removed = reg.mcpFormat === 'toml'
        ? this.uninstallMcpToml(target.path)
        : this.uninstallMcpJson(target.path, target.serversKey);
      if (removed) anyRemoved = true;
    }
    return anyRemoved;
  }

  private uninstallMcpJson(targetPath: string, serversKey: string): boolean {
    const config = readJsonFile(targetPath);

    // Sweep every known MCP-list key (the configured one plus any
    // legacy shape this surface may carry from a previous install
    // under a different `serversKey`). Without the sweep, renaming a
    // symbiont's server-key field would leave the old entry behind.
    // The `serversKey` argument is included in the sweep — it's just
    // the primary target — so this remains the canonical uninstall
    // path for both single-key and post-migration files.
    const candidateKeys = Array.from(new Set([serversKey, ...KNOWN_MCP_SERVERS_KEYS]));

    let removed = false;
    for (const key of candidateKeys) {
      const bag = config[key];
      if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue;
      const servers = bag as Record<string, unknown>;
      if (!(MYCO_MCP_SERVER_NAME in servers)) continue;
      delete servers[MYCO_MCP_SERVER_NAME];
      if (Object.keys(servers).length === 0) {
        delete config[key];
      } else {
        config[key] = servers;
      }
      removed = true;
    }

    if (!removed) return false;
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
      atomicWriteFileSync(targetPath, updated + "\n");
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
        const link = path.join(this.resolveAbsoluteTarget("skills")!, name);
        try { fs.unlinkSync(link); removed = true; } catch { /* doesn't exist */ }
      }
      // Remove agent skills dir if now empty (rmdirSync fails atomically if non-empty)
      try { fs.rmdirSync(this.resolveAbsoluteTarget("skills")!); } catch { /* not empty or missing */ }
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
 * Active project-shared launchers written by `installHookGuard`. Shared
 * by every symbiont in the project — single-symbiont uninstall must
 * not remove them.
 */
const ACTIVE_PROJECT_LAUNCHERS = [
  HOOK_GUARD_PROJECT_PATH,
  CLI_LAUNCHER_PROJECT_PATH,
] as const;

/** Retired launcher artifact — always safe to remove when found. */
const LEGACY_PROJECT_LAUNCHERS = [LEGACY_HOOK_GUARD_PATH] as const;

/** Project-relative path of the runtime-binary pin written by `make dev-link`. */
const PROJECT_RUNTIME_COMMAND_PATH = path.join('.myco', 'runtime.command');

/**
 * Selection knobs for `removeProjectLaunchers`. The walker uses
 * `legacy: true, active: !optIn, runtimeCommand: !optIn` so it can
 * always clean retired artifacts while honoring the project-local
 * opt-in for active launchers + dev pin. `myco remove` opts into all
 * three.
 */
export interface RemoveProjectLaunchersOptions {
  /** Remove the retired `.agents/myco-hook.cjs` guard. Default: true. */
  legacy?: boolean;
  /** Remove active project launchers (`myco-run.cjs`, `myco-cli.cjs`). Default: true. */
  active?: boolean;
  /** Remove `.myco/runtime.command` (the dev pin / opt-in surface). Default: false. */
  runtimeCommand?: boolean;
}

/**
 * Remove project-shared launcher artifacts. Returns the project-
 * relative paths that were actually unlinked. ENOENT is silent (the
 * common "nothing to remove" case); any other error is logged and
 * skipped so a stuck file on one path doesn't abort cleanup of the
 * rest — the caller's audit log surfaces aggregate state via the
 * returned list.
 *
 * Project-level operation: per-symbiont uninstall must not call
 * this. Walker and `myco remove` are the canonical callers.
 */
export function removeProjectLaunchers(
  projectRoot: string,
  options: RemoveProjectLaunchersOptions = {},
): string[] {
  const { legacy = true, active = true, runtimeCommand = false } = options;
  const targets: string[] = [];
  if (active) targets.push(...ACTIVE_PROJECT_LAUNCHERS);
  if (legacy) targets.push(...LEGACY_PROJECT_LAUNCHERS);
  if (runtimeCommand) targets.push(PROJECT_RUNTIME_COMMAND_PATH);

  const removed: string[] = [];
  for (const rel of targets) {
    try {
      fs.unlinkSync(path.join(projectRoot, rel));
      removed.push(rel);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') continue;
      // eslint-disable-next-line no-console
      console.error(`  ⚠ Could not remove ${rel}: ${(err as Error).message}`);
    }
  }
  return removed;
}

/**
 * Create or remove agent-specific symlinks for a skill in
 * `.agents/skills/<name>`.
 *
 * Reads all symbiont manifests to find skillsTarget paths that differ
 * from the canonical `.agents/skills/` directory, then creates relative
 * symlinks from each target to the canonical location. With
 * `opts.remove: true`, deletes those symlinks instead. Called by
 * vault_write_skill after writing a generated skill to disk.
 */
export function syncSkillSymlinks(
  projectRoot: string,
  skillName: string,
  opts?: { remove?: boolean },
): void {
  // Filesystem-safety gate: skillName flows into linkPath / unlinkSync
  // and (during create) into the symlink target string. A peer-supplied
  // name like `../../etc` would otherwise place a symlink outside the
  // agent's skills dir (or, on remove, unlink an arbitrary same-name
  // file). Keep the rule identical to the API-layer gate in
  // `daemon/api/skills.ts` so both paths reject the same set.
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(skillName)) return;

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
