import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { expandHome, resolveMycoHome } from '../grove/paths.js';
import { shouldDeferSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '../grove/subsystem-claim.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSection, upsertTomlSectionKeys, removeTomlSectionKeys, readTomlSectionKey } from './toml-helpers.js';
import {
  deepMergeSettings,
  deepMergeSettingsWithAudit,
  deepRemoveSettings,
  emptyJsonAudit,
  removeAuditedSettings,
  type JsonSettingsAudit,
} from './settings-merge.js';
import { manifestToolTransport } from './capabilities.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { ensureAgentsMd, ensureSymlink, isMycoHookGroup, containsMycoLauncherReference, hasMycoManagedMarker, MYCO_MANAGED_MARKER } from './install-helpers.js';
import { resolveRuntimeCommand, resolveRuntimeHome } from '../daemon/update-checker.js';
import { managedBinaryPath, managedSkillsDir } from '../install/managed-binary.js';
import { loadMergedConfig } from '../config/loader.js';
import { BUNDLED_TEMPLATES } from './templates.generated.js';
import { BUNDLED_SKILLS } from './skills.generated.js';
import {
  CANONICAL_SKILLS_DIR,
  CLI_LAUNCHER_PROJECT_PATH,
  HOOK_GUARD_PROJECT_PATH,
  LEGACY_BUILTIN_SKILL_NAMES,
  LEGACY_HOOK_GUARD_PATH,
  ensureLocalSkillsGitignore,
  reconcileProjectSkillSymlinks,
  removeProjectLaunchers,
} from './installer/project-files.js';
export {
  removeProjectLaunchers,
  syncSkillSymlinks,
  type RemoveProjectLaunchersOptions,
} from './installer/project-files.js';

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
- When orienting in this codebase — finding a feature, locating files relevant to a change, or understanding an unfamiliar subsystem — use Myco first: call \`myco tool call myco_cortex --json --input '{"op":"canopy_map"}'\` as the CLI path, or \`myco_cortex({"op":"canopy_map"})\` via MCP when the host exposes Myco tools cleanly, before falling back to Glob/Grep.
${AGENTS_MANAGED_END}
`;

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Filename of the hook guard template in the templates directory. */
const HOOK_GUARD_TEMPLATE_FILENAME = 'myco-run.cjs';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

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
 * install time. Resolves to a direct invocation of the self-contained Myco
 * binary that handles hooks — no `node`, no `.cjs` trampoline:
 *
 *     <binaryPath> hook <event> --symbiont <agent>
 *
 * The binary path comes from the machine `runtime.command` pin
 * (`resolveRuntimeCommand()`), falling back to `process.execPath` — the
 * running compiled binary, since the installer executes in-daemon. The
 * `--myco-managed` ownership marker is appended by `substituteMycoLauncher`,
 * not baked into the placeholder, so it lands exactly once per command.
 *
 * Centralizing the placeholder here means a single edit rewrites every hook
 * in every template. The legacy "global install writes project-local
 * launcher path into a global file" bug class is impossible once every
 * template path runs through this substitution.
 */
const MYCO_LAUNCHER_PLACEHOLDER = '{{mycoLauncher}}';

/**
 * Placeholder substituted into every MCP template's command field at install
 * time. Resolves to the forward-slashed path of the self-contained Myco binary
 * — the same resolution hooks use (`resolveManagedBinaryPath`). The MCP server
 * is launched as `<binaryPath> mcp`, so a native Windows agent with no `node`
 * on PATH can still spawn the bridge — the gap the `myco-run` node shim left.
 *
 * Unlike the hook placeholder, no `--myco-managed` marker is appended: MCP
 * ownership is keyed by the `myco` server name (see `installMcpJson`'s sweep).
 * The command updates on a genuine binary change but the write is idempotent —
 * `installMcpJson`/`installMcpToml` skip the file entirely when the entry already
 * matches, so the hourly detection tick never churns a config the agent owns.
 */
const MYCO_BINARY_PLACEHOLDER = '{{mycoBinary}}';

/**
 * Resolve `{{mycoLauncher}}` to a direct binary invocation. `binaryPath` is
 * the forward-slashed path to the Myco binary the emitted hook command should
 * exec.
 *
 * The path is emitted UNQUOTED. Symbionts diverge in how they spawn hook
 * commands: claude-code / codex / antigravity / copilot route through a shell,
 * while cursor / windsurf / pi spawn the command via direct argv split. A
 * quoted path survives the shell flavor (quotes get stripped) but breaks
 * direct-argv: the literal `"` characters end up in the binary-path argument
 * and the exec fails to find a file at `'"/opt/.../myco"'`. Unquoted works in
 * both worlds — provided the path has no whitespace, which
 * `assertSafeBinaryPathForUnquoted` enforces at install time.
 *
 * The launcher command is scope-independent now: the binary path is the same
 * whether installed project- or globally. Project-local install was retired in
 * #385 — the project scope survives only for the marker-bounded strip and
 * `.gitignore` reconciliation — so the dead `node .agents/myco-run.cjs` branch
 * is gone and both scopes resolve to the binary path.
 */
function resolveLauncherCmd(_scope: InstallScope, binaryPath: string): string {
  assertSafeBinaryPathForUnquoted(binaryPath);
  return binaryPath;
}

/**
 * Resolve the path to the managed Myco binary the installer should embed into
 * emitted commands (hook commands and the MCP server command alike).
 *
 * Resolved via the layered order documented below; forward-slashed so the
 * unquoted command is safe for bash, argv-split, and cmd alike on every
 * platform.
 *
 * Shared by the hook path (`substituteMycoLauncher`) and the MCP path
 * (`resolveMcpTemplate`) so the two can't drift onto different binaries.
 *
 * Resolve order (coexistence fix — field incident 2026-06-17):
 *   1. Machine `runtime.command` pin — explicit operator intent; always wins.
 *   2. Converged managed binary (`~/.myco/bin/myco`) when it exists on disk —
 *      writes a daemon-agnostic path so a dev daemon holding the
 *      symbiont-config claim never embeds its own dev `process.execPath` into
 *      the GLOBAL `~/.claude/settings.json` hooks.
 *   3. `process.execPath` — last resort, pre-convergence only (managed binary
 *      not yet installed).
 *
 * There is intentionally NO dev-variant guard here (contrast: Task 4's
 * `defaultServiceExecutable`). Per-project dogfood routing is the
 * `runtime.command` pin's job; this path must remain daemon-agnostic.
 */
export function resolveManagedBinaryPath(
  mycoHome: string = resolveMycoHome(),
  platform: NodeJS.Platform = process.platform,
): string {
  const pin = resolveRuntimeCommand();
  if (pin) return pin.replaceAll('\\', '/');
  const managed = managedBinaryPath(mycoHome, platform, process.env.LOCALAPPDATA);
  if (fs.existsSync(managed)) return managed.replaceAll('\\', '/');
  return process.execPath.replaceAll('\\', '/');
}

/**
 * Refuse to emit a hook command whose binary path contains whitespace.
 * Quoting would survive shell symbionts but break direct-argv symbionts
 * (cursor / windsurf / pi). Failing loudly at install time beats silent
 * capture failure after the agent's next launch.
 */
function assertSafeBinaryPathForUnquoted(binaryPath: string): void {
  if (!/\s/.test(binaryPath)) return;
  throw new Error(
    `Refusing to install symbiont hooks: binary path "${binaryPath}" ` +
    `contains whitespace, which breaks direct-argv hook spawn for cursor / windsurf / pi. ` +
    `Move Myco out of a path with spaces.`,
  );
}

/**
 * Whether a raw config file carries any Myco hook-ownership signal — either
 * the `--myco-managed` marker (direct-binary form, whose binary path varies
 * by build) or a canonical launcher-path reference (legacy/global launcher).
 * Used by `isConfigured()` for the non-strict-JSON detection paths (Codex's
 * TOML-footer hooks.json, antigravity's JSON plugin-file) where a structured
 * group walk isn't possible.
 */
function rawHasMycoOwnershipSignal(raw: string): boolean {
  return hasMycoManagedMarker(raw) || containsMycoLauncherReference(raw);
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

function emptyInstallResult(): InstallResult {
  return {
    hooks: false,
    mcp: false,
    skills: false,
    settings: false,
    instructions: false,
    pluginPackage: false,
    pluginManifest: false,
  };
}

export interface ManagedProjectFilesResult {
  /**
   * Root rules file with Myco's managed guidance block. This is project-local
   * even under global install because agents read it from the repository.
   */
  agentsMd: boolean;
  /**
   * Repository .gitignore entries for Myco-managed local artifacts.
   */
  gitignore: boolean;
  /**
   * Count of agent skill symlinks created + pruned this pass (e.g.
   * `.claude/skills/<name>` → `.agents/skills/<name>`). Non-zero whenever the
   * reconcile healed missing links or cleaned stale/retired ones.
   */
  skillSymlinks: number;
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
      // Settings under global scope must be EXPLICIT — no silent fallback.
      //
      // Historically, an undefined `globalSettingsTarget` fell back to
      // `globalHooksTarget`, merging the settings template into the hooks
      // file. That works for agents whose hooks file is a multi-key
      // settings document (Claude Code, Copilot, Cursor) but silently
      // breaks strict-schema agents like Windsurf — Cascade rejects the
      // entire hooks file when an unknown root key appears, disabling
      // every hook command. /code-review finding C9.
      //
      // The new rule: a manifest with a non-empty settings template must
      // declare globalSettingsTarget explicitly:
      //   - a string path → write settings there (may equal
      //     globalHooksTarget when the agent's hooks file accepts the
      //     extra keys; Claude Code's settings.json is the canonical case)
      //   - explicit `null`            → skip settings install entirely
      // Undefined returns null here — the global installer will skip
      // settings without surprising the manifest author. Project-scope
      // installs are unaffected (settingsTarget stays as-declared).
      const target = field === 'hooks' ? reg.globalHooksTarget
        : field === 'skills' ? reg.globalSkillsTarget
        : (reg.globalSettingsTarget ?? null);
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
    // fall through to the ownership-signal scan below.
    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) {
      if (raw.includes(MYCO_PLUGIN_FILE_MARKER)) return true;
      return rawHasMycoOwnershipSignal(raw);
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
    return rawHasMycoOwnershipSignal(raw);
  }

  /**
   * Detection gate for the global install. Returns false when the agent
   * isn't installed on this machine (its declared `detectionDir` is
   * absent) — the installer should silently skip rather than create the
   * agent's config dir on its behalf (Decision 7's "never create the
   * agent's dir" rule).
   *
   * Always returns true for `installScope: 'project'` — the detection
   * gate only applies to global installs, where the agent's user-level
   * config dir must already exist before Myco writes into it.
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
    // half-written.
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
   * The MCP server spawns the resolved binary directly (`<binary> mcp`),
   * not a launcher shim — see `loadMcpTemplate`.
   * Returns true if any file was written (or updated); false if skipped
   * or N/A.
   */
  installHookGuard(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.hooksTarget && !this.capabilities.globalLauncher) return false;

    if (this.capabilities.globalLauncher) {
      // The binary is the launcher now — every hook command invokes it directly,
      // so there is no trampoline guard to install. Retired launcher cleanup is
      // NOT done here: deleting the shared `~/.myco/launcher.cjs` on the first
      // symbiont's install would orphan the still-old configs of every symbiont
      // not yet rewritten in this pass (a capture-loss window). The orchestrating
      // flows (bootstrap / `myco update` / the detection tick) call
      // `removeRetiredGlobalLaunchers()` once, AFTER every config is rewritten.
      return false;
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

  /**
   * Load the MCP template and substitute the `{{mycoBinary}}` placeholder with
   * the resolved managed binary path. Returns null when the symbiont ships no
   * MCP template.
   *
   * Both MCP install paths — the unbatched `installMcp()` and the batched-JSON
   * `installBatchedJson()` — go through this single helper so they can't drift
   * onto a stale `myco-run` shim or a different binary. The walk mirrors
   * `resolveHookTemplatePlaceholders` but for the MCP placeholder: it descends
   * into arrays (opencode's `command: ["{{mycoBinary}}", "mcp"]`) and nested
   * objects, replacing the placeholder in every string value.
   */
  loadMcpTemplate(): Record<string, unknown> | null {
    const template = this.loadTemplate('mcp');
    if (!template) return null;
    const binaryPath = resolveManagedBinaryPath();
    const substitute = (value: unknown): unknown => {
      if (typeof value === 'string') {
        return value.split(MYCO_BINARY_PLACEHOLDER).join(binaryPath);
      }
      if (Array.isArray(value)) return value.map(substitute);
      if (value && typeof value === 'object') {
        return Object.fromEntries(
          Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, substitute(v)]),
        );
      }
      return value;
    };
    const resolved = substitute(template) as Record<string, unknown>;
    this.injectMcpHomeEnv(resolved);
    return resolved;
  }

  /**
   * Inject `MYCO_HOME` into each MCP server entry's `env` when a `runtime.home`
   * pin redirects this project to a non-default daemon home (e.g. a dogfood
   * `~/.myco-dev`). The MCP server is exec'd directly by the host agent as
   * `<binary> mcp`; the self-contained binary's entry does NOT run the
   * `runtime-redirect.cjs` shim, so without this the MCP server binds to the
   * prod home and a dev-pinned project's tools hit the wrong daemon.
   *
   * No pin → no injection: the daemon-agnostic prod default (see
   * `resolveManagedBinaryPath`) is preserved so a global config never embeds a
   * dev home. Mirrors the CLI/hook redirect: same layered pin, same trust check.
   */
  private injectMcpHomeEnv(servers: Record<string, unknown>): void {
    const home = resolveRuntimeHome(this.vaultDir);
    if (!home) return;
    for (const entry of Object.values(servers)) {
      if (!entry || typeof entry !== 'object') continue;
      const server = entry as Record<string, unknown>;
      const env = (server.env && typeof server.env === 'object')
        ? (server.env as Record<string, unknown>)
        : {};
      env.MYCO_HOME = home;
      server.env = env;
    }
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

  /**
   * True when this is a global-scope write and a peer owns the symbiont-config
   * claim. The single deferral gate shared by install() and uninstall() so a
   * non-owner never mutates the machine-shared agent config — expressed once,
   * not copied per entry point.
   */
  private deferGlobalSymbiontConfig(): boolean {
    return this.installScope === 'global' && shouldDeferSubsystem(SYMBIONT_CONFIG_SUBSYSTEM);
  }

  /** Run all registration steps. */
  install(): InstallResult {
    if (this.deferGlobalSymbiontConfig()) return emptyInstallResult();
    const reg = this.manifest.registration;
    if (this.capabilities.detectionGate && !this.isAvailableForScope()) {
      // Agent isn't installed on this machine — skip silently, never
      // create the agent's config dir on its behalf.
      return emptyInstallResult();
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

  private reconcileAgentsMd(): boolean {
    ensureAgentsMd(this.projectRoot);
    const agentsPath = path.join(this.projectRoot, 'AGENTS.md');
    let content = '';
    try {
      content = fs.readFileSync(agentsPath, 'utf-8');
    } catch {
      return false;
    }

    const stripped = this.stripManagedAgentsBlock(content);
    const separator = stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : '';
    const spacer = stripped.trimEnd().length > 0 ? '\n' : '';
    const result = `${stripped}${separator}${spacer}${AGENTS_MANAGED_BLOCK}`;
    if (result === content) return false;
    fs.writeFileSync(agentsPath, result, 'utf-8');
    return true;
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
    // Capture the on-disk structure up front so we can skip the write entirely
    // when our transforms produce no change — otherwise the hourly detection
    // tick would reformat a config the agent actively owns (claude-code's
    // ~/.claude/settings.json, where hooks + MCP + settings colocate) on every
    // pass just because its JSON style differs from ours. Same idempotency the
    // standalone installMcpJson/installPluginHookFile paths already have.
    const original = readJsonFile(targetPath);
    let data = structuredClone(original);
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
      // Ownership identity rides on the embedded launcher path — see
      // `isMycoHookGroup`. Reinstall strips by launcher-path match, so
      // no parallel `_meta` marker is needed (and would break strict-
      // schema agents like Windsurf).
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
    const provision = this.shouldProvisionMcpServer();
    const mcpTemplate = reg.mcpTarget && provision ? this.loadMcpTemplate() : null;
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
    } else if (reg.mcpTarget && !provision) {
      // cli-transport symbionts get NO MCP server here. Sweep any existing
      // `myco` entry across every known server-list key (mirrors the
      // installMcp → uninstallMcp sweep) so a JSON-colocated cli symbiont
      // doesn't silently retain an MCP registration. `mcp` stays false.
      const serversKey = reg.mcpServersKey ?? 'mcpServers';
      for (const candidateKey of new Set([serversKey, ...KNOWN_MCP_SERVERS_KEYS])) {
        const candidate = data[candidateKey];
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
        const bag = candidate as Record<string, unknown>;
        if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
        delete bag[MYCO_MCP_SERVER_NAME];
        if (Object.keys(bag).length === 0) delete data[candidateKey];
      }
    }

    // Apply settings transform with audit-tracking. Same discipline as
    // `installSettings` — uninstall must be able to strip only what
    // Myco wrote, never user-pre-existing values that overlap the
    // template.
    const settingsTemplate = reg.settingsTarget ? this.loadTemplate('settings') : null;
    if (settingsTemplate) {
      const audit = emptyJsonAudit();
      data = deepMergeSettingsWithAudit(data, settingsTemplate, audit);
      if (audit.scalars.length > 0 || audit.arrayEntries.length > 0) {
        this.writeJsonSettingsAudit(audit);
      }
      settings = true;
    }

    if (!isDeepStrictEqual(data, original)) writeJsonFile(targetPath, data);

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
    if (this.deferGlobalSymbiontConfig()) return emptyInstallResult();
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

    // Remove settings — audit-track path. Same precedence as the
    // unbatched uninstall: use the JSON audit when present, fall back
    // to value-match `deepRemoveSettings` for legacy installs.
    const settingsTemplate = reg.settingsTarget ? this.loadTemplate('settings') : null;
    if (settingsTemplate) {
      const audit = this.readJsonSettingsAudit();
      settings = audit
        ? removeAuditedSettings(data, audit)
        : deepRemoveSettings(data, settingsTemplate);
      if (settings && audit) this.deleteSettingsAudit();
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

  /**
   * Directory the install sources skills from.
   *
   * Global scope reads the managed `<mycoHome>/skills` (seeded from the
   * binary-embedded bundle by `ensureManagedSkills`) — a stable target divorced
   * from any checkout, which is what lets global links survive a checkout
   * deletion and self-heal. The managed daemon binary has no `skills/` under its
   * own root (`resolvePackageRoot()` falls to `cwd=/`), so sourcing from
   * `packageRoot` here was a silent no-op for every native/curl install.
   *
   * Project scope keeps sourcing from the package root — a real project install
   * (npm CLI / in-repo checkout) ships its skills under `<packageRoot>/skills`.
   */
  private skillsSourceDir(): string {
    return this.installScope === 'global'
      ? managedSkillsDir(resolveMycoHome())
      : path.join(this.packageRoot, SKILLS_SUBDIR);
  }

  /** List skill directory names from the skills source dir. Returns empty array if not found. */
  private listSkillDirs(): string[] {
    try {
      const skillsRoot = this.skillsSourceDir();
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
   * Skill names Myco owns in GLOBAL (flatSkills) scope: the current embedded
   * bundle plus retired built-in names. Derived from the binary, NOT from the
   * materialized `<mycoHome>/skills` dir — so uninstall/cleanup work even when
   * that dir was never seeded (e.g. `myco remove` right after an upgrade, before
   * any detection tick). This is the global counterpart to the project-scope
   * `currentSkillNames ∪ LEGACY_BUILTIN_SKILL_NAMES` used by
   * `cleanupLegacySkillSymlinks`.
   */
  private mycoOwnedGlobalSkillNames(): readonly string[] {
    return [...new Set([...Object.keys(BUNDLED_SKILLS), ...LEGACY_BUILTIN_SKILL_NAMES])];
  }

  /**
   * Remove Myco-owned skill symlinks (by `names`) from `dir`. Only symlinks are
   * unlinked — a real file/dir under the same name is user content, and other
   * sources' skills (different names) are never touched. Returns true if any
   * link was removed.
   */
  private removeMycoSkillLinks(dir: string, names: Iterable<string>): boolean {
    let removed = false;
    for (const name of names) {
      const link = path.join(dir, name);
      try {
        if (fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); removed = true; }
      } catch { /* absent, or real content — leave it */ }
    }
    return removed;
  }

  /** ensureSymlink + the standard "kept user content" warning. */
  private linkOrWarn(linkPath: string, target: string): void {
    if (ensureSymlink(linkPath, target) === 'kept-real-path') {
      process.stderr.write(`[myco] Skipped skill link '${path.basename(linkPath)}' — a real file or directory occupies ${linkPath}\n`);
    }
  }

  /**
   * Sweep Myco's package-skill symlinks from this agent's RETIRED global skill
   * dirs (`retiredGlobalSkillsTargets`) — dirs it was installed into before its
   * `globalSkillsTarget` moved (e.g. consolidating on `~/.agents/skills`). The
   * agent reads the new target now; the old links are unread cruft (often
   * dangling into a deleted checkout). Removes current AND legacy names so a
   * retired `~/.codex/skills/{myco,myco-curate,rules}` is fully cleaned. Public
   * so the detection chokepoint can call it for EVERY manifest (not only
   * detected ones — a retired link can outlive the agent's detectionDir).
   */
  sweepRetiredGlobalSkills(): void {
    const targets = this.manifest.registration?.retiredGlobalSkillsTargets ?? [];
    const owned = this.mycoOwnedGlobalSkillNames();
    for (const target of targets) {
      this.removeMycoSkillLinks(expandHome(target), owned);
    }
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
  reconcileProjectGitignore(): boolean {
    return this.updateGitignore();
  }

  /**
   * Reconcile project-local files Myco owns under the global-install model.
   * This is the project-content counterpart to global symbiont install:
   * `myco update` must refresh managed repository files, but it must not
   * recreate project-local launchers or write agent config under the repo.
   *
   * Add future project-managed files here so update/bootstrap code has a
   * single durable surface to call instead of growing one-off reconciler hooks.
   */
  reconcileManagedProjectFiles(): ManagedProjectFilesResult {
    const agentsMd = this.reconcileAgentsMd();
    const gitignore = this.updateGitignore();
    // Reconcile this project's generated-skill symlinks: create missing links
    // into machine-detected, non-opted-out agents and prune stale/retired ones.
    // Symbiont-agnostic free function — it must NOT read `this.manifest`, which
    // is an arbitrary `manifests[0]` for this project-files reconcile. Isolated
    // in try/catch so a symlink-FS failure can't abort the AGENTS.md/.gitignore
    // reconcile above.
    let skillSymlinks = 0;
    try {
      const { created, pruned } = reconcileProjectSkillSymlinks(this.projectRoot, {
        vaultDir: this.vaultDir,
        groveId: this.groveId,
      });
      skillSymlinks = created + pruned;
    } catch (err) {
      console.warn(
        `[reconcileManagedProjectFiles] skill symlink reconcile failed for ${this.projectRoot}:`,
        err instanceof Error ? err.message : err,
      );
    }
    return { agentsMd, gitignore, skillSymlinks };
  }

  /**
   * Narrow compatibility wrapper for callers that only care about AGENTS.md.
   */
  reconcileAgentsManagedGuidance(): boolean {
    return this.reconcileAgentsMd();
  }

  /**
   * Reconcile Myco-owned skill entries in project .gitignore.
   * Computes the desired entry set, strips any existing Myco block
   * (and legacy entries), then writes the current block if changed.
   */
  private updateGitignore(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.skillsTarget) return false;

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
    if (stripped === content && desiredBlock === '') return false;
    const separator = stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : '';
    const spacer = stripped.length > 0 && desiredBlock.length > 0 ? '\n' : '';
    const result = stripped + separator + spacer + desiredBlock;
    if (result === content) return false;

    fs.writeFileSync(gitignorePath, result, 'utf-8');
    return true;
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

    // Add template hooks. Ownership identity rides on the embedded
    // launcher path (see `isMycoHookGroup`), so the strip step on
    // reinstall finds these by command-substring. No `_meta` marker is
    // injected — that broke strict-schema agents (Windsurf) that
    // silently reject hook entries with unknown fields.
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
   * path go through this — one source of truth for launcher resolution
   * means the two install paths can't drift apart.
   *
   * The placeholder appears ONLY in hook command strings, so each call
   * receives exactly one command. After substituting the binary path, the
   * `--myco-managed` ownership marker is appended once to the END of the
   * command — the single place it's added, so templates stay marker-free
   * and the marker lands exactly once regardless of any command prefix
   * (e.g. cursor's `cd ... &&`).
   */
  private substituteMycoLauncher(content: string): string {
    if (!content.includes(MYCO_LAUNCHER_PLACEHOLDER)) return content;
    const binaryPath = resolveManagedBinaryPath();
    const launcherCmd = resolveLauncherCmd(this.installScope, binaryPath);
    const substituted = content.split(MYCO_LAUNCHER_PLACEHOLDER).join(launcherCmd);
    if (substituted.includes(MYCO_MANAGED_MARKER)) return substituted;
    return `${substituted} ${MYCO_MANAGED_MARKER}`;
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

    // A plugin file counts as Myco-owned when it carries the plugin-file
    // marker comment, the `--myco-managed` hook marker, or a Myco launcher
    // path. The signal definitions live in `install-helpers.ts` /
    // `rawHasMycoOwnershipSignal` so detection and deletion can't drift
    // apart on a future rename. Mirrors `isConfigured()`'s plugin-file
    // branch so install/uninstall agree on ownership.
    const hasMarker = content.includes(MYCO_PLUGIN_FILE_MARKER);
    if (!hasMarker && !rawHasMycoOwnershipSignal(content)) return false;

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
   * Remove the plugin deps package.json (project-scope) only when it is
   * pristine — no top-level keys or dependencies beyond what the template
   * writes. A contributor-edited file is preserved. Not part of
   * `uninstall()` (which always keeps the file); the global-install
   * migration calls this to clear the orphan after stripping the plugin.
   * Returns true if the file was removed.
   */
  removeManagedPluginPackage(): boolean {
    const reg = this.manifest.registration;
    if (!reg?.pluginPackageTarget || !this.capabilities.pluginPackage) return false;
    const abs = path.join(this.projectRoot, reg.pluginPackageTarget);
    if (!fs.existsSync(abs)) return false;
    const templateRaw = this.loadTemplateRaw('package.json');
    if (templateRaw === null) return false;
    let project: Record<string, unknown>;
    let template: Record<string, unknown>;
    try {
      project = JSON.parse(fs.readFileSync(abs, 'utf-8'));
      template = JSON.parse(templateRaw);
    } catch {
      return false;
    }
    if (!isPristineManagedPackage(project, template)) return false;
    try {
      fs.unlinkSync(abs);
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
  /** Whether this symbiont should have a Myco MCP server provisioned. cli-transport
   *  symbionts call tools via `myco tool call` on their shell and get none. */
  private shouldProvisionMcpServer(): boolean {
    return manifestToolTransport(this.manifest) !== 'cli';
  }

  installMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg) return false;

    // cli-transport symbionts call Myco tools via `myco tool call` on their
    // shell (which carries tenancy from cwd), so they get NO MCP server. Sweep
    // any pre-existing [mcp_servers.myco] under the active scope so a `myco
    // update` (which runs at GLOBAL scope) removes the broken legacy_vault
    // surface from ~/.codex/config.toml left by older installs.
    if (!this.shouldProvisionMcpServer()) {
      this.uninstallMcp();
      return false;
    }

    const targets = this.resolveAbsoluteMcpTargets();
    if (targets.length === 0) return false;

    const template = this.loadMcpTemplate();
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

    // Idempotency: only touch the file when myco's own entry actually needs to
    // change (missing, drifted, or duplicated under a stale key). Otherwise the
    // hourly detection tick would round-trip read → re-serialize → write and
    // reformat a config the agent actively owns (e.g. ~/.claude/settings.json),
    // churning it on every pass purely because our JSON style differs. `changed`
    // gates the write; a structurally-identical entry is a no-op.
    let changed = false;

    for (const candidateKey of KNOWN_MCP_SERVERS_KEYS) {
      if (candidateKey === serversKey) continue;
      const candidate = config[candidateKey];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const bag = candidate as Record<string, unknown>;
      if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
      delete bag[MYCO_MCP_SERVER_NAME];
      if (Object.keys(bag).length === 0) delete config[candidateKey];
      changed = true;
    }

    const servers = (config[serversKey] ?? {}) as Record<string, unknown>;
    for (const [name, def] of Object.entries(template)) {
      if (isDeepStrictEqual(servers[name], def)) continue;
      servers[name] = def;
      changed = true;
    }
    config[serversKey] = servers;

    if (!changed) return false;
    return writeJsonFile(targetPath, config);
  }

  /** Write MCP servers to a TOML config file. */
  private installMcpToml(targetPath: string, template: Record<string, unknown>): boolean {
    let original = '';
    try { original = fs.readFileSync(targetPath, 'utf-8'); } catch { /* doesn't exist */ }

    let raw = original;
    for (const [name, def] of Object.entries(template)) {
      raw = buildTomlMcpSection(raw, name, def as Record<string, unknown>);
    }

    // Idempotency (mirrors installMcpJson): skip the write when the upsert
    // produced no change, so the detection tick doesn't churn a config.toml the
    // agent owns on every pass.
    if (raw === original) return false;

    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    atomicWriteFileSync(targetPath, raw);
    return true;
  }

  /**
   * Symlink skills into the agent's skill dir(s).
   *
   * Project scope: a canonical `.agents/skills/<name>` -> `<packageRoot>/skills/<name>`
   * layer, with agent-specific `<skillsTarget>/<name>` -> `../../.agents/skills/<name>`
   * for non-`.agents` agents.
   *
   * Global scope (flatSkills): symlink `<globalSkillsTarget>/<name>` directly to
   * the managed source `<mycoHome>/skills/<name>` (`skillsSourceDir()`), no
   * canonical layer. Most agents share `~/.agents/skills` (the cross-agent
   * standard); claude (`~/.claude/skills`) and cline (`~/.cline/skills`) are the
   * exceptions. Several manifests resolving to the same `~/.agents/skills`
   * re-create identical links idempotently — `ensureSymlink` early-returns
   * `'unchanged'`, so no cross-manifest dedup is needed.
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

    const skillsSrc = this.skillsSourceDir();
    const agentSkillsDir = this.resolveAbsoluteTarget("skills")!;

    if (this.capabilities.flatSkills) {
      // No canonical-symlink layer under global scope — the `.agents/skills/`
      // cross-agent dir is a project-local convention. Symlink each skill
      // directly under the agent's globalSkillsTarget.
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      for (const name of skillNames) {
        this.linkOrWarn(path.join(agentSkillsDir, name), path.join(skillsSrc, name));
      }
      // Remove stale Myco-owned links (retired built-ins + any dropped/renamed
      // skill no longer in the bundle) from the active target — the global
      // analog of cleanupLegacySkillSymlinks. Without it a renamed/removed skill
      // leaves a permanent dangling link.
      const current = new Set(skillNames);
      this.removeMycoSkillLinks(agentSkillsDir, this.mycoOwnedGlobalSkillNames().filter((n) => !current.has(n)));
      return true;
    }

    this.cleanupLegacySkillSymlinks(skillNames);

    // Create canonical symlinks: .agents/skills/<name> -> package skills
    const canonicalDir = path.join(this.projectRoot, CANONICAL_SKILLS_DIR);
    fs.mkdirSync(canonicalDir, { recursive: true });

    for (const name of skillNames) {
      this.linkOrWarn(path.join(canonicalDir, name), path.join(skillsSrc, name));
    }

    // Create agent-specific symlinks if skillsTarget differs from canonical
    const canonicalRel = path.relative(agentSkillsDir, canonicalDir);

    if (reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
      fs.mkdirSync(agentSkillsDir, { recursive: true });
      for (const name of skillNames) {
        this.linkOrWarn(path.join(agentSkillsDir, name), path.join(canonicalRel, name));
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
    // Audit-track every leaf Myco actually changes on disk so uninstall
    // can strip only what we wrote, never a user-pre-existing value
    // that happened to overlap with the template. Parity with the TOML
    // `installSettingsToml` audit.
    const audit = emptyJsonAudit();
    const merged = deepMergeSettingsWithAudit(existing, template, audit);
    const wrote = writeJsonFile(targetPath, merged);
    if (audit.scalars.length > 0 || audit.arrayEntries.length > 0) {
      // Merge with any pre-existing audit so re-installs accumulate
      // ownership claims (different template versions may legitimately
      // touch different paths over time). Paths are arrays; key on the
      // JSON-stringified form to avoid false-distinct paths.
      const existingAudit = this.readJsonSettingsAudit();
      if (existingAudit) {
        const seenScalarPaths = new Set(audit.scalars.map((s) => JSON.stringify(s.path)));
        for (const s of existingAudit.scalars) {
          if (!seenScalarPaths.has(JSON.stringify(s.path))) audit.scalars.push(s);
        }
        const arrayByPath = new Map(audit.arrayEntries.map((e) => [JSON.stringify(e.path), e]));
        for (const e of existingAudit.arrayEntries) {
          const key = JSON.stringify(e.path);
          const current = arrayByPath.get(key);
          if (current) {
            const seen = new Set(current.values.map((v) => JSON.stringify(v)));
            for (const v of e.values) {
              if (!seen.has(JSON.stringify(v))) current.values.push(v);
            }
          } else {
            audit.arrayEntries.push(e);
            arrayByPath.set(key, e);
          }
        }
      }
      this.writeJsonSettingsAudit(audit);
    }
    return wrote;
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

  /**
   * Read the audit list of section.key entries Myco wrote (TOML
   * settings only — schema 1). Returns [] when the audit is absent or
   * carries a non-TOML schema. The reader is tolerant of the JSON-
   * schema-2 audit (used for JSON settings) and silently ignores it
   * here; the JSON path has its own reader below.
   */
  private readSettingsAudit(): string[] {
    const auditPath = this.getSettingsAuditPath();
    try {
      const raw = fs.readFileSync(auditPath, 'utf-8');
      const parsed = JSON.parse(raw) as { schema?: unknown; wroteKeys?: unknown };
      if (parsed.schema !== 1) return [];
      if (!Array.isArray(parsed.wroteKeys)) return [];
      return parsed.wroteKeys.filter((k): k is string => typeof k === 'string');
    } catch {
      return [];
    }
  }

  /** Persist the TOML audit list. Creates parent dir as needed. */
  private writeSettingsAudit(wroteKeys: string[]): void {
    const auditPath = this.getSettingsAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    atomicWriteFileSync(auditPath, JSON.stringify({ schema: 1, wroteKeys }, null, 2) + '\n');
  }

  /**
   * Read the JSON audit (schema 2) recording the exact leaves Myco
   * mutated in a co-tenant JSON settings file. Returns `null` when no
   * audit exists (legacy install pre-dating audit tracking, OR the
   * symbiont uses the TOML audit path).
   */
  private readJsonSettingsAudit(): JsonSettingsAudit | null {
    const auditPath = this.getSettingsAuditPath();
    try {
      const raw = fs.readFileSync(auditPath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<JsonSettingsAudit>;
      if (parsed.schema !== 2) return null;
      if (parsed.format !== 'json') return null;
      return {
        schema: 2,
        format: 'json',
        scalars: Array.isArray(parsed.scalars)
          ? parsed.scalars.filter((s): s is { path: string[]; value: unknown } =>
            !!s && Array.isArray(s.path) && s.path.every((seg) => typeof seg === 'string'))
          : [],
        arrayEntries: Array.isArray(parsed.arrayEntries)
          ? parsed.arrayEntries.filter((s): s is { path: string[]; values: unknown[] } =>
            !!s && Array.isArray(s.path) && s.path.every((seg) => typeof seg === 'string')
            && Array.isArray(s.values))
          : [],
      };
    } catch {
      return null;
    }
  }

  /** Persist the JSON audit. Creates parent dir as needed. */
  private writeJsonSettingsAudit(audit: JsonSettingsAudit): void {
    const auditPath = this.getSettingsAuditPath();
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    atomicWriteFileSync(auditPath, JSON.stringify(audit, null, 2) + '\n');
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

    // Prefer the audit-track path: removes only leaves Myco recorded
    // writing. Legacy installs pre-date the JSON audit, in which case
    // fall back to the value-match `deepRemoveSettings` (the original
    // behavior — safe by coincidence for current templates).
    const audit = this.readJsonSettingsAudit();
    const changed = audit
      ? removeAuditedSettings(settings, audit)
      : deepRemoveSettings(settings, template);
    if (!changed) return false;

    writeOrDeleteJsonFile(targetPath, settings);
    if (audit) this.deleteSettingsAudit();
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

  /** Remove skill symlinks (flat-global, canonical, and agent-specific). */
  uninstallSkills(): boolean {
    const reg = this.manifest.registration;

    // Global scope installs flat symlinks under globalSkillsTarget with no
    // canonical layer (see installSkills). Uninstall mirrors that, removing only
    // Myco-owned skill links (current + legacy names), only when they're
    // symlinks — a real file/dir under the same name is user content, and other
    // sources' skills (different names) are untouched.
    //
    // Names come from the binary (mycoOwnedGlobalSkillNames), NOT the
    // materialized `<mycoHome>/skills` dir, so `myco remove` cleans up even when
    // that dir was never seeded (e.g. removal right after an upgrade, before any
    // detection tick). It also sweeps this agent's retired global dirs so a
    // remove doesn't leave the pre-migration links behind.
    //
    // Shared-dir coupling: the standard `~/.agents/skills` is shared across
    // agents; full `myco remove` uninstalls every co-tenant manifest in the same
    // loop. A future SELECTIVE per-agent global uninstall must not strip skills
    // still needed by other installed agents that share the dir.
    if (this.capabilities.flatSkills) {
      if (!reg?.globalSkillsTarget) return false;
      const owned = this.mycoOwnedGlobalSkillNames();
      const agentSkillsDir = this.resolveAbsoluteTarget("skills")!;
      let removed = this.removeMycoSkillLinks(agentSkillsDir, owned);
      for (const target of reg.retiredGlobalSkillsTargets ?? []) {
        removed = this.removeMycoSkillLinks(expandHome(target), owned) || removed;
      }
      try { fs.rmdirSync(agentSkillsDir); } catch { /* not empty or missing */ }
      return removed;
    }

    const skillNames = this.listSkillDirs();
    if (skillNames.length === 0) return false;

    if (!reg?.skillsTarget) return false;

    let removed = false;

    // Remove agent-specific symlinks
    if (reg.skillsTarget !== CANONICAL_SKILLS_DIR) {
      for (const name of skillNames) {
        const link = path.join(this.resolveAbsoluteTarget("skills")!, name);
        try {
          if (fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); removed = true; }
        } catch { /* doesn't exist */ }
      }
      // Remove agent skills dir if now empty (rmdirSync fails atomically if non-empty)
      try { fs.rmdirSync(this.resolveAbsoluteTarget("skills")!); } catch { /* not empty or missing */ }
    }

    // Remove canonical symlinks
    const canonicalDir = path.join(this.projectRoot, CANONICAL_SKILLS_DIR);
    for (const name of skillNames) {
      const link = path.join(canonicalDir, name);
      try {
        if (fs.lstatSync(link).isSymbolicLink()) { fs.unlinkSync(link); removed = true; }
      } catch { /* doesn't exist */ }
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
 * True when `project` carries no top-level keys, and no `dependencies`/
 * `devDependencies` entries, beyond what `template` declares. Values
 * (e.g. dependency version ranges) may differ.
 */
function isPristineManagedPackage(
  project: Record<string, unknown>,
  template: Record<string, unknown>,
): boolean {
  const templateKeys = new Set(Object.keys(template));
  for (const key of Object.keys(project)) {
    if (!templateKeys.has(key)) return false;
  }
  for (const depKey of ['dependencies', 'devDependencies']) {
    const projectDeps = project[depKey];
    if (!projectDeps || typeof projectDeps !== 'object') continue;
    const templateDeps = (template[depKey] ?? {}) as Record<string, unknown>;
    const allowed = new Set(Object.keys(templateDeps));
    for (const dep of Object.keys(projectDeps as Record<string, unknown>)) {
      if (!allowed.has(dep)) return false;
    }
  }
  return true;
}
