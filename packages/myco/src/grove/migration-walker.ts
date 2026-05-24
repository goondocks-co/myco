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
import { listGroves, listRegisteredProjects, findProjectByRoot, type DaemonVariant, type RegisteredProject, type GroveRecord } from './registry.js';
import { resolveMycoHome, currentDaemonVariant, resolveLegacyLauncherCleanupIntentPath, pathsEquivalent } from './paths.js';
import { assertSafeProjectRoot } from '../vault/resolve.js';

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
  const visited = new Set<string>();
  for (const grove of groves) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      outcomes.push(migrateOneProject(grove, project, manifests, packageRoot));
      visited.add(path.resolve(project.root));
    }
  }

  // Brownfield orphan pass. The global launcher writes legacy stub
  // discoveries into `~/.myco/intents/legacy-launcher-cleanup.txt` so
  // projects that pre-date the global-install rollout — and therefore
  // were never auto-registered — still reach the walker. Drain the file,
  // synthesize per-root walker entries, then call the same
  // `migrateOneProject` path with a `null` Grove (no Grove binding
  // exists for an unregistered project; `SymbiontInstaller` accepts
  // `null` group-id and its config lookup fails closed).
  const brownfieldRoots = drainLegacyLauncherCleanupIntent(mycoHome);
  for (const root of brownfieldRoots) {
    const resolved = path.resolve(root);
    if (visited.has(resolved)) continue;
    // Skip if the project IS registered (race between hook fire and a
    // later `ensureProjectRegistered`); a registered project will be
    // walked through the registry path on the next tick anyway.
    if (findProjectByRoot(resolved, mycoHome)) continue;
    // Defense in depth: refuse to walk obviously-dangerous roots ($HOME, /,
    // a direct child of /Users) even if the launcher queued one — the
    // launcher does its own safety check, but a hostile or buggy hook
    // payload could still land here. The git-signal check from
    // `isSafeProjectRoot` is NOT applied because the walker is performing
    // cleanup, not registration; a brownfield project rarely has `.git`
    // resolvable from a daemon process running with a sanitized PATH.
    try { assertSafeProjectRoot(resolved); } catch { continue; }
    if (!fs.existsSync(path.join(resolved, '.agents', 'myco-run.cjs'))) continue;
    const synthetic: RegisteredProject = {
      project_id: '',
      name: path.basename(resolved),
      root: resolved,
      created_at: new Date(0).toISOString(),
      updated_at: new Date(0).toISOString(),
    };
    outcomes.push(migrateOneProject(null, synthetic, manifests, packageRoot));
    visited.add(resolved);
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

/**
 * Read and clear `~/.myco/intents/legacy-launcher-cleanup.txt`. Returns
 * the deduped, trimmed list of project roots the global launcher has
 * queued for walker cleanup since the last drain.
 *
 * Returns an empty array when the intent file is absent or unreadable —
 * the launcher always treats writes as best-effort, so an absent file
 * is the steady state. Unlinking the file rather than truncating avoids
 * the truncate-vs-append race on a launcher firing during the drain:
 * any append between read and unlink lands in a re-created file the
 * NEXT pass will see, instead of being silently overwritten.
 */
export function drainLegacyLauncherCleanupIntent(
  mycoHome: string = resolveMycoHome(),
): string[] {
  const intentPath = resolveLegacyLauncherCleanupIntentPath(mycoHome);
  let raw: string;
  try {
    raw = fs.readFileSync(intentPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return [];
  }
  try { fs.unlinkSync(intentPath); } catch { /* concurrent drain — acceptable */ }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const resolved = path.resolve(trimmed);
    // Dedup using inode equivalence so two textual variants of the same
    // path (symlink chain, APFS case differences) collapse to one entry.
    let alreadySeen = false;
    for (const prior of out) {
      if (pathsEquivalent(prior, resolved)) { alreadySeen = true; break; }
    }
    if (alreadySeen) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

function migrateOneProject(
  grove: GroveRecord | null,
  project: RegisteredProject,
  manifests: SymbiontManifest[],
  packageRoot: string,
): ProjectMigrationOutcome {
  // A null `grove` marks a brownfield orphan: a project not registered
  // in any Grove, queued for cleanup via the launcher cleanup intent
  // file. The cleanup steps below all operate at the project-root level
  // — they read no Grove-scoped state — so the null path is safe; the
  // outcome's `groveId` falls back to an empty string for the audit log.
  const groveId = grove?.id ?? '';
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
          manifest, project.root, packageRoot, false, undefined, grove?.id ?? null, 'project',
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
    //    the project has opted into a per-project install via
    //    `myco init --project` (signaled by a non-empty `symbionts:`
    //    block in myco.yaml). The shared helper enforces the file
    //    list — drift between walker, `myco remove`, and uninstall
    //    is structurally impossible.
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
 * Detect a deliberate project-local install. Reads
 * `<projectRoot>/.myco/myco.yaml` and returns true when it carries a
 * non-empty `symbionts:` mapping — the marker for `myco init --project`.
 * On any read/parse failure returns false so the walker treats a
 * malformed or absent vault file as brownfield (the safer default).
 */
export function hasProjectLocalOptIn(projectRoot: string): boolean {
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
