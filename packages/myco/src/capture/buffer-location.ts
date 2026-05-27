/**
 * Where a project's capture buffer lives.
 *
 * One buffer dir per project, located under the global Grove tree at
 * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/`. The buffer's
 * shape and lifecycle are unchanged from the legacy project-local layout;
 * only the home moved.
 *
 * There is NO legacy fallback. A class of Grove-migration regressions
 * traced back to "if no global match, fall back to project-local" silently
 * writing to an unexpected location and producing divergent state. Callers
 * that can't resolve a `(groveId, projectId)` pair MUST treat that as a
 * hard miss — log it and refuse the write, not invent a fallback path.
 * Auto-registration on first hook (Step 13) is the safety net that ensures
 * the resolver always succeeds for live capture.
 */

import { resolveProjectBufferDir, resolveMycoHome, currentDaemonVariant } from '../grove/paths.js';
import {
  ensureProjectRegistered,
  findProjectByRoot,
  listGroves,
  listRegisteredProjects,
} from '../grove/registry.js';

export interface ProjectBufferLocation {
  /** Owning Grove id. */
  groveId: string;
  /** Owning project id. */
  projectId: string;
  /** Absolute path to the project's buffer dir under the global Grove tree. */
  bufferDir: string;
}

/**
 * Resolve the buffer dir for a project given its filesystem root.
 *
 * If the project isn't yet registered, attempts to auto-register it
 * under the machine default Grove (Step 13's safety net). Returns
 * `null` only when:
 *
 *   - the path fails `isSafeProjectRoot` (cwd-fallback paths from a
 *     misfired hook, $HOME-rooted invocations) — `ensureProjectRegistered`
 *     refuses these structurally, so no Canopy storm / no orphan
 *     project entries; or
 *   - the machine has no default Grove yet — only possible if a hook
 *     fires BEFORE `runGlobalBootstrap()` has run (daemon first-start
 *     ordering). In practice this should never happen on a healthy
 *     daemon: `runGlobalBootstrap()` is the first thing the daemon
 *     does on startup, and it calls `ensureDefaultGrove()` before
 *     anything else. If you see a null from this path on a running
 *     daemon, it indicates startup-order corruption.
 *
 * There is NO fallback path. Callers handle null by logging + skipping
 * the buffer write — capture loss in the rare null case is the
 * deliberate trade against the divergent-state bug class.
 */
export function resolveProjectBufferDirFromRoot(
  projectRoot: string,
  mycoHome = resolveMycoHome(),
): ProjectBufferLocation | null {
  const resolved = ensureProjectRegistered(projectRoot, mycoHome);
  if (!resolved) return null;
  return {
    groveId: resolved.grove.id,
    projectId: resolved.project.project_id,
    bufferDir: resolveProjectBufferDir(resolved.grove.id, resolved.project.project_id, mycoHome),
  };
}

/**
 * Every buffer dir the reconciler should scan at startup — one per
 * registered project under the global Grove tree. Order is deterministic
 * (Grove discovery order, then per-Grove project iteration order) so log
 * output stays stable.
 */
export function listAllProjectBufferDirs(mycoHome = resolveMycoHome()): string[] {
  // Reconciler scope: only the Groves this daemon serves. The
  // cross-Grove SQLite gate would block real writes too, but
  // filtering here keeps the reconciler from enumerating peer
  // daemons' buffers in the first place.
  const out: string[] = [];
  for (const grove of listGroves(mycoHome, { servedBy: currentDaemonVariant() })) {
    for (const project of listRegisteredProjects(grove.id, mycoHome)) {
      out.push(resolveProjectBufferDir(grove.id, project.project_id, mycoHome));
    }
  }
  return out;
}
