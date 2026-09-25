import type { SymbiontManifest } from './manifest-schema.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse as parseToml } from 'smol-toml';
import { expandHome, resolveMycoHome } from '../grove/paths.js';
import { isClaimedByPeer, resolveClaimsHome, shouldDeferSubsystem, SYMBIONT_CONFIG_SUBSYSTEM } from '../grove/subsystem-claim.js';
import { atomicWriteFileSync } from '../utils/atomic-write.js';
import { assertSafeProjectRoot } from '../project-root.js';
import { findTomlSectionEnd, buildTomlMcpSection, upsertTomlSection, upsertTomlSectionKeys, removeTomlSectionKeys, readTomlSectionKey } from './toml-helpers.js';
import {
  deepMergeSettings,
  deepMergeSettingsWithAudit,
  deepRemoveSettings,
  emptyJsonAudit,
  removeAuditedSettings,
  type JsonSettingsAudit,
} from './settings-merge.js';
import { readJsonFile, writeJsonFile, writeOrDeleteJsonFile } from './json-helpers.js';
import { ensureAgentsMd, ensureSymlink, isMycoHookCommand, isMycoHookGroup, withoutMycoHooks, containsMycoLauncherReference, hasMycoManagedMarker, MYCO_MANAGED_MARKER } from './install-helpers.js';
import { hookCommands, memberHookTemplate } from './member-hooks.js';
import { CREDENTIAL_FLAG, SERVER_FLAG, type CredentialSource } from '../member/constants.js';
import { isHttpsUrl, parseCredentialFlag } from '../member/credential.js';
import { deploymentUrl } from '../member/registry.js';
import { MCP_PATH } from '../plugins/spec.js';
import { MCP_HEADERS_ARGS, MEMBER_MCP_LEVERS, memberMcpTemplate, memberRemoteMcp } from './member-hooks.js';
import { readRegistryEntry } from '../member/registry.js';
import { runGit } from '../utils/git.js';
import { resolveRuntimeCommand, resolveRuntimeHome } from '../daemon/update-checker.js';
import { managedBinaryPath, managedSkillsDir } from '../install/managed-binary.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
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

/** The always-present managed guidance lines. */
const AGENTS_MANAGED_BASE_LINES = [
  '- When `capture.ignore_plan_dirs_in_git` is enabled, custom directories in `capture.plan_dirs` may be intentionally gitignored after capture into Myco.',
  '- Do not force-add files from intentionally gitignored custom plan directories unless the user explicitly asks.',
  '- Myco tools take a `project` argument; pass this repo\'s git remote or the project id from session-start context. Writes without it are refused.',
] as const;

/** Managed AGENTS.md block. */
export function buildAgentsManagedBlock(): string {
  const lines: string[] = [...AGENTS_MANAGED_BASE_LINES];
  return `${AGENTS_MANAGED_START}\n## Myco Managed Guidance\n\n${lines.join('\n')}\n${AGENTS_MANAGED_END}\n`;
}

/** Subdirectory within the package where symbiont templates live. */
const TEMPLATES_SUBDIR = 'src/symbionts/templates';

/** Filename of the hook guard template in the templates directory. */
const HOOK_GUARD_TEMPLATE_FILENAME = 'myco-run.cjs';

/** Subdirectory within the package where skills live. */
const SKILLS_SUBDIR = 'skills';

/** MCP server name used by Myco in all symbiont configurations. */
export const MYCO_MCP_SERVER_NAME = 'myco';

/** The `type` a JSON host takes for a remote HTTP MCP server. */
const REMOTE_MCP_TYPE = 'http';

/** Member provisioning refused before any write: an agent-global file would make the member surface unusable, or cannot be read. */
export class MemberProvisionConflictError extends Error {}

/**
 * A member MCP entry the host would merge with a global one it cannot use, or
 * a config that cannot be read. `problem` is the finding alone, for a caller
 * whose own remedy differs from the one the message carries.
 */
export class MemberMcpConflictError extends MemberProvisionConflictError {
  constructor(message: string, readonly problem: string = message) {
    super(message);
  }
}

/** A global Myco plugin that would load beside the project's member plugin instead of stepping aside for it. */
export class MemberPluginConflictError extends MemberProvisionConflictError {}

/**
 * Keys of a global `myco` server that conflict with a member's remote entry
 * when a TOML host merges the two: a stdio transport (Codex refuses `command`
 * or `cwd` beside `url`) or a credential other than the headers helper.
 */
const GLOBAL_MCP_CONFLICT_KEYS: readonly string[] = [
  'command', 'args', 'env', 'env_vars', 'cwd',
  'bearer_token', 'bearer_token_env_var', 'http_headers', 'env_http_headers', 'oauth',
];

/**
 * Keys of a global `myco` server that survive a JSON host's merge into a
 * member's stdio entry and leave it unusable: a remote transport and its
 * credential, or an environment the bridge would inherit (a `MYCO_HOME` of
 * the global install's choosing sends it to the wrong vault). The project's
 * own `command` always wins, so a global launcher is no conflict.
 */
const GLOBAL_JSON_MCP_CONFLICT_KEYS: readonly string[] = ['url', 'headers', 'oauth', 'environment'];

/** The key a JSON host reads to switch a merged server off; `false` is what does it. */
const MCP_ENABLED_KEY = 'enabled';

/** The table a TOML host keeps its MCP servers in. */
const TOML_MCP_SERVERS_KEY = 'mcp_servers';

/** An error's first line, so a parser's caret diagram never runs through a refusal message. */
function firstLine(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] : String(error);
}

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

/**
 * The comment line only a member plugin carries: the one `member leave` may
 * delete, and the one a global plugin steps aside for. Matched as the whole
 * comment prefix, never the bare word, so a plugin that names it in its own
 * code does not match itself.
 */
const MEMBER_PLUGIN_MARKER = '// myco:member-plugin';

/** The comment line a global Myco plugin carries when it steps aside for a project's member plugin. */
const MEMBER_PLUGIN_COMPAT_MARKER = '// myco:defers-to-member-plugin';

/** Where a plugin template names the credential source the binary is to read. */
const CREDENTIAL_SOURCE_PLACEHOLDER = '{{mycoCredentialSource}}';

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
 * duplication a per-hook template would carry — a single edit here updates every hook.
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

/** The words a credential flag and its source take on a command line the writer emits. */
const CREDENTIAL_ARGV_WORDS = 2;

/** The words a member headers helper carries after `member mcp-headers`: the credential flag and the server flag, each with its value. */
const HELPER_FLAG_WORDS = 4;

/** The arguments a member's stdio launcher runs the bridge with, before the credential flag and its source; `mcp-template-shape.test.ts` holds every template to them. */
const MEMBER_BRIDGE_ARGS: readonly string[] = ['mcp'];

/** The file names a managed member binary is installed under, read from the layout the installs share. */
const MANAGED_BINARY_NAMES: readonly string[] = (['linux', 'win32'] as const)
  .map((platform) => managedBinaryPath('/', platform, '/').replaceAll('\\', '/').split('/').pop() ?? '');

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
  const resolved = resolveBinary('self-exec', { kind: 'machine' }, { mycoHome, platform });
  return resolved.path.replaceAll('\\', '/');
}

/**
 * Refuse to emit a hook command whose binary path contains whitespace.
 * Quoting would survive shell symbionts but break direct-argv symbionts
 * (cursor / windsurf / pi). Failing loudly at install time beats silent
 * capture failure after the agent's next launch.
 */
/** What a user is told when the managed binary sits at a path containing whitespace, and what to do about it. */
export const WHITESPACE_PATH_REFUSAL =
  'contains whitespace, which breaks direct-argv hook spawn for cursor / windsurf / pi. Move Myco out of a path with spaces.';

function assertSafeBinaryPathForUnquoted(binaryPath: string): void {
  if (!/\s/.test(binaryPath)) return;
  throw new Error(`Refusing to install symbiont hooks: binary path "${binaryPath}" ${WHITESPACE_PATH_REFUSAL}`);
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


/**
 * The hook commands a hooks file declares under `hooks`. A file that is not
 * strict JSON (Codex's `hooks.json` carries a TOML footer) is read for its
 * `"command"` strings instead.
 */
function hookCommandsIn(raw: string): string[] {
  try {
    return hookCommands((JSON.parse(raw) as { hooks?: unknown }).hooks);
  } catch {
    return [...raw.matchAll(/"command"\s*:\s*("(?:[^"\\]|\\.)*")/g)].map((m) => JSON.parse(m[1]) as string);
  }
}

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

export type InstallScope = 'project' | 'global' | 'member-project' | 'member-global';

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
  /** Name the pinned home in each MCP server's `env`. See {@link SymbiontInstaller.injectMcpHomeEnv}. */
  mcpHomeEnv: boolean;
}

const SCOPE_CAPABILITIES: Record<InstallScope, ScopeCapabilities> = {
  project: {
    agentsMd: true, gitignore: true, instructions: true, pluginPackage: true,
    globalLauncher: false, flatSkills: false, detectionGate: false, mcpHomeEnv: true,
  },
  global: {
    agentsMd: false, gitignore: false, instructions: false, pluginPackage: false,
    globalLauncher: true, flatSkills: true, detectionGate: true, mcpHomeEnv: true,
  },
  // The 2.0 member scope writes the symbiont's memberHooksTarget and, for an
  // mcp-transport symbiont, its MCP server list. Every project-content surface,
  // the launchers, skills and the settings template are off, so no path through
  // this scope can reach the file a 1.4 project install owns.
  'member-project': {
    agentsMd: false, gitignore: false, instructions: false, pluginPackage: false,
    globalLauncher: false, flatSkills: false, detectionGate: false, mcpHomeEnv: false,
  },
  'member-global': {
    agentsMd: false, gitignore: false, instructions: false, pluginPackage: false,
    globalLauncher: false, flatSkills: true, detectionGate: false, mcpHomeEnv: false,
  },
};

/** Keys a JSON MCP host reads and a TOML one (Codex) does not; a TOML entry carries the child's working directory instead. */
const JSON_ONLY_MCP_KEYS: readonly string[] = ['type', ...Object.keys(MEMBER_MCP_LEVERS)];

/**
 * The member's server block as a TOML host takes it: the JSON-only keys
 * dropped, and a stdio launcher started in the project. A URL entry carries no
 * `cwd` — Codex refuses a config whose streamable HTTP server declares one.
 */
export function tomlMemberServers(block: Record<string, unknown>, projectRoot: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, def] of Object.entries(block)) {
    if (!def || typeof def !== 'object') continue;
    const server = Object.fromEntries(Object.entries(def as Record<string, unknown>).filter(([key]) => !JSON_ONLY_MCP_KEYS.includes(key)));
    out[name] = 'url' in server ? server : { ...server, cwd: projectRoot };
  }
  return out;
}

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
    // The home a member-project install reads the project's membership from.
    // Defaults to the home the project resolves; `myco member` passes its own.
    private memberHome?: string,
  ) {
    this.vaultDir = vaultDir ?? path.join(projectRoot, '.myco');
    this.groveId = groveId;
    this.installScope = installScope;
  }

  /** Capability switch for the active scope. */
  private get capabilities(): ScopeCapabilities {
    return SCOPE_CAPABILITIES[this.installScope];
  }

  private get isGlobalScope(): boolean {
    return this.installScope === 'global' || this.installScope === 'member-global';
  }

  private get isMemberScope(): boolean {
    return this.installScope === 'member-project' || this.installScope === 'member-global';
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
    if (this.isGlobalScope) {
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
    if (this.installScope === 'member-project') {
      // The member scope has exactly one surface. Anything else resolves to
      // null so a stray call writes nothing rather than falling back to the
      // 1.4 project target.
      if (field !== 'hooks' || !reg.memberHooksTarget) return null;
      return path.join(this.projectRoot, reg.memberHooksTarget);
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
    if (this.isGlobalScope) {
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
    // Prevents legacy and current guard files coexisting for projects that
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
   * Returns true if any file was deleted; false otherwise.
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
    const binaryPath = this.binaryPath();
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
   * Name the pinned home in each MCP server entry's `env`, for the scopes whose
   * file is machine-local.
   *
   * A dogfood project pinned to `~/.myco-dev` writes its `runtime.command`
   * beside the home pin, and the host agent execs `<binary> mcp` without the
   * `runtime-redirect.cjs` shim; the env is what carries that operator's
   * intent through to the server.
   *
   * OFF under `member-project`: that scope's `.mcp.json` lives in the project
   * tree and is normally committed, so a machine's absolute home path would
   * travel to everyone who clones it. Nothing is lost — `myco mcp` resolves the
   * project's own `runtime.home` pin (`paths/home.ts`), reaching the same home
   * without the committed file naming it.
   *
   * No pin → no injection either way: the daemon-agnostic prod default (see
   * `resolveManagedBinaryPath`) is preserved so a config never embeds a home
   * nothing asked for. Mirrors the CLI/hook redirect: same layered pin, same
   * trust check.
   */
  private injectMcpHomeEnv(servers: Record<string, unknown>): void {
    if (!this.capabilities.mcpHomeEnv) return;
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
    if (this.isMemberScope) {
      // Every refusal runs before the first write: a member is provisioned
      // with both surfaces or with neither, never with a plugin whose tools
      // the host would then refuse to serve.
      if (this.isMemberPluginFile()) {
        this.assertMemberMcpWritable();
        const hooks = this.writeMemberPlugin();
        return this.finishMemberInstall({ ...emptyInstallResult(), hooks, mcp: this.installMemberMcp() });
      }
      if (this.renderMemberHooks('registry') === null) return emptyInstallResult();
      this.assertMemberMcpWritable();
      const hooks = this.installMemberHooks();
      return this.finishMemberInstall({ ...emptyInstallResult(), hooks, mcp: this.installMemberMcp(), settings: this.isGlobalScope && this.installSettings() });
    }
    if (this.deferGlobalSymbiontConfig()) return emptyInstallResult();
    this.assertLegacyGlobalInstallAllowed();
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

    const block = buildAgentsManagedBlock();

    const stripped = this.stripManagedAgentsBlock(content);
    const separator = stripped.length > 0 && !stripped.endsWith('\n') ? '\n' : '';
    const spacer = stripped.trimEnd().length > 0 ? '\n' : '';
    const result = `${stripped}${separator}${spacer}${block}`;
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
   * hook-side source of truth — while stale allowlist entries remain
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
    // duplicate `myco` registration under the legacy key.
    const mcpTemplate = reg.mcpTarget ? this.loadMcpTemplate() : null;
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
   * link was deleted.
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
   * agent reads the new target now; the leftover links are unread cruft (often
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
   * The member's hook block for `source`, rendered from this symbiont's own
   * hook template — never written, so `myco settings` and the `member-project`
   * scope print and install the same bytes. Null when the manifest declares no
   * member surface (`memberHooksTarget`) or its hooks are a plugin file, which
   * Plan 3 leaves out of member scope entirely.
   */
  renderMemberHooks(source: CredentialSource): Record<string, unknown> | null {
    const reg = this.manifest.registration;
    if (!reg?.memberHooksTarget) return null;
    if (reg.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) return null;
    const rawTemplate = this.loadTemplate('hooks');
    if (!rawTemplate) return null;
    const block = this.resolveHookTemplatePlaceholders(memberHookTemplate(rawTemplate, source));
    for (const command of hookCommands(block)) {
      if (!command.includes(`${CREDENTIAL_FLAG} ${source}`)) {
        throw new Error(`Refusing to emit member hooks: a command declares no ${CREDENTIAL_FLAG} ${source} (${command})`);
      }
    }
    return block;
  }

  /** Write scoped member hooks, preserving foreign commands and excluding project targets from git. */
  installMemberHooks(): boolean {
    this.assertMemberMcpWritable();
    const block = this.renderMemberHooks('registry');
    if (block === null) return false;
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (targetPath === null) return false;

    const settings = readJsonFile(targetPath);
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const mergedHooks: Record<string, unknown[]> = {};
    for (const [event, groups] of Object.entries(existingHooks)) {
      const foreign = withoutMycoHooks(groups as Array<Record<string, unknown>>);
      if (foreign.length > 0) mergedHooks[event] = foreign;
    }
    for (const [event, groups] of Object.entries(block)) {
      mergedHooks[event] = [...(mergedHooks[event] ?? []), ...(groups as unknown[])];
    }
    settings.hooks = mergedHooks;
    const reg = this.manifest.registration;
    if (reg?.hooksConfigVersion !== undefined) settings.version = reg.hooksConfigVersion;
    const written = writeJsonFile(targetPath, settings);
    if (!this.isGlobalScope) this.ensureGitIgnored(targetPath);
    return written;
  }

  /**
   * The member's MCP server block for `source`. A host that takes a headers
   * helper (`memberMcpHeadersHelperKey`) gets the Deployment's remote `/mcp`,
   * named by this project's registry entry, with the helper printing the
   * member headers; null when the project has no membership to name one.
   * Every other host gets its own stdio launcher carrying the credential flag.
   * Null for a symbiont without an MCP template; every Myco tool is reached
   * over MCP, with the Project named as a tool parameter.
   */
  renderMemberMcp(source: CredentialSource): Record<string, unknown> | null {
    const reg = this.manifest.registration;
    if (!reg?.mcpTarget) return null;
    if (reg.memberMcpHeadersHelperKey) {
      const entry = readRegistryEntry(this.projectRoot, this.memberHomeDir());
      if (entry === null) return null;
      const binaryPath = this.binaryPath();
      assertSafeBinaryPathForUnquoted(binaryPath);
      // A JSON host reads `type` and the levers; a TOML host drops them (`tomlMemberServers`).
      const remote = memberRemoteMcp(entry.serverUrl, reg.memberMcpHeadersHelperKey, binaryPath, source);
      return { [MYCO_MCP_SERVER_NAME]: { type: REMOTE_MCP_TYPE, ...remote, ...MEMBER_MCP_LEVERS } };
    }
    const template = this.loadMcpTemplate();
    return template === null ? null : memberMcpTemplate(template, source);
  }

  private memberHomeDir(): string {
    return this.memberHome ?? resolveMycoHome({ cwd: this.projectRoot });
  }

  /** The binary every command this install writes names: a member project's own home's, else the machine's. */
  private binaryPath(): string {
    return this.isMemberScope ? resolveManagedBinaryPath(this.memberHomeDir()) : resolveManagedBinaryPath();
  }

  /**
   * Refuse, before any member write, a global `myco` server this host merges
   * into the project's entry carrying keys that leave it unusable: an
   * incompatible transport or a competing credential on a TOML host, a remote
   * transport, an inherited environment or a disabled server on a JSON one.
   * A global file that cannot be read or parsed refuses too; only a missing
   * file is no global config.
   */
  private assertNoMemberMcpConflict(): void {
    if (this.isGlobalScope) return;
    const reg = this.manifest.registration;
    if (!reg?.memberMcpGlobalMerge || !reg.mcpTarget) return;
    const toml = reg.mcpFormat === 'toml';
    for (const target of reg.globalMcpTarget ?? []) {
      const globalPath = expandHome(target.path);
      const serversKey = toml ? TOML_MCP_SERVERS_KEY : (target.serversKey ?? reg.mcpServersKey ?? 'mcpServers');
      const entry = this.mycoServerIn(globalPath, toml, serversKey);
      if (entry === null) continue;
      const conflicting = toml
        ? Object.keys(entry).filter((key) => GLOBAL_MCP_CONFLICT_KEYS.includes(key))
        : Object.keys(entry).filter((key) => GLOBAL_JSON_MCP_CONFLICT_KEYS.includes(key));
      if (!toml && entry[MCP_ENABLED_KEY] === false) conflicting.push(MCP_ENABLED_KEY);
      if (conflicting.length === 0) continue;
      const section = toml ? `[${TOML_MCP_SERVERS_KEY}.${MYCO_MCP_SERVER_NAME}]` : `\`${serversKey}.${MYCO_MCP_SERVER_NAME}\``;
      throw this.memberMcpConflict(
        `${globalPath} declares a \`${MYCO_MCP_SERVER_NAME}\` MCP server with ${conflicting.join(', ')}, which ${this.manifest.displayName} merges into this project's \`${MYCO_MCP_SERVER_NAME}\` entry — leaving it pointed elsewhere, carrying another credential, or switched off`,
        `Remove those keys from ${section} in ${globalPath} if no other project needs them`,
      );
    }
  }

  /** Refuses a member MCP write, naming what was found, that nothing was written, and the command to run once it is fixed. */
  private memberMcpConflict(problem: string, remedy: string): MemberMcpConflictError {
    return new MemberMcpConflictError(
      `${problem}, so nothing was written. ${remedy}, then run \`myco member provision ${this.manifest.name}\`.`,
      problem,
    );
  }

  /** The member's MCP file in the selected installation scope, or null. */
  private memberMcpTargetPath(): string | null {
    if (this.isGlobalScope) return this.resolveAbsoluteMcpTargets()[0]?.path ?? null;
    const target = this.manifest.registration?.mcpTarget;
    return target ? path.join(this.projectRoot, target) : null;
  }

  /**
   * Write the member's MCP server into the manifest's mcpTarget under the
   * symbiont's server-list key, keeping every other server the file holds and
   * sweeping a `myco` entry left under a historical key. The file is left to
   * git as the 1.4 project install leaves it: a repository may track its MCP
   * server list, and an exclude entry on a tracked file hides its changes.
   */
  installMemberMcp(): boolean {
    this.assertMemberMcpWritable();
    const block = this.renderMemberMcp('registry');
    const targetPath = this.memberMcpTargetPath();
    if (block === null || targetPath === null) return false;
    const reg = this.manifest.registration!;
    // A TOML server list (Codex) is edited section by section; the JSON sweep
    // below is for the JSON targets. The JSON hosts' levers are not written.
    // Codex's remote entry needs no `cwd`: it runs the headers helper in the
    // session's directory, where the membership resolves the way every hook's does.
    if (reg.mcpFormat === 'toml') return this.installMcpToml(targetPath, tomlMemberServers(block, this.projectRoot));
    const serversKey = reg.mcpServersKey ?? 'mcpServers';
    const data = this.readMemberMcpTarget() ?? {};
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
    for (const [name, def] of Object.entries(block)) servers[name] = def;
    data[serversKey] = servers;
    return writeJsonFile(targetPath, data);
  }

  /**
   * Remove the `myco` MCP server provisioning wrote from the member target
   * under every known key, deleting the file when nothing is left. Only the
   * member's own entry: a 1.4 project install writes its server to the same
   * file under the same name, and that one is left to the install that owns it.
   * The inverse of `installMemberMcp`.
   */
  uninstallMemberMcp(): boolean {
    const targetPath = this.memberMcpTargetPath();
    if (targetPath === null || !fs.existsSync(targetPath)) return false;
    if (this.manifest.registration?.mcpFormat === 'toml') {
      return this.isMemberMcpServer(this.mycoServerIn(targetPath, true, TOML_MCP_SERVERS_KEY)) && this.uninstallMcpToml(targetPath);
    }
    const data = this.readMemberMcpTarget() ?? {};
    let removed = false;
    for (const key of KNOWN_MCP_SERVERS_KEYS) {
      const candidate = data[key];
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const bag = candidate as Record<string, unknown>;
      if (!(MYCO_MCP_SERVER_NAME in bag)) continue;
      if (!this.isMemberMcpServer(bag[MYCO_MCP_SERVER_NAME])) continue;
      delete bag[MYCO_MCP_SERVER_NAME];
      removed = true;
      if (Object.keys(bag).length === 0) delete data[key];
    }
    if (!removed) return false;
    if (Object.keys(data).length === 0) {
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    return writeJsonFile(targetPath, data);
  }

  /**
   * True for a `myco` server member provisioning wrote: it carries the member
   * credential, as the remote host's headers helper or as the stdio bridge's
   * `--credential` argument. A 1.4 project install's server carries neither.
   */
  private isMemberMcpServer(def: unknown): boolean {
    if (!def || typeof def !== 'object' || Array.isArray(def)) return false;
    const server = def as Record<string, unknown>;
    const helperKey = this.manifest.registration?.memberMcpHeadersHelperKey;
    if (helperKey && typeof server[helperKey] === 'string' && server[helperKey].includes(CREDENTIAL_FLAG)) return true;
    return [server.command, server.args].some((list) => Array.isArray(list) && list.includes(CREDENTIAL_FLAG));
  }

  /**
   * The parsed contents of `filePath`, or null when the file is absent. A file
   * that cannot be read or parsed raises the member MCP refusal rather than
   * reading as an empty one: every caller would otherwise act on bytes it
   * never saw, one by overwriting them and one by leaving an entry behind.
   */
  private readMcpFile(filePath: string, toml: boolean): Record<string, unknown> | null {
    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw this.memberMcpConflict(`could not read ${filePath} (${firstLine(error)})`, 'Fix the file');
    }
    try {
      const parsed: unknown = toml ? parseToml(raw) : JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected a configuration object');
      return parsed as Record<string, unknown>;
    } catch (error) {
      throw this.memberMcpConflict(`could not read ${filePath} (${firstLine(error)})`, 'Fix the file');
    }
  }

  /** The `myco` server `filePath` declares under `serversKey`, or null when the file or the server is absent. */
  private mycoServerIn(filePath: string, toml: boolean, serversKey: string): Record<string, unknown> | null {
    const server = (this.readMcpFile(filePath, toml)?.[serversKey] as Record<string, unknown> | undefined)?.[MYCO_MCP_SERVER_NAME];
    return server && typeof server === 'object' && !Array.isArray(server) ? server as Record<string, unknown> : null;
  }

  /**
   * The member's own MCP target, parsed, or null when it has none or the file
   * is absent. The one reader `installMemberMcp` and `uninstallMemberMcp`
   * share, so neither writes over a file it could not read.
   */
  private readMemberMcpTarget(): Record<string, unknown> | null {
    const targetPath = this.memberMcpTargetPath();
    if (targetPath === null) return null;
    return this.readMcpFile(targetPath, this.manifest.registration?.mcpFormat === 'toml');
  }

  /**
   * Whether an entry names a credential source a member could resolve from, and
   * a Deployment where a headers helper needs one: the headers helper
   * provisioning writes, or its launcher — the member bridge's own arguments,
   * then the credential flag and its source, and nothing else. A launcher
   * carries a source only where it names a member binary to run; arguments
   * alone launch nothing. An argument list holding a value that is not a word
   * names nothing.
   */
  private declaresUsableCredential(entry: Record<string, unknown>): boolean {
    if (this.helperWords(entry) !== null) return this.canonicalHelper(entry) !== null;
    const binary = this.launcherBinary(entry);
    if (binary === null || !this.namesMemberBinary(binary)) return false;
    const argv = this.launcherArgv(entry);
    if (argv === null || argv.length !== MEMBER_BRIDGE_ARGS.length + CREDENTIAL_ARGV_WORDS) return false;
    if (argv.slice(0, MEMBER_BRIDGE_ARGS.length).join(' ') !== MEMBER_BRIDGE_ARGS.join(' ')) return false;
    return parseCredentialFlag(argv.slice(-CREDENTIAL_ARGV_WORDS)) !== null;
  }

  /**
   * A launcher's arguments, with the executable a command list leads with
   * dropped, or null where any word of either list is not a string.
   */
  private launcherArgv(entry: Record<string, unknown>): string[] | null {
    const argv: string[] = [];
    for (const [list, executable] of [[entry.command, 1], [entry.args, 0]] as const) {
      if (!Array.isArray(list)) continue;
      if (!list.every((word): word is string => typeof word === 'string')) return null;
      argv.push(...list.slice(executable));
    }
    return argv;
  }

  /**
   * The credential source and Deployment an entry's headers helper names, or
   * null where its words are not the command provisioning writes: the member's
   * binary, `member mcp-headers`, then the credential flag and the server
   * flag, each with its value and in that order. Any other command names
   * nothing, whichever of the same words it carries.
   */
  private canonicalHelper(entry: Record<string, unknown>): { source: CredentialSource; deployment: string } | null {
    const words = this.helperWords(entry);
    if (words === null || words[0] === undefined || !this.namesMemberBinary(words[0])) return null;
    if (words.slice(1, 1 + MCP_HEADERS_ARGS.length).join(' ') !== MCP_HEADERS_ARGS.join(' ')) return null;
    const flags = words.slice(1 + MCP_HEADERS_ARGS.length);
    if (flags.length !== HELPER_FLAG_WORDS || flags[0] !== CREDENTIAL_FLAG || flags[2] !== SERVER_FLAG) return null;
    const source = parseCredentialFlag(flags.slice(0, CREDENTIAL_ARGV_WORDS));
    const deployment = this.deploymentNamed(flags[3]);
    return source === null || deployment === null ? null : { source, deployment };
  }

  /** The executable an entry's launcher runs, or null where it declares none. */
  private launcherBinary(entry: Record<string, unknown>): string | null {
    const command = entry.command;
    if (typeof command === 'string') return command;
    return Array.isArray(command) && typeof command[0] === 'string' ? command[0] : null;
  }

  /** Whether a command word names a member binary: the one this install writes, or one installed under the managed binary's name. */
  private namesMemberBinary(word: string): boolean {
    return word === this.binaryPath() || MANAGED_BINARY_NAMES.includes(word.replaceAll('\\', '/').split('/').pop() ?? word);
  }

  /** The words of the headers helper this entry declares, or null where it declares none. */
  private helperWords(entry: Record<string, unknown>): string[] | null {
    const helperKey = this.manifest.registration?.memberMcpHeadersHelperKey;
    const helper = helperKey === undefined ? undefined : entry[helperKey];
    return typeof helper === 'string' ? helper.split(/\s+/).filter((word) => word !== '') : null;
  }

  /** A Deployment a member's entry may name: the identity of a URL a membership could carry, else null. */
  private deploymentNamed(value: string | undefined): string | null {
    if (value === undefined) return null;
    const named = deploymentUrl(value);
    return isHttpsUrl(named) ? named : null;
  }

  /** The Deployment a headers helper names, or null where it names none a member could use. */
  private helperDeployment(entry: Record<string, unknown>): string | null {
    return this.canonicalHelper(entry)?.deployment ?? null;
  }

  /** The Deployment this entry's URL names, or null where the URL is not one a member's entry carries. */
  private entryDeployment(entry: Record<string, unknown>): string | null {
    const url = entry.url;
    if (typeof url !== 'string' || !url.endsWith(MCP_PATH)) return null;
    return this.deploymentNamed(url.slice(0, -MCP_PATH.length));
  }

  /**
   * Whether this scope's hooks target carries Myco's capture, and whether that
   * capture is the member's. A hooks file is read hook by hook: a Myco hook
   * command is the member's when the command itself declares a credential
   * source, so a credential flag elsewhere in the file — a permission rule, a
   * foreign hook — decides nothing. A plugin file is the member's when it is the
   * member plugin. `memberCommands` are the member hook commands found, for a
   * caller that checks what they run. Reads only; a target that exists and
   * cannot be read is reported unreadable rather than absent.
   */
  inspectMemberHooks(): { scope: 'global' | 'project'; target: string | null; present: boolean; member: boolean; memberCommands: string[]; readable: boolean } {
    const scope = this.isGlobalScope ? 'global' as const : 'project' as const;
    const target = this.resolveAbsoluteTarget('hooks');
    const none = { scope, target, present: false, member: false, memberCommands: [] as string[] };
    if (target === null || !fs.existsSync(target)) return { ...none, readable: true };
    let raw: string;
    try {
      raw = fs.readFileSync(target, 'utf-8');
    } catch {
      return { ...none, readable: false };
    }
    const present = this.isConfigured();
    if (this.manifest.registration?.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE) {
      return { ...none, present, member: present && raw.includes(MEMBER_PLUGIN_MARKER), readable: true };
    }
    const memberCommands = hookCommandsIn(raw)
      .filter((command) => isMycoHookCommand(command) && parseCredentialFlag(command.split(/\s+/)) !== null);
    return { ...none, present, member: present && memberCommands.length > 0, memberCommands, readable: true };
  }


  /**
   * What this symbiont's MCP targets say about the member's entry, for a report.
   *
   * Presence, transport, scope, the directory a launcher declares, whether the
   * entry carries this member's credential, and whether the Deployments it
   * names agree with each other and with `expectedDeployment`: the entry itself holds a URL and the headers a credential
   * travels in, and none of that leaves this class. Reading
   * goes through the same parser the writes use, so a file that cannot be read
   * is named as such rather than read as an empty one.
   */
  inspectMemberMcp(expectedDeployment?: string): Array<{ scope: 'global' | 'project'; present: boolean; transport: 'http' | 'stdio' | null; carriesCredential: boolean; declaredCwd: string | null; deploymentsAgree: boolean | null; namesExpectedDeployment: boolean | null; readable: boolean }> {
    const toml = this.manifest.registration?.mcpFormat === 'toml';
    const scope = this.isGlobalScope ? 'global' as const : 'project' as const;
    return this.resolveAbsoluteMcpTargets().map(({ path: filePath, serversKey }) => {
      // A TOML host keeps its servers under one section whatever the manifest names.
      const key = toml ? TOML_MCP_SERVERS_KEY : serversKey;
      let file: Record<string, unknown> | null;
      try {
        file = this.readMcpFile(filePath, toml);
      } catch {
        return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: false };
      }
      // A key that is not there is a file declaring no server; a key that is
      // there and is not a server block is a file nothing can read an entry
      // from, and each target answers for itself.
      const servers = file?.[key];
      if (file === null || servers === undefined) return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: true };
      if (servers === null || typeof servers !== 'object' || Array.isArray(servers)) {
        return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: false };
      }
      const server = (servers as Record<string, unknown>)[MYCO_MCP_SERVER_NAME];
      if (server === undefined) return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: true };
      if (server === null || typeof server !== 'object' || Array.isArray(server)) {
        return { scope, present: false, transport: null, carriesCredential: false, declaredCwd: null, deploymentsAgree: null, namesExpectedDeployment: null, readable: false };
      }
      const entry = server as Record<string, unknown>;
      // A launcher names its command as a word or as an argument list; opencode writes the list.
      const launcher = typeof entry.command === 'string' || (Array.isArray(entry.command) && entry.command.length > 0);
      const transport = typeof entry.url === 'string' ? 'http' as const : launcher ? 'stdio' as const : null;
      // A launcher started outside the project finds its membership through the
      // directory the entry names, so the directory is a fact about it.
      const declaredCwd = typeof entry.cwd === 'string' && entry.cwd !== '' ? entry.cwd : null;
      // What the entry declares is one fact; whether it is the entry member
      // provisioning writes — the one carrying this member's credential — is
      // another, and a server that is not cannot resolve the membership.
      // The Deployments the entry names, as answers rather than as URLs: whether
      // its own two agree, and whether they name the one the caller expects.
      // An entry naming neither answers nothing; one naming either must name
      // both, and name them the same, or it routes somewhere it cannot reach.
      const declares = typeof entry.url === 'string' || this.helperWords(entry) !== null;
      const dialled = this.entryDeployment(entry);
      const minted = this.helperDeployment(entry);
      const both = dialled !== null && minted !== null;
      const deploymentsAgree = !declares ? null : both && dialled === minted;
      const expected = expectedDeployment === undefined ? undefined : this.deploymentNamed(expectedDeployment);
      const namesExpectedDeployment = !declares || expected === undefined
        ? null
        : expected !== null && both && dialled === expected && minted === expected;
      return { scope, present: true, transport, carriesCredential: this.declaresUsableCredential(entry), declaredCwd,
        deploymentsAgree, namesExpectedDeployment, readable: true };
    });
  }

  /**
   * Every member MCP refusal, before the first write of either surface: the
   * project's own target must be readable, and the global server this host
   * merges into it must carry no key that leaves the member's entry unusable.
   */
  private assertMemberMcpWritable(): void {
    this.readMemberMcpTarget();
    this.assertNoMemberMcpConflict();
    if (this.installScope === 'member-global') this.assertGlobalMemberOwnership();
  }

  /** Retire this project's member registrations after their global replacements are written. */
  private finishMemberInstall(result: InstallResult): InstallResult {
    if (this.installScope !== 'member-global') return result;
    const local = this.projectMemberInstaller();
    const hooks = local.uninstallMemberHooks();
    const mcp = local.uninstallMemberMcp();
    return { ...result, hooks: hooks || result.hooks, mcp: mcp || result.mcp };
  }

  /** Global member provisioning cannot take another installation's capture or Deployment. */
  private assertGlobalMemberOwnership(): void {
    const memberHome = this.memberHomeDir();
    if (isClaimedByPeer(SYMBIONT_CONFIG_SUBSYSTEM, memberHome, { claimsHome: resolveClaimsHome(memberHome) })) {
      throw new MemberProvisionConflictError('Global symbiont configuration is claimed by another installation. Release its symbiont-config claim before provisioning globally.');
    }
    assertSafeProjectRoot(this.projectRoot);
    const local = this.projectMemberInstaller();
    local.readMemberMcpTarget();
    const localHooks = local.resolveAbsoluteTarget('hooks');
    if (localHooks && !this.isMemberPluginFile()) this.readMcpFile(localHooks, false);
    if (localHooks && this.isMemberPluginFile()) local.assertMemberPluginTargetIsMyco(localHooks);
    const target = this.resolveAbsoluteTarget('hooks');
    if (target && fs.existsSync(target)) {
      if (this.isMemberPluginFile()) {
        let content: string;
        try { content = fs.readFileSync(target, 'utf8'); } catch (error) {
          throw new MemberProvisionConflictError(`could not read ${target} (${firstLine(error)}), so nothing was written.`);
        }
        if (!content.includes(MEMBER_PLUGIN_MARKER)) {
          throw new MemberProvisionConflictError(`Global hooks at ${target} belong to another installation. Complete its capture cutover before provisioning globally.`);
        }
      } else {
        const settings = this.readMcpFile(target, false);
        const commands = hookCommands(settings?.hooks).filter((command) => rawHasMycoOwnershipSignal(command));
        if (commands.some((command) => !command.includes(CREDENTIAL_FLAG) || !command.includes(this.binaryPath()))) {
          throw new MemberProvisionConflictError(`Global hooks at ${target} belong to another installation. Complete its capture cutover before provisioning globally.`);
        }
      }
    }
    const reg = this.manifest.registration;
    const mcpTarget = this.memberMcpTargetPath();
    if (!mcpTarget) return;
    const existing = this.mycoServerIn(mcpTarget, reg?.mcpFormat === 'toml', reg?.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : (reg?.mcpServersKey ?? 'mcpServers'));
    if (existing === null) return;
    const desired = this.renderMemberMcp('registry')?.[MYCO_MCP_SERVER_NAME] as Record<string, unknown> | undefined;
    const helperKey = reg?.memberMcpHeadersHelperKey;
    const sameCredentialSource = helperKey
      ? existing[helperKey] === desired?.[helperKey]
      : isDeepStrictEqual(existing.command, desired?.command) && isDeepStrictEqual(existing.args, desired?.args);
    if (!this.isMemberMcpServer(existing) || existing.url !== desired?.url || !sameCredentialSource) {
      throw this.memberMcpConflict(`the global Myco MCP entry in ${mcpTarget} belongs to another installation or Deployment`, 'Complete its capture cutover before replacing the global entry');
    }
  }

  private projectMemberInstaller(): SymbiontInstaller {
    return new SymbiontInstaller(this.manifest, this.projectRoot, this.packageRoot, this.suppressBundledTemplates, this.vaultDir, this.groveId, 'member-project', this.memberHomeDir());
  }

  /** Legacy reconciliation cannot replace a global member registration. */
  private assertLegacyGlobalInstallAllowed(): void {
    if (this.installScope !== 'global') return;
    const target = this.resolveAbsoluteTarget('hooks');
    const raw = target && fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : '';
    const memberHooks = this.manifest.registration?.hooksFormat !== HOOKS_FORMAT_PLUGIN_FILE
      && rawHasMycoOwnershipSignal(raw) && raw.includes(CREDENTIAL_FLAG);
    const reg = this.manifest.registration;
    const memberMcp = this.resolveAbsoluteMcpTargets().some(({ path: filePath, serversKey }) => {
      const server = this.mycoServerIn(filePath, reg?.mcpFormat === 'toml', reg?.mcpFormat === 'toml' ? TOML_MCP_SERVERS_KEY : serversKey);
      return server !== null && this.isMemberMcpServer(server);
    });
    const member = memberHooks || memberMcp;
    if (member) throw new MemberProvisionConflictError(`Global member hooks at ${target} require member provisioning. Run \`myco member provision ${this.manifest.name}\` from a joined project.`);
  }

  /** A symbiont whose member integration is a plugin file. */
  isMemberPluginFile(): boolean {
    const reg = this.manifest.registration;
    return reg?.hooksFormat === HOOKS_FORMAT_PLUGIN_FILE && Boolean(reg.memberHooksTarget);
  }

  /**
   * The one writer of a member plugin: refuses before any write when the
   * agent's global Myco plugin would keep capturing beside it, or when the
   * project's target file is not Myco's, then writes the rendered plugin into
   * `memberHooksTarget`. The file names this machine's binary, so it is kept
   * out of git.
   */
  private writeMemberPlugin(): boolean {
    const rendered = this.renderMemberPlugin('registry');
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (rendered === null || targetPath === null) return false;
    if (!this.isGlobalScope) this.assertNoMemberPluginConflict();
    this.assertMemberPluginTargetIsMyco(targetPath);
    const written = this.writeManagedFile(targetPath, rendered);
    if (!this.isGlobalScope) this.ensureGitIgnored(targetPath);
    return written;
  }

  /** Refuse to replace a file at the project's plugin path that Myco does not own; it is left as it is. */
  private assertMemberPluginTargetIsMyco(targetPath: string): void {
    let content: string;
    try {
      content = fs.readFileSync(targetPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MemberPluginConflictError(
        `could not read ${targetPath} (${error instanceof Error ? error.message : String(error)}), so nothing was written.`,
      );
    }
    if (content.includes(MYCO_PLUGIN_FILE_MARKER) || rawHasMycoOwnershipSignal(content)) return;
    throw new MemberPluginConflictError(
      `${targetPath} is not a Myco plugin, so nothing was written and it was left as it is. Move it elsewhere if ${this.manifest.displayName} should load Myco's plugin here, then run \`myco member provision ${this.manifest.name}\`.`,
    );
  }

  /**
   * Refuse, before any member write, when the agent's global Myco plugin does
   * not step aside for a project's member plugin: both would load and capture
   * the session twice. Only a missing file, or one Myco does not own, is no
   * global plugin.
   */
  private assertNoMemberPluginConflict(): void {
    const target = this.manifest.registration?.globalHooksTarget;
    if (!target) return;
    const globalPath = expandHome(target);
    let content: string;
    try {
      content = fs.readFileSync(globalPath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw new MemberPluginConflictError(
        `could not read ${globalPath} (${error instanceof Error ? error.message : String(error)}), so nothing was written. Fix the file, then run \`myco member provision ${this.manifest.name}\`.`,
      );
    }
    if (!content.includes(MYCO_PLUGIN_FILE_MARKER) && !rawHasMycoOwnershipSignal(content)) return;
    if (content.includes(MEMBER_PLUGIN_COMPAT_MARKER)) return;
    throw new MemberPluginConflictError(
      `${globalPath} is a Myco plugin that does not step aside for a project's member plugin, so ${this.manifest.displayName} would load both and capture every session twice; nothing was written. Update the Myco install that owns ${globalPath}, then run \`myco member provision ${this.manifest.name}\`.`,
    );
  }

  /**
   * Strip member hook commands from the member target, deleting the file when
   * nothing but an empty hooks map is left. The inverse of
   * `installMemberHooks`, so `myco member leave --purge` removes what
   * provisioning wrote and never touches a key the agent owns.
   */
  uninstallMemberHooks(): boolean {
    const targetPath = this.resolveAbsoluteTarget('hooks');
    if (targetPath === null || !fs.existsSync(targetPath)) return false;
    if (this.isMemberPluginFile()) {
      // Only the member plugin: a 1.4 project plugin at the same path carries the generic marker alone.
      if (!fs.readFileSync(targetPath, 'utf-8').includes(MEMBER_PLUGIN_MARKER)) return false;
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    const settings = readJsonFile(targetPath);
    const existingHooks = (settings.hooks ?? {}) as Record<string, unknown[]>;
    const kept: Record<string, unknown[]> = {};
    let removed = false;
    for (const [event, groups] of Object.entries(existingHooks)) {
      const foreign = withoutMycoHooks(groups as Array<Record<string, unknown>>, command => command.includes(CREDENTIAL_FLAG));
      if (!isDeepStrictEqual(groups, foreign)) removed = true;
      if (foreign.length > 0) kept[event] = foreign;
    }
    if (!removed) return false;
    if (Object.keys(kept).length > 0) {
      settings.hooks = kept;
    } else {
      delete settings.hooks;
    }
    if (Object.keys(settings).length === 0) {
      fs.rmSync(targetPath, { force: true });
      return true;
    }
    return writeJsonFile(targetPath, settings);
  }

  /** Add `targetPath` to `.git/info/exclude` when git does not already ignore it. A path outside any repository needs nothing. */
  private ensureGitIgnored(targetPath: string): void {
    const relative = path.relative(this.projectRoot, targetPath).split(path.sep).join('/');
    try {
      runGit(['check-ignore', '-q', '--', relative], this.projectRoot);
      return;
    } catch {
      // Not ignored, or not a repository — the next call tells the two apart.
    }
    let gitDir: string;
    try {
      gitDir = path.resolve(this.projectRoot, runGit(['rev-parse', '--git-dir'], this.projectRoot));
    } catch {
      return;
    }
    const excludeFile = path.join(gitDir, 'info', 'exclude');
    let existing = '';
    try { existing = fs.readFileSync(excludeFile, 'utf-8'); } catch { /* first entry */ }
    if (existing.split('\n').some((line) => line.trim() === relative)) return;
    fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
    fs.writeFileSync(excludeFile, `${existing}${existing.length > 0 && !existing.endsWith('\n') ? '\n' : ''}${relative}\n`, 'utf-8');
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
    const binaryPath = this.binaryPath();
    const launcherCmd = resolveLauncherCmd(this.installScope, binaryPath);
    const substituted = content.split(MYCO_LAUNCHER_PLACEHOLDER).join(launcherCmd);
    if (substituted.includes(MYCO_MANAGED_MARKER)) return substituted;
    return `${substituted} ${MYCO_MANAGED_MARKER}`;
  }

  /**
   * Name the credential source in a plugin template.
   *
   * A plugin runs the binary's hook verbs, and the binary reads no source the
   * command did not declare. `renderMemberHooks` writes the flag for a
   * config-file symbiont; this writes it for a plugin-file one, so both kinds
   * of install declare where their credential comes from.
   */
  private substituteCredentialSource(content: string, source: CredentialSource = 'registry'): string {
    return content.split(CREDENTIAL_SOURCE_PLACEHOLDER).join(source);
  }

  /**
   * Refuse a rendered template that still carries an install-time placeholder.
   *
   * Checking for the one placeholder this method just substituted can never
   * fire. A template that drifts to a name nothing substitutes renders a
   * plugin that runs `--credential {{…}}`, and the hook runner reports a
   * failed spawn as an absent binary — so the install looks clean and captures
   * nothing.
   */
  private refuseUnsubstituted(rendered: string, what: string): string {
    const left = /\{\{[A-Za-z0-9_.-]+\}\}/.exec(rendered);
    if (left !== null) {
      throw new Error(`Refusing to emit ${what} for symbiont ${this.manifest.name}: ${left[0]} was not substituted`);
    }
    return rendered;
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
  /**
   * The plugin file this symbiont would install, rendered for `source`.
   *
   * A sandbox image ships no registry, so its plugin must name the `env`
   * credential the way a sandbox hook command does. `renderMemberHooks`
   * answers null for a plugin-file symbiont because there is no hook block to
   * write; this is that symbiont's equivalent, and the two are the only places
   * a credential source is chosen.
   */
  renderMemberPlugin(source: CredentialSource): string | null {
    const reg = this.manifest.registration;
    if (reg?.hooksFormat !== HOOKS_FORMAT_PLUGIN_FILE) return null;
    const templateFile = reg.hooksTemplateFile ?? 'plugin.ts';
    if (templateFile.endsWith('.json')) return null;
    const templateContent = this.loadTemplateRaw(templateFile);
    if (templateContent === null) return null;
    const rendered = this.substituteCredentialSource(
      this.substituteMycoLauncher(this.injectSharedPluginHelpers(templateContent)),
      source,
    );
    return this.refuseUnsubstituted(rendered, 'a plugin');
  }

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
      resolved = this.refuseUnsubstituted(
        this.substituteCredentialSource(this.substituteMycoLauncher(withHelpers)),
        'a plugin file',
      );
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
   * Returns true if the file was deleted.
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
  installMcp(): boolean {
    const reg = this.manifest.registration;
    if (!reg) return false;

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
   * server key would leave the stale entry behind and produce duplicate
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
    const stateRoot = this.isGlobalScope ? (this.isMemberScope ? this.memberHomeDir() : resolveMycoHome()) : this.vaultDir;
    const scopeTag = this.isGlobalScope ? 'global' : 'project';
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
    // symbiont's server-key field would leave the stale entry behind.
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
