/**
 * Team Host — host-side hosted-project lifecycle (E-4 W2 T1).
 *
 * A Team Host serves ONE Grove. Members attach projects and their daemons proxy
 * capture to the host, rewriting tenancy to `(served_grove_id, project_id)`. But
 * NOTHING registers a freshly-attached project in the host's per-Grove
 * `registry/projects.toml`, so the host's header resolver
 * (`findRegisteredProject`) throws `UnknownRequestContextError` → 404
 * `unknown_tenancy`: the project can neither serve reads NOR accept forwarded
 * capture. A permanent wedge.
 *
 * Binding principle (attached behaves like local): locally a project becomes real
 * on its first capture (hook → `ensureProjectRegistered`); host-side a served
 * project becomes real on its first FORWARDED capture. This module is that mirror
 * plus the lifecycle it implies:
 *
 *   - {@link maybeRegisterHostedProjectOnIngest} — the pre-resolution registration
 *     seam the router dispatch calls for overlay collect routes.
 *   - {@link hostedProjectRoot} / {@link hostedProjectName} — the synthetic root
 *     (`<grove>/hosted/<projectId>`, never on disk, passes `assertSafeProjectRoot`)
 *     and placeholder name a hosted row carries.
 *   - {@link listHostedProjects} / {@link countHostedProjects} — enumerate the
 *     hosted rows (operator visibility + the prune's candidate set).
 *   - {@link pruneHostedProjects} — the delete-only-if-empty GC of stale rows.
 */
import path from 'node:path';
import type { IncomingHttpHeaders } from 'node:http';

import {
  HOSTED_PROJECT_NAME_ID_SUFFIX_LEN,
  HOSTED_PROJECT_PRUNE_TTL_MS,
  HOSTED_PROJECT_ROOT_SEGMENT,
} from '../constants.js';
import { LOG_KINDS } from '../constants/log-kinds.js';
import type { Database } from '../db/client.js';
import { hostedProjectHasDbReferences } from '../db/queries/hosted-projects.js';
import type { DaemonLogger } from '../daemon/logger.js';
import { isGroveEraId, type GroveProjectId } from '../grove/ids.js';
import { resolveGroveDir, resolveMycoHome } from '../grove/paths.js';
import {
  deregisterProjectInGrove,
  findRegisteredProject,
  getRegisteredProjectInGrove,
  listRegisteredProjects,
  registerProjectInGrove,
  type RegisteredProject,
} from '../grove/registry.js';
import { readHeader, REQUEST_CONTEXT_HEADERS } from '../grove/request-context.js';
import { classifyRouteStamp } from './routing.js';

/**
 * The synthetic project root for a hosted registry row:
 * `<mycoHome>/groves/<grove>/hosted/<projectId>`. It (a) passes
 * `assertSafeProjectRoot` (not $HOME/`/`/a home-dir child) and (b) never exists
 * on disk — the tree-absence signal `projectTreeAvailable` already keys the
 * behave-like-local degrade on (config resolves machine+grove only; tree
 * reads/writes skip; symbionts reconcile skips).
 */
export function hostedProjectRoot(groveId: string, projectId: string, mycoHome = resolveMycoHome()): string {
  return path.join(resolveGroveDir(groveId, mycoHome), HOSTED_PROJECT_ROOT_SEGMENT, projectId);
}

/**
 * Placeholder display name for a hosted row: the last N hex of the project id.
 * The host never learns the member's chosen project name, and
 * `registerProjectInGrove` requires a non-derivable name field — this keeps the
 * operator dashboard legible without inventing a fake human name.
 */
export function hostedProjectName(projectId: string): string {
  return projectId.slice(-HOSTED_PROJECT_NAME_ID_SUFFIX_LEN);
}

/** Whether `root` sits under `<grove>/hosted/` — i.e. is a synthetic hosted root. */
export function isHostedProjectRoot(root: string, groveId: string, mycoHome = resolveMycoHome()): boolean {
  const hostedDir = path.join(resolveGroveDir(groveId, mycoHome), HOSTED_PROJECT_ROOT_SEGMENT);
  const resolved = path.resolve(root);
  return resolved === hostedDir || resolved.startsWith(hostedDir + path.sep);
}

/** Registered rows in `groveId` whose root is a synthetic hosted root. */
export function listHostedProjects(groveId: string, mycoHome = resolveMycoHome()): RegisteredProject[] {
  return listRegisteredProjects(groveId, mycoHome, { includeArchived: true })
    .filter((project) => isHostedProjectRoot(project.root, groveId, mycoHome));
}

/** Count of hosted rows in `groveId` (operator visibility on the status route). */
export function countHostedProjects(groveId: string, mycoHome = resolveMycoHome()): number {
  return listHostedProjects(groveId, mycoHome).length;
}

/** Result of a registration-on-ingest attempt. `registered` is false for every
 *  gate miss (behavior byte-identical to today) and for a registration that
 *  threw (`error` carries why, self-heals on the next forwarded capture). */
export interface HostedRegistrationOutcome {
  registered: boolean;
  projectId?: GroveProjectId;
  groveId?: string;
  error?: string;
}

/**
 * The registration-on-ingest decision + write. Gated on ALL of (the caller
 * supplies `isTeamRequest` by only calling this for overlay requests):
 *   2. host serving a designated grove (`servedGroveId` non-null);
 *   3. the route is `collect`-stamped;
 *   4. the raw grove header equals `servedGroveId` (read with the resolver's
 *      exact header semantics — the served-grove filter runs AFTER resolution,
 *      so this seam does its own grove==served check);
 *   5. a project header present AND a grove-era project id;
 *   6. `findRegisteredProject` miss — probed WITHOUT a root input so a stray
 *      `x-myco-project-root` header cannot make the probe miss the hosted row
 *      (which carries a synthetic root) and re-register on every ingest.
 * All pass → `registerProjectInGrove` (idempotent, sync) with the synthetic root
 * + placeholder name; the caller logs the one structured line. ANY miss →
 * `{ registered: false }`, byte-identical to today.
 */
export function maybeRegisterHostedProjectOnIngest(input: {
  method: string;
  pathname: string;
  headers: IncomingHttpHeaders;
  servedGroveId: string | null;
  mycoHome?: string;
}): HostedRegistrationOutcome {
  const { method, pathname, headers, servedGroveId } = input;
  if (!servedGroveId) return { registered: false };
  if (classifyRouteStamp(method, pathname).stamp !== 'collect') return { registered: false };
  if (readHeader(headers, REQUEST_CONTEXT_HEADERS.groveId) !== servedGroveId) return { registered: false };

  const projectHeader = readHeader(headers, REQUEST_CONTEXT_HEADERS.projectId);
  if (!projectHeader || !isGroveEraId(projectHeader, 'project')) return { registered: false };
  const projectId = projectHeader as GroveProjectId;

  const mycoHome = input.mycoHome ?? resolveMycoHome();
  // Probe WITHOUT projectRoot: the hosted row carries a synthetic root, so a
  // root-equivalence filter would always miss it and this would re-register
  // (and re-log) on every forwarded capture.
  if (findRegisteredProject({ projectId, groveId: servedGroveId }, mycoHome)) {
    return { registered: false };
  }

  try {
    registerProjectInGrove(
      servedGroveId,
      {
        projectId,
        projectName: hostedProjectName(projectId),
        projectRoot: hostedProjectRoot(servedGroveId, projectId, mycoHome),
      },
      mycoHome,
    );
  } catch (err) {
    return { registered: false, error: err instanceof Error ? err.message : String(err) };
  }
  return { registered: true, projectId, groveId: servedGroveId };
}

/** Result of an adoption attempt. `adopted` is true only when a placeholder name
 *  was upgraded to the provided name; false for every no-op (row absent, or the
 *  name was already real). */
export interface HostedAdoptionOutcome {
  adopted: boolean;
  projectId: string;
  name?: string;
}

/**
 * Adopt the member's real project name onto a hosted registry row (Phase F T2).
 *
 * A hosted project is registered on its first forwarded capture with the
 * placeholder name {@link hostedProjectName} (the last-N-hex of the id — the host
 * never learns the member's chosen name from ordinary capture). A with-history
 * attach DOES carry the name: it rides the residency push's first batch, and the
 * ingest handler calls this once that batch arrives.
 *
 * Idempotent by construction — the upgrade fires ONLY while the row still carries
 * the placeholder shape, so a re-sent first batch (a lost ack) is a no-op. It
 * updates the name in place via the registry's idempotent upsert
 * ({@link registerProjectInGrove}), passing the row's EXISTING synthetic root so
 * the root is never changed (the synthetic-root convention is uniform, D-W2-2)
 * and `created_at` is preserved. Absent row → no-op (the registration seam writes
 * the row before this runs, but a race/miss must not synthesize one here).
 */
export function adoptHostedProjectName(
  groveId: string,
  projectId: string,
  name: string,
  mycoHome = resolveMycoHome(),
): HostedAdoptionOutcome {
  const existing = getRegisteredProjectInGrove(groveId, projectId, mycoHome, { includeArchived: true });
  if (!existing) return { adopted: false, projectId };
  // Only a still-placeholder name is adopted: a real name (already adopted, or a
  // locally-registered project) must never be clobbered by a replayed batch.
  if (existing.name !== hostedProjectName(projectId)) return { adopted: false, projectId };
  // A blank/whitespace name is not a real name — leave the placeholder in place.
  const trimmed = name.trim();
  if (!trimmed) return { adopted: false, projectId };

  registerProjectInGrove(
    groveId,
    {
      projectId,
      projectName: trimmed,
      projectRoot: existing.root,
      ...(existing.binding_id ? { bindingId: existing.binding_id } : {}),
    },
    mycoHome,
  );
  return { adopted: true, projectId, name: trimmed };
}

/** Outcome of one prune sweep: rows removed vs. rows kept (young or referenced). */
export interface HostedPruneResult {
  pruned: number;
  kept: number;
}

/**
 * Prune empty, past-TTL hosted rows from the served Grove (decision D-W2-5).
 * Delete-only-if-empty: a row is removed ONLY when BOTH
 *   - its `created_at` is older than `ttlMs` (default {@link HOSTED_PROJECT_PRUNE_TTL_MS}), AND
 *   - the served Grove DB holds ZERO sessions/spores/plans rows for its project id.
 * A row with any content survives regardless of age; a young empty row survives
 * until it ages past the TTL. `db` must be the served Grove's own DB handle.
 */
export function pruneHostedProjects(input: {
  servedGroveId: string;
  db: Database;
  mycoHome?: string;
  now?: () => number;
  ttlMs?: number;
  logger?: Pick<DaemonLogger, 'info'>;
}): HostedPruneResult {
  const mycoHome = input.mycoHome ?? resolveMycoHome();
  const now = input.now ?? Date.now;
  const ttlMs = input.ttlMs ?? HOSTED_PROJECT_PRUNE_TTL_MS;
  const cutoff = now() - ttlMs;

  let pruned = 0;
  let kept = 0;
  for (const project of listHostedProjects(input.servedGroveId, mycoHome)) {
    const createdMs = Date.parse(project.created_at);
    // An unparseable timestamp is never provably past-TTL — keep it.
    if (!Number.isFinite(createdMs) || createdMs > cutoff) { kept += 1; continue; }
    if (hostedProjectHasDbReferences(input.db, project.project_id as GroveProjectId)) { kept += 1; continue; }
    deregisterProjectInGrove(input.servedGroveId, project.project_id, mycoHome, { force: true });
    pruned += 1;
  }

  if (pruned > 0) {
    input.logger?.info(LOG_KINDS.HOSTED_PROJECT_PRUNE, 'Pruned empty past-TTL hosted project rows', {
      grove_id: input.servedGroveId,
      pruned,
      kept,
    });
  }
  return { pruned, kept };
}
