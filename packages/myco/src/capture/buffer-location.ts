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

import path from 'node:path';
import {
  resolveProjectBufferDir,
  resolveMycoHome,
  resolveGrovesDir,
  currentDaemonVariant,
} from '../grove/paths.js';
import { isGroveEraId } from '../grove/ids.js';
import {
  ensureProjectRegistered,
  findProjectByRoot,
  getRegisteredProjectInGrove,
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
/**
 * The `(groveId, projectId)` ownership a buffer dir path encodes —
 * `~/.myco/groves/<groveId>/projects/<projectId>/buffer/` — or `null` when
 * the path is not Grove-shaped (or lies outside this install's Grove tree).
 *
 * Pure path decoding: it does NOT consult the registry. Callers that need
 * "is this still the project's current home" must verify the decoded pair
 * against the registry (see `bufferDirCurrentRegistration`).
 */
export function bufferDirIdentity(
  bufferDir: string,
  mycoHome = resolveMycoHome(),
): { groveId: string; projectId: string } | null {
  const resolved = path.resolve(bufferDir);
  if (path.basename(resolved) !== 'buffer') return null;
  const projectDir = path.dirname(resolved);
  const projectId = path.basename(projectDir);
  const projectsDir = path.dirname(projectDir);
  if (path.basename(projectsDir) !== 'projects') return null;
  const groveDir = path.dirname(projectsDir);
  const groveId = path.basename(groveDir);
  if (path.dirname(groveDir) !== path.resolve(resolveGrovesDir(mycoHome))) return null;
  if (!isGroveEraId(groveId, 'grove') || !isGroveEraId(projectId, 'project')) return null;
  return { groveId, projectId };
}

/**
 * Verify that the `(groveId, projectId)` a buffer dir encodes is still a
 * CURRENT registration: the project must be actively registered in that
 * exact Grove. Returns the registered project's root when the registration
 * holds, or `null` for a stale dir (project moved Groves, re-registered
 * under a new id, archived, or deleted). The reconciler treats `null` as
 * "do not resurrect from this dir".
 */
export function bufferDirCurrentRegistration(
  bufferDir: string,
  mycoHome = resolveMycoHome(),
): { groveId: string; projectId: string; projectRoot: string } | null {
  const identity = bufferDirIdentity(bufferDir, mycoHome);
  if (!identity) return null;
  const project = getRegisteredProjectInGrove(identity.groveId, identity.projectId, mycoHome);
  if (!project) return null;
  return { ...identity, projectRoot: project.root };
}

/**
 * Resolve a project's buffer dir from its project id alone, by walking
 * the Groves this daemon serves. Used by deletion-cleanup paths that hold
 * only a session row's `project_id` (no request context). Returns `null`
 * when the project is not registered in any served Grove — callers must
 * log and skip; guessing a path is the divergent-state bug class this
 * module exists to prevent.
 */
export function resolveBufferDirForProjectId(
  projectId: string | null,
  mycoHome = resolveMycoHome(),
): string | null {
  if (!projectId || !isGroveEraId(projectId, 'project')) return null;
  for (const grove of listGroves(mycoHome, { servedBy: currentDaemonVariant() })) {
    const project = getRegisteredProjectInGrove(grove.id, projectId, mycoHome, { includeArchived: true });
    if (project) return resolveProjectBufferDir(grove.id, projectId, mycoHome);
  }
  return null;
}

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
