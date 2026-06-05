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
  loadConfig,
  updateConfig,
} from '@myco/config/loader.js';
import type { MycoConfig } from '@myco/config/schema.js';
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
  // Symbiont overrides
  // -------------------------------------------------------------------

  /**
   * Patch the project's `symbionts:` block atomically. Each entry in
   * `patch` is either `{ enabled }` (set the override) or `null` (clear
   * the override). The whole batch runs through ONE `updateConfig` call,
   * so a partial failure means no entries land — restoring the
   * atomicity contract the pre-capability handler relied on.
   *
   * Always returns the post-write config (fresh read), so an empty
   * patch returns the current on-disk state instead of an empty
   * surrogate.
   */
  patchSymbiontOverrides(patch: Record<string, SymbiontOverride>): MycoConfig {
    this.ensureMinimalConfig();
    this._ensureGitignore();
    if (Object.keys(patch).length === 0) {
      // Empty patch: nothing to write, but the response must still
      // reflect the current on-disk state so an empty PATCH body
      // surfaces the live config rather than `{}`.
      return loadConfig(this.vaultDir);
    }
    return updateConfig(this.vaultDir, (config) => {
      const next = { ...config };
      const symbionts = { ...(config.symbionts ?? {}) };
      for (const [name, entry] of Object.entries(patch)) {
        if (entry === null) {
          delete symbionts[name];
        } else {
          symbionts[name] = { ...symbionts[name], enabled: entry.enabled };
        }
      }
      next.symbionts = symbionts;
      return next;
    });
  }

  /** Single-entry helper. Routes through {@link patchSymbiontOverrides} for atomicity parity. */
  setSymbiontEnabled(name: string, enabled: boolean): MycoConfig {
    return this.patchSymbiontOverrides({ [name]: { enabled } });
  }

  /** Single-entry helper. Routes through {@link patchSymbiontOverrides}. */
  clearSymbiontOverride(name: string): MycoConfig {
    return this.patchSymbiontOverrides({ [name]: null });
  }

  /**
   * Toggle project-level symbiont customization as a whole.
   *
   *   `enabled: true`  — ensure the `symbionts:` block exists.  Pre-
   *                      populates it from `seed` so every detected
   *                      symbiont has a row the UI can render with a
   *                      toggle.  Idempotent — re-enabling without a
   *                      seed leaves any current entries untouched.
   *   `enabled: false` — REMOVE the block entirely.  The project then
   *                      follows the global defaults again.  Atomic.
   *
   * Same single-write contract as `patchSymbiontOverrides`.
   */
  setProjectCustomization(enabled: boolean, seed?: string[]): MycoConfig {
    this.ensureMinimalConfig();
    this._ensureGitignore();
    return updateConfig(this.vaultDir, (config) => {
      const next = { ...config };
      if (!enabled) {
        delete next.symbionts;
        return next;
      }
      const existing = config.symbionts ?? {};
      if (Object.keys(existing).length > 0) {
        next.symbionts = existing;
        return next;
      }
      const populated: Record<string, { enabled: boolean }> = {};
      for (const name of seed ?? []) populated[name] = { enabled: true };
      next.symbionts = populated;
      return next;
    });
  }

  /**
   * Remove every project-local file this capability owns. Used by project
   * archive/delete lifecycle paths so ghost readmission cannot leave a
   * launcher behind that recreates `.myco/` outside the admission flow.
   */
  removeManagedProjectFiles(): void {
    removeProjectLaunchers(this.projectRoot, {
      legacy: true,
      active: true,
      runtimeCommand: true,
    });
    fs.rmSync(this.vaultDir, { recursive: true, force: true });
  }

  // -------------------------------------------------------------------
  // Lower-level operations (used by the registry / activation / move /
  // claim paths that already construct a manifest in flight)
  // -------------------------------------------------------------------

  /**
   * Write a pre-constructed manifest pair. The local manifest's
   * binding_id is preserved when present; otherwise a fresh local-mode
   * binding is minted. Gitignore is structurally guaranteed via
   * `_writePerMachineFile`.
   *
   * Three modes, controlled by opts.mode (default 'both'):
   *   - 'both' (default): write project.toml AND project.local.toml
   *   - 'manifest-only': write project.toml, do not touch local.toml
   *   - 'local-only': skip project.toml, write only the per-machine binding
   *
   * The asymmetric modes exist because activation's repair branch
   * (manifest present on disk but binding missing) and similar legacy
   * flows need to restore the binding without overwriting a possibly-
   * hand-edited manifest.
   */
  writeIdentity(opts: WriteIdentityOptions): WriteIdentityResult {
    const mode = opts.mode ?? 'both';

    if (mode !== 'local-only') {
      saveProjectManifest(this.vaultDir, opts.manifest);
    }

    let bindingId: string | null = null;

    if (mode === 'manifest-only') {
      // Caller asked to preserve the on-disk local manifest. Still
      // refresh the gitignore in case a previous writer skipped it.
      this._ensureGitignore();
      return { bindingId };
    }

    if (opts.localManifest) {
      this._writePerMachineFile(resolveProjectLocalManifestPath(this.vaultDir), () => {
        saveProjectLocalManifest(this.vaultDir, opts.localManifest!);
      });
      bindingId = opts.localManifest.grove_binding?.binding_id ?? null;
    } else {
      const existing = this.readLocalManifest();
      if (!existing?.grove_binding) {
        bindingId = createGroveBindingId();
        this._writePerMachineFile(resolveProjectLocalManifestPath(this.vaultDir), () => {
          saveProjectLocalManifest(this.vaultDir, {
            grove_binding: { binding_id: bindingId!, mode: 'local' },
          });
        });
      } else {
        bindingId = existing.grove_binding.binding_id;
        // No write needed; existing local.toml is fine. Still ensure
        // gitignore covers it.
        this._ensureGitignore();
      }
    }
    return { bindingId };
  }

  /**
   * Public gitignore-refresh entry point. Used by `myco update`'s vault
   * sweep — the one external caller that legitimately writes nothing
   * else but still wants the gitignore current.
   */
  ensureGitignore(): boolean {
    return this._ensureGitignore();
  }

  // -------------------------------------------------------------------
  // Structural per-machine-write guarantee
  // -------------------------------------------------------------------

  /**
   * **Structural** invariant: every per-machine bytes write goes
   * through this helper, which guarantees the canonical
   * `.myco/.gitignore` exists on disk BEFORE the per-machine file does.
   * If the wrapped write throws, the gitignore is already there — so
   * the partial state is still safe to `git status`.
   *
   * This replaces the historical "remember to call ensureGitignore"
   * convention, which produced gitignore-skipping bug classes whenever
   * an entry point forgot the pairing or put the call in the wrong
   * order.
   */
  private _writePerMachineFile(_absPath: string, write: () => void): void {
    this._ensureGitignore();
    write();
  }

  private _ensureGitignore(): boolean {
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

export interface WriteIdentityOptions {
  manifest: ProjectManifest;
  /** Explicit local manifest override (e.g., when migrating from a combined manifest). */
  localManifest?: ProjectLocalManifest;
  /**
   * Which files to write. Defaults to `'both'`.
   *   - `'both'`: write project.toml AND project.local.toml (default)
   *   - `'manifest-only'`: write project.toml, leave local.toml alone
   *   - `'local-only'`: skip project.toml, write only the per-machine binding
   *
   * The asymmetric modes exist for legacy flows (activation repair,
   * snapshot restore, migrate-combined-manifest) where the symmetric
   * write would clobber state the caller wants to preserve.
   */
  mode?: 'both' | 'manifest-only' | 'local-only';
}

/** Symbiont override patch entry: `{ enabled }` to set, `null` to clear. */
export type SymbiontOverride = { enabled: boolean } | null;

export interface WriteIdentityResult {
  bindingId: string | null;
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
// Committed-config helper — single source of truth
// =====================================================================

/**
 * Single source of truth for whether a project at `projectRoot` has its
 * Myco identity committed to the repo (a tracked `project.toml`). Used by
 * the migration and UI status badges. Defined here, not in
 * global-install-migration.ts, so the marker definition cannot drift from
 * the writer.
 */
export function projectHasCommittedConfig(projectRoot: string): boolean {
  return new ProjectVault(projectRoot).isCommittedToRepo();
}

// Re-export the launcher-cleanup helper through this module so the
// walker can reference it without going around the capability.
export type { RemoveProjectLaunchersOptions };
