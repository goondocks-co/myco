/**
 * Global-install migration walker (Steps 8 + 9).
 *
 * Sweeps registered projects for legacy per-project install artifacts and
 * cleans them up: the `.agents/myco-run.cjs` + `myco-cli.cjs` launchers
 * and any per-symbiont Myco-marker block written into project-local
 * agent config files (`.claude/settings.json`, `.codex/hooks.json`, etc.).
 *
 * Idempotent: a project with no legacy artifacts is a no-op. Safe to run
 * on every periodic detection tick — the cost is one stat per legacy
 * path per registered project.
 *
 * Outcomes flow through `recordMigrationPass` in `migration-log.ts`,
 * which writes a bounded audit log (one pass-summary row + one row per
 * error) and emits a completion notification.
 */

import fs from 'node:fs';
import path from 'node:path';
import type { SymbiontManifest } from '../symbionts/manifest-schema.js';
import { SymbiontInstaller, removeProjectLaunchers } from '../symbionts/installer.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { listGroves, listRegisteredProjects, type DaemonVariant, type RegisteredProject, type GroveRecord } from './registry.js';
import { resolveMycoHome, currentDaemonVariant } from './paths.js';

// Project-local cleanup runs through `removeProjectLaunchers`
// (installer.ts) — the single source of truth for which files count
// as Myco's project launcher set. The walker opts active launchers
// + runtime pin in/out via the helper's options shape based on the
// project's `symbionts:` opt-in.

export interface ProjectMigrationOutcome {
  groveId: string;
  project: RegisteredProject;
  /** Per-symbiont config blocks removed (manifest names). */
  cleanedSymbionts: string[];
  /** Project-local launcher files actually deleted (paths relative to projectRoot). */
  removedFiles: string[];
  /** True when nothing on this project needed cleaning. */
  noOp: boolean;
  /** Populated when this project's migration threw — pass-level state stays consistent. */
  error?: string;
}

export interface MigrationPassResult {
  passId: string;
  passedAt: number;
  projectsVisited: number;
  projectsCleaned: number;
  projectsErrored: number;
  outcomes: ProjectMigrationOutcome[];
}

/**
 * Walk every registered project in the Groves THIS DAEMON SERVES,
 * cleaning up legacy per-project install artifacts.
 *
 * Hard scope: walker invocations stay inside the Grove-ownership
 * boundary. Each Grove has one owner via `grove.toml served_by`, and
 * cross-daemon mutation is forbidden by the same rule that gates
 * SQLite access. A daemon walks its own projects only.
 *
 * `servedBy` defaults to the current process's daemon variant (dev vs
 * prod); tests and CLI commands run outside a daemon pass it explicitly.
 *
 * Returns a pass-result for the audit-log layer to persist; this
 * function never touches the DB itself so it stays unit-testable
 * without a Grove DB fixture.
 */
export function runProjectLocalMigration(
  packageRoot: string = resolvePackageRoot(),
  mycoHome: string = resolveMycoHome(),
  servedBy: DaemonVariant = currentDaemonVariant(),
): MigrationPassResult {
  const manifests = loadManifests();
  const groves = listGroves(mycoHome, { servedBy });
  const outcomes: ProjectMigrationOutcome[] = [];
  for (const grove of groves) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      outcomes.push(migrateOneProject(grove, project, manifests, packageRoot));
    }
  }

  return {
    passId: cryptoRandomId(),
    passedAt: Math.floor(Date.now() / 1000),
    projectsVisited: outcomes.length,
    projectsCleaned: outcomes.filter((o) => !o.noOp && !o.error).length,
    projectsErrored: outcomes.filter((o) => !!o.error).length,
    outcomes,
  };
}

function migrateOneProject(
  grove: GroveRecord,
  project: RegisteredProject,
  manifests: SymbiontManifest[],
  packageRoot: string,
): ProjectMigrationOutcome {
  const groveId = grove.id;
  const cleanedSymbionts: string[] = [];
  const removedFiles: string[] = [];
  try {
    if (!fs.existsSync(project.root)) {
      // Registered root was deleted off-disk — treat as no-op rather
      // than erroring; the project entry itself is orphaned at this
      // point and a separate cleanup task handles it.
      return { groveId, project, cleanedSymbionts, removedFiles, noOp: true };
    }

    // 1) Per-symbiont config block removal. Run installer.uninstall()
    //    in PROJECT scope — settings-merge does marker-bounded removal,
    //    leaving user-authored content in shared files intact.
    //
    //    `keepProjectContent: true` prevents the walker from scrubbing
    //    project-content surfaces (`.gitignore` Myco-managed block,
    //    instruction stubs) on every detect tick. Those surfaces are
    //    project-level concerns that survive a per-symbiont uninstall
    //    — `.gitignore` plan-capture entries stay relevant whether the
    //    install is project- or global-scoped, and instruction stubs
    //    reference AGENTS.md which outlives any single symbiont. Only
    //    `myco remove`/`myco remove --purge` ever asks for them gone.
    for (const manifest of manifests) {
      const projectConfigCandidate = manifest.registration?.hooksTarget;
      if (!projectConfigCandidate) continue;
      const projectConfigPath = path.join(project.root, projectConfigCandidate);
      if (!fs.existsSync(projectConfigPath)) continue;
      try {
        const installer = new SymbiontInstaller(
          manifest, project.root, packageRoot, false, undefined, grove.id, 'project',
        );
        const result = installer.uninstall({ keepProjectContent: true });
        if (result.hooks || result.mcp || result.settings || result.skills) {
          cleanedSymbionts.push(manifest.name);
        }
      } catch {
        // Individual symbiont uninstall failures shouldn't abort the
        // project's overall walk; record as error at the project level
        // only when the launcher-removal step below also fails.
      }
    }

    // 2) Reconcile the project-content `.gitignore` Myco block. The
    //    walker runs every detect tick, so this is the per-project
    //    forward-correctness path: drift (missing block, stale skill
    //    entries, hand-deleted lines) self-heals on next tick. Idempotent
    //    — no write when the existing block already matches desired.
    //
    //    Uses the first manifest with a skillsTarget as a sentinel.
    //    `updateGitignore()` is project-rooted, not symbiont-specific —
    //    once is enough.
    const gitignoreManifest = manifests.find((m) => m.registration?.skillsTarget);
    if (gitignoreManifest) {
      try {
        const reconciler = new SymbiontInstaller(
          gitignoreManifest, project.root, packageRoot, false, undefined, grove.id, 'project',
        );
        reconciler.reconcileProjectGitignore();
      } catch {
        // Gitignore drift recovery is best-effort — log nothing, retry
        // next tick. A truly broken project tree surfaces via the
        // existing launcher-cleanup error path below.
      }
    }

    // 3) Project launcher cleanup. Retired artifacts are always
    //    removed; active launchers + the dev pin are preserved when
    //    the project has opted into a per-project install via the
    //    dashboard's commit-to-repo affordance (signaled by a
    //    non-empty `symbionts:` block in myco.yaml). The shared
    //    helper enforces the file list — drift between walker,
    //    `myco remove`, and uninstall is structurally impossible.
    const optIn = hasProjectLocalOptIn(project.root);
    removedFiles.push(...removeProjectLaunchers(project.root, {
      legacy: true,
      active: !optIn,
      runtimeCommand: !optIn,
    }));

    return {
      groveId,
      project,
      cleanedSymbionts,
      removedFiles,
      noOp: cleanedSymbionts.length === 0 && removedFiles.length === 0,
    };
  } catch (err) {
    return {
      groveId,
      project,
      cleanedSymbionts,
      removedFiles,
      noOp: cleanedSymbionts.length === 0 && removedFiles.length === 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect a deliberate project-local install. Two markers count, either
 * one is sufficient:
 *
 *   1. `<projectRoot>/.myco/project.toml` exists — the dashboard's
 *      commit-to-repo affordance writes it. The artifact's presence
 *      IS the opt-in; subsequent walker passes must preserve any
 *      launchers + runtime.command pin the user also chose to commit.
 *   2. `<projectRoot>/.myco/myco.yaml` carries a non-empty `symbionts:`
 *      mapping — historical marker from the per-project `myco init`
 *      era. Retained so brownfield projects that opted in via the
 *      old CLI surface still survive the walker.
 *
 * On any read/parse failure returns false so the walker treats a
 * malformed or absent vault file as brownfield (the safer default).
 */
export function hasProjectLocalOptIn(projectRoot: string): boolean {
  if (fs.existsSync(path.join(projectRoot, '.myco', 'project.toml'))) return true;
  const ymlPath = path.join(projectRoot, '.myco', 'myco.yaml');
  try {
    const raw = fs.readFileSync(ymlPath, 'utf-8');
    // Cheap presence check — full YAML parse only if the substring hits.
    if (!raw.includes('symbionts:')) return false;
    // Match `symbionts:` followed by at least one indented entry.
    return /(^|\n)symbionts:\s*\n\s+\S/.test(raw);
  } catch {
    return false;
  }
}

function cryptoRandomId(): string {
  // 8-byte hex id — sufficient for tagging a pass without bringing in
  // node:crypto for what's effectively an audit-log correlation key.
  return Math.random().toString(16).slice(2, 10) + Math.random().toString(16).slice(2, 10);
}
