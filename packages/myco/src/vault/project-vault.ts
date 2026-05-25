import fs from 'node:fs';
import path from 'node:path';
import {
  loadProjectLocalManifest,
  loadProjectManifest,
  saveProjectLocalManifest,
  saveProjectManifest,
  type ProjectLocalManifest,
  type ProjectManifest,
} from '@myco/config/project-manifest.js';
import {
  updateConfig,
  type MycoConfig,
} from '@myco/config/loader.js';
import {
  resolveProjectLocalManifestPath,
  resolveProjectManifestPath,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import {
  assertGroveProjectId,
  createGroveBindingId,
  type GroveProjectId,
} from '@myco/grove/ids.js';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import {
  removeProjectLaunchers,
  type RemoveProjectLaunchersOptions,
} from '@myco/symbionts/installer.js';
import { BUNDLED_TEMPLATES } from '@myco/symbionts/templates.generated.js';
import { ensureVaultGitignoreCurrent } from './gitignore.js';

/**
 * ProjectVault — single capability that owns every write to
 * `<projectRoot>/.myco/` and `<projectRoot>/.agents/`.
 *
 * Why this exists: state coordination across the project's vault files
 * (project.toml + project.local.toml + .gitignore + myco.yaml + launchers
 * + runtime.command) was historically encoded as discipline — each entry
 * point had to remember the multi-file invariant. New entry points
 * routinely missed pieces (binding_id omitted, gitignore not refreshed,
 * legacy artifacts not swept). This capability moves the discipline into
 * a single owner.
 *
 * Authority boundary:
 *   - OWNS: <projectRoot>/.myco/*, <projectRoot>/.agents/myco-*.cjs
 *   - DOES NOT OWN: the Grove registry (`~/.myco/groves/`), the daemon
 *     state (`~/.myco/service/`), the symbiont agent config dirs
 *     (`~/.claude/`, `~/.codex/`, etc.). Those have their own
 *     capabilities (registry helpers, DaemonStateAuthority,
 *     SymbiontInstaller).
 *
 * Invariants this capability guarantees:
 *   1. Every write to a per-machine file (`project.local.toml`,
 *      `runtime.command`) is paired with `ensureGitignore()` so the file
 *      cannot leak to git on the user's next `git add`.
 *   2. Every committed `project.toml` is paired with a
 *      `project.local.toml` carrying `grove_binding.binding_id`. Without
 *      it, the daemon's `assertGroveBound` refuses to start.
 *   3. The "opted-in" marker is the presence of `project.toml`. The
 *      migration walker reads it through `isCommittedToRepo()` so its
 *      definition cannot drift.
 *   4. Retired artifacts (`.agents/myco-hook.cjs`) are always swept on
 *      removal, never preserved by a flag.
 *   5. Schema validation runs on every write. Bypass via
 *      `fs.copyFileSync` is impossible because the helper that does
 *      the copy lives behind this surface.
 */
export class ProjectVault {
  readonly projectRoot: string;
  readonly vaultDir: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
    this.vaultDir = resolveProjectVaultDir(this.projectRoot);
  }

  /** Static factory mirroring the existing convention in this codebase. */
  static atRoot(projectRoot: string): ProjectVault {
    return new ProjectVault(projectRoot);
  }

  // -------------------------------------------------------------------
  // Queries
  // -------------------------------------------------------------------

  /** Read the committed manifest if present. */
  readManifest(): ProjectManifest | null {
    return loadProjectManifest(this.vaultDir);
  }

  /** Read the per-machine binding manifest if present. */
  readLocalManifest(): ProjectLocalManifest | null {
    return loadProjectLocalManifest(this.vaultDir);
  }

  /** True iff `<projectRoot>/.myco/project.toml` exists. */
  isCommittedToRepo(): boolean {
    return fs.existsSync(resolveProjectManifestPath(this.vaultDir));
  }

  /**
   * Single source of truth for the project's vault lifecycle. The
   * migration walker, UI status badges, and CLI doctor all derive their
   * decisions from this enum — never from a hand-rolled file probe.
   */
  state(): ProjectLifecycleState {
    if (!fs.existsSync(this.vaultDir)) return { kind: 'unmanaged' };
    let manifest: ProjectManifest | null;
    try {
      manifest = this.readManifest();
    } catch {
      return { kind: 'committed-broken', reason: 'invalid-manifest' };
    }
    if (!manifest) return { kind: 'auto-registered' };
    return {
      kind: 'committed',
      projectId: manifest.project.id as GroveProjectId,
      groveId: manifest.grove?.id ?? null,
      hasLaunchers: this.hasLaunchers(),
      hasRuntimePin: this.hasRuntimePin(),
    };
  }

  hasLaunchers(): boolean {
    return fs.existsSync(path.join(this.projectRoot, '.agents', 'myco-run.cjs'));
  }

  hasRuntimePin(): boolean {
    return fs.existsSync(path.join(this.projectRoot, '.myco', 'runtime.command'));
  }

  // -------------------------------------------------------------------
  // Lifecycle operations
  // -------------------------------------------------------------------

  /**
   * Commit Myco config to the repo: portable Grove identity in
   * `project.toml`, per-machine binding in `project.local.toml`,
   * optional project-local launchers and runtime-command pin.
   *
   * Refuses (409-shaped) when an existing project.toml binds a
   * different `project.id` — the caller must reconcile before
   * overwriting a foreign identity.
   *
   * Idempotent: re-running with the same identity is a no-op against
   * the file contents (the manifest writers merge), but the gitignore
   * and binding_id are refreshed on every call.
   */
  commitToRepo(opts: CommitToRepoOptions): CommitResult {
    const existing = this.readManifest();
    if (existing && existing.project.id !== opts.project.id) {
      throw new ProjectIdMismatchError(existing.project.id, opts.project.id);
    }

    const wrote: string[] = [];

    saveProjectManifest(this.vaultDir, {
      project: {
        id: assertGroveProjectId(opts.project.id),
        name: opts.project.name,
      },
      grove: {
        id: opts.grove.id,
        slug: opts.grove.slug,
        name: opts.grove.name,
      },
    });
    wrote.push(this.rel(resolveProjectManifestPath(this.vaultDir)));

    // Per-machine binding lives in project.local.toml. Without it the
    // daemon refuses to bind to this vault. Preserve any existing
    // binding_id (so re-commit is stable) and otherwise mint a fresh
    // local-mode binding.
    const existingLocal = this.readLocalManifest();
    const bindingId =
      existingLocal?.grove_binding?.binding_id ?? createGroveBindingId();
    saveProjectLocalManifest(this.vaultDir, {
      grove_binding: { binding_id: bindingId, mode: 'local' },
    });

    if (opts.writeLaunchers) {
      const template = BUNDLED_TEMPLATES['myco-run.cjs'];
      if (!template) throw new Error('Bundled myco-run.cjs template is unavailable');
      const agentsDir = path.join(this.projectRoot, '.agents');
      fs.mkdirSync(agentsDir, { recursive: true });
      for (const rel of LAUNCHER_FILES) {
        const absPath = path.join(this.projectRoot, rel);
        atomicWriteFileSync(absPath, template);
        wrote.push(rel);
      }
    }

    if (opts.runtimeCommand !== undefined) {
      if (!path.isAbsolute(opts.runtimeCommand)) {
        throw new InvalidRuntimeCommandError(opts.runtimeCommand);
      }
      const absPath = path.join(this.projectRoot, RUNTIME_COMMAND_REL);
      fs.mkdirSync(path.dirname(absPath), { recursive: true });
      atomicWriteFileSync(absPath, `${opts.runtimeCommand.trim()}\n`);
      wrote.push(RUNTIME_COMMAND_REL);
    }

    this.ensureGitignore();
    return { wrote, bindingId };
  }

  /**
   * Remove the committed Myco config. By default sweeps everything
   * `commitToRepo` could have written: project.toml, project.local.toml,
   * launchers, runtime.command. Power users can preserve the launchers
   * and/or runtime pin via opts.
   *
   * The retired `.agents/myco-hook.cjs` guard is ALWAYS swept,
   * regardless of opts — it's never something a deliberate workflow
   * wants to keep, and the migration walker invariant assumes it's
   * cleaned on every removal opportunity.
   */
  uncommitFromRepo(opts: UncommitFromRepoOptions = {}): UncommitResult {
    const removeLaunchers = opts.removeLaunchers !== false;
    const removeRuntime = opts.removeRuntimeCommand !== false;
    const removed: string[] = [];

    for (const target of [
      resolveProjectManifestPath(this.vaultDir),
      resolveProjectLocalManifestPath(this.vaultDir),
    ]) {
      if (!fs.existsSync(target)) continue;
      try {
        fs.unlinkSync(target);
        removed.push(this.rel(target));
      } catch (err) {
        throw new VaultWriteError(`Could not remove ${target}: ${(err as Error).message}`);
      }
    }

    const swept = removeProjectLaunchers(this.projectRoot, {
      legacy: true,
      active: removeLaunchers,
      runtimeCommand: removeRuntime,
    });
    removed.push(...swept);

    return { removed };
  }

  // -------------------------------------------------------------------
  // Symbiont overrides
  // -------------------------------------------------------------------

  /**
   * Patch the project's `symbionts.<name>.enabled` flag in myco.yaml.
   * Auto-creates myco.yaml (and the gitignore) if the project is
   * auto-registered but hasn't been written before. Routes through
   * `updateConfig()` per the single-config-write-path invariant.
   */
  setSymbiontEnabled(name: string, enabled: boolean): MycoConfig {
    this.ensureMinimalConfig();
    this.ensureGitignore();
    return updateConfig(this.vaultDir, (config) => {
      const next = { ...config };
      const symbionts = { ...(config.symbionts ?? {}) };
      symbionts[name] = { ...symbionts[name], enabled };
      next.symbionts = symbionts;
      return next;
    });
  }

  /** Remove the per-project override for `name`, falling back to the higher-tier default. */
  clearSymbiontOverride(name: string): MycoConfig {
    this.ensureMinimalConfig();
    this.ensureGitignore();
    return updateConfig(this.vaultDir, (config) => {
      const next = { ...config };
      const symbionts = { ...(config.symbionts ?? {}) };
      delete symbionts[name];
      next.symbionts = symbionts;
      return next;
    });
  }

  // -------------------------------------------------------------------
  // Lower-level operations (used by the registry / activation / move /
  // claim paths that already construct a manifest in flight)
  // -------------------------------------------------------------------

  /**
   * Write a pre-constructed manifest pair atomically. The local
   * manifest's binding_id is preserved when present; otherwise a fresh
   * local-mode binding is minted. Always refreshes the gitignore.
   *
   * Used by code paths (activation, binding, move, claim) that have
   * domain-specific logic to construct the manifest before persisting.
   */
  writeIdentity(opts: WriteIdentityOptions): WriteIdentityResult {
    saveProjectManifest(this.vaultDir, opts.manifest);
    let bindingId: string | null = null;
    if (opts.localManifest) {
      saveProjectLocalManifest(this.vaultDir, opts.localManifest);
      bindingId = opts.localManifest.grove_binding?.binding_id ?? null;
    } else if (opts.preserveLocalManifest !== false) {
      const existing = this.readLocalManifest();
      if (!existing?.grove_binding) {
        bindingId = createGroveBindingId();
        saveProjectLocalManifest(this.vaultDir, {
          grove_binding: { binding_id: bindingId, mode: 'local' },
        });
      } else {
        bindingId = existing.grove_binding.binding_id;
      }
    }
    this.ensureGitignore();
    return { bindingId };
  }

  /**
   * Idempotent gitignore refresh. Used by `myco update`'s vault sweep
   * and as the internal pairing call for every mutating operation in
   * this capability. Direct callers (i.e. anything outside this class)
   * should be rare — usually the per-operation methods already invoke
   * this for you.
   */
  ensureGitignore(): boolean {
    return ensureVaultGitignoreCurrent(this.vaultDir);
  }

  /**
   * Ensure `<vaultDir>/myco.yaml` exists with at least a `version: 3`
   * stub so `loadConfig` succeeds. Returns true if the file was just
   * materialized.
   *
   * Project that's only auto-registered has no myco.yaml until a
   * settings-write call lands. This method is the materialization
   * point.
   */
  ensureMinimalConfig(): boolean {
    const configPath = path.join(this.vaultDir, 'myco.yaml');
    if (fs.existsSync(configPath)) return false;
    fs.mkdirSync(this.vaultDir, { recursive: true });
    fs.writeFileSync(configPath, 'version: 3\n', { mode: 0o600 });
    return true;
  }

  // -------------------------------------------------------------------
  // Helpers (private)
  // -------------------------------------------------------------------

  private rel(absPath: string): string {
    return path.relative(this.projectRoot, absPath);
  }
}

// =====================================================================
// Types
// =====================================================================

export type ProjectLifecycleState =
  | { kind: 'unmanaged' }
  | { kind: 'auto-registered' }
  | {
    kind: 'committed';
    projectId: GroveProjectId;
    groveId: string | null;
    hasLaunchers: boolean;
    hasRuntimePin: boolean;
  }
  | { kind: 'committed-broken'; reason: 'invalid-manifest' };

export interface CommitToRepoOptions {
  project: { id: string; name: string };
  grove: { id: string; slug: string; name: string };
  writeLaunchers?: boolean;
  runtimeCommand?: string;
}

export interface CommitResult {
  wrote: string[];
  bindingId: string;
}

export interface UncommitFromRepoOptions {
  removeLaunchers?: boolean;
  removeRuntimeCommand?: boolean;
}

export interface UncommitResult {
  removed: string[];
}

export interface WriteIdentityOptions {
  manifest: ProjectManifest;
  /** Explicit local manifest override (e.g., when migrating from a combined manifest). */
  localManifest?: ProjectLocalManifest;
  /**
   * When true (default), the local manifest's binding_id is preserved
   * across the call (a fresh one is minted only when absent). Set to
   * false to skip the local manifest write entirely — used by code
   * paths that write the local manifest separately (e.g.
   * `migrateCombinedManifest` constructs it from legacy combined shape).
   */
  preserveLocalManifest?: boolean;
}

export interface WriteIdentityResult {
  bindingId: string | null;
}

// =====================================================================
// Errors (typed so HTTP handlers can map to specific envelopes)
// =====================================================================

export class ProjectIdMismatchError extends Error {
  constructor(public readonly committedId: string, public readonly requestedId: string) {
    super(
      `Committed project.toml binds id ${committedId}; the request supplied ${requestedId}. ` +
      `Reconcile before re-committing.`,
    );
    this.name = 'ProjectIdMismatchError';
  }
}

export class InvalidRuntimeCommandError extends Error {
  constructor(public readonly value: string) {
    super(`runtime_command must be an absolute path; got ${JSON.stringify(value)}`);
    this.name = 'InvalidRuntimeCommandError';
  }
}

export class VaultWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VaultWriteError';
  }
}

// =====================================================================
// Constants (private to this module)
// =====================================================================

const LAUNCHER_FILES = [
  path.join('.agents', 'myco-run.cjs'),
  path.join('.agents', 'myco-cli.cjs'),
] as const;

const RUNTIME_COMMAND_REL = path.join('.myco', 'runtime.command');

// =====================================================================
// Migration walker helper — single source of truth for "opted in"
// =====================================================================

/**
 * Single source of truth for whether a project at `projectRoot` has
 * opted into the dashboard's commit-to-repo flow. Used by the migration
 * walker (which must preserve committed-project launchers) and by UI
 * status badges. Defined here, not in migration-walker.ts, so the
 * marker definition cannot drift from the writer.
 */
export function projectHasCommittedConfig(projectRoot: string): boolean {
  return new ProjectVault(projectRoot).isCommittedToRepo();
}

// Re-export the launcher-cleanup helper through this module so the
// walker can reference it without going around the capability.
export type { RemoveProjectLaunchersOptions };
