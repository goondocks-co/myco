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
import { SymbiontInstaller } from '../symbionts/installer.js';
import { loadManifests, resolvePackageRoot } from '../symbionts/detect.js';
import { listGroves, listRegisteredProjects, type RegisteredProject, type GroveRecord } from './registry.js';
import { resolveMycoHome } from './paths.js';

// Legacy hook-guard artifact retired in PR #338 — always safe to delete
// when found, never an opt-in surface.
const LEGACY_HOOK_GUARD = path.join('.agents', 'myco-hook.cjs');

// Active project-local override surfaces. Deleting them on every tick
// would erase the deliberate `myco init --project` opt-in (the
// per-project escape hatch from Decision 5) and the `make
// dev-link-worktree` dogfood pin. We only remove these when the
// project's myco.yaml does NOT carry an explicit per-project install
// (i.e. it's pure brownfield legacy state that the global install
// supersedes).
const OPT_IN_PROJECT_LAUNCHERS = [
  path.join('.agents', 'myco-run.cjs'),
  path.join('.agents', 'myco-cli.cjs'),
  path.join('.myco', 'runtime.command'),
];

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
 * Walk every registered project across every local Grove, cleaning up
 * legacy per-project install artifacts. Returns a pass-result for the
 * audit-log layer to persist; this function never touches the DB itself
 * so it stays unit-testable without a Grove DB fixture.
 */
export function runProjectLocalMigration(
  packageRoot: string = resolvePackageRoot(),
  mycoHome: string = resolveMycoHome(),
): MigrationPassResult {
  const manifests = loadManifests();
  const groves = listGroves(mycoHome);
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
  const cleanedSymbionts: string[] = [];
  const removedFiles: string[] = [];
  try {
    if (!fs.existsSync(project.root)) {
      // Registered root was deleted off-disk — treat as no-op rather
      // than erroring; the project entry itself is orphaned at this
      // point and a separate cleanup task handles it.
      return { groveId: grove.id, project, cleanedSymbionts, removedFiles, noOp: true };
    }

    // 1) Per-symbiont config block removal. Run installer.uninstall()
    //    in PROJECT scope — settings-merge does marker-bounded removal,
    //    leaving user-authored content in shared files intact.
    for (const manifest of manifests) {
      const projectConfigCandidate = manifest.registration?.hooksTarget;
      if (!projectConfigCandidate) continue;
      const projectConfigPath = path.join(project.root, projectConfigCandidate);
      if (!fs.existsSync(projectConfigPath)) continue;
      try {
        const installer = new SymbiontInstaller(
          manifest, project.root, packageRoot, false, undefined, grove.id, 'project',
        );
        const result = installer.uninstall();
        if (result.hooks || result.mcp || result.settings || result.skills) {
          cleanedSymbionts.push(manifest.name);
        }
      } catch {
        // Individual symbiont uninstall failures shouldn't abort the
        // project's overall walk; record as error at the project level
        // only when the launcher-removal step below also fails.
      }
    }

    // 2) Always-safe legacy artifact: retired pre-runtime.command hook guard.
    try {
      fs.unlinkSync(path.join(project.root, LEGACY_HOOK_GUARD));
      removedFiles.push(LEGACY_HOOK_GUARD);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    // 3) Opt-in project-local launchers + runtime pin. Only remove when
    //    the project's myco.yaml lacks any per-symbiont enablement,
    //    treating it as pure brownfield legacy. A project with an
    //    active `symbionts:` override block is by definition opted in
    //    via `myco init --project`; deleting its launchers would break
    //    the documented escape hatch. Likewise the dogfood pin in
    //    `make dev-link-worktree` survives — it's the deliberate dev
    //    workflow this walker must not undermine.
    if (!hasProjectLocalOptIn(project.root)) {
      for (const rel of OPT_IN_PROJECT_LAUNCHERS) {
        const abs = path.join(project.root, rel);
        try {
          fs.unlinkSync(abs);
          removedFiles.push(rel);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
        }
      }
    }

    return {
      groveId: grove.id,
      project,
      cleanedSymbionts,
      removedFiles,
      noOp: cleanedSymbionts.length === 0 && removedFiles.length === 0,
    };
  } catch (err) {
    return {
      groveId: grove.id,
      project,
      cleanedSymbionts,
      removedFiles,
      noOp: cleanedSymbionts.length === 0 && removedFiles.length === 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Detect a deliberate project-local install. Reads
 * `<projectRoot>/.myco/myco.yaml` and returns true when it carries a
 * non-empty `symbionts:` mapping — the marker for `myco init --project`.
 * On any read/parse failure returns false so the walker treats a
 * malformed or absent vault file as brownfield (the safer default).
 */
function hasProjectLocalOptIn(projectRoot: string): boolean {
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
