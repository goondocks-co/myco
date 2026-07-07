/**
 * Scope iteration primitives for daemon-level housekeeping.
 *
 * The global daemon owns one process for many Groves and many projects-per-
 * Grove. Housekeeping jobs (backup, optimize, log retention, embedding
 * reconcile, scheduled agent tasks, canopy sweep, staging GC) need to fan
 * out cleanly across these scopes without each job re-implementing the
 * enumeration, DB lifecycle, and request-context plumbing.
 *
 * Two iterators cover every fan-out shape the daemon needs:
 *
 * - `forEachGrove` — every registered Grove (one DB per Grove). Used for
 *   anything that touches per-Grove stored state.
 * - `forEachRegisteredProject` — every `(grove, project)` tuple. Used for
 *   project-scoped work like canopy delta sweeps, staging GC, and
 *   active-project agent-task scheduling.
 *
 * Both iterators:
 *
 * 1. Open the per-Grove DB through the shared `GroveRuntimeCache` LRU and
 *    pin it for the duration of the per-Grove body so a sweep over
 *    N > capacity Groves does not evict the entry it is currently
 *    processing.
 * 2. Wrap the body in `withDatabase(db, fn)` so any helper that calls the
 *    `getDatabase()` singleton automatically reads the per-Grove DB. This
 *    is the existing AsyncLocalStorage scoping primitive — no helper
 *    signatures need to change.
 * 3. Catch and log per-Grove errors, then continue with the next Grove.
 *    A failure in one Grove must not poison the rest of the sweep.
 */

import path from 'node:path';
import type { Database } from '@myco/db/client.js';
import { withDatabase } from '@myco/db/client.js';
import type { GroveProjectId } from '@myco/grove/ids.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import {
  resolveGroveDbPath,
  resolveMycoHome,
  resolveGroveDir,
  resolveProjectVaultDir,
} from '@myco/grove/paths.js';
import {
  listGroves,
  listRegisteredProjects,
  type GroveRecord,
  type RegisteredProject,
} from '@myco/grove/registry.js';
import { attachTargetGroveIds } from '@myco/host/registry.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import type { Logger } from '@myco/daemon/logger.js';
import { LOG_KINDS } from '@myco/constants/log-kinds.js';
import type { GroveRuntimeCache } from '@myco/daemon/grove-runtime-cache.js';
import { errorMessage } from '@myco/utils/error-message.js';
import { getProjectActivitySeconds } from '@myco/db/queries/project-activity.js';

// ---------------------------------------------------------------------------
// forEachGrove
// ---------------------------------------------------------------------------

export interface GroveScope {
  grove: GroveRecord;
  /** Absolute path to the Grove's directory under Myco home. */
  groveHome: string;
  /** Absolute path to this Grove's SQLite file. */
  databasePath: string;
  /** Open DB handle pinned for the duration of the body. */
  db: Database;
}

export interface ForEachGroveOptions {
  /** Override Myco home for tests; defaults to the resolved global home. */
  mycoHome?: string;
  /**
   * @deprecated No longer used; the home is the grove filter. Kept for
   * call-site compatibility until T9 removes all pass-throughs.
   */
  daemonStateDir?: string;
  /** Tag included in the per-Grove failure log so operators can identify the caller. */
  jobName?: string;
  /**
   * When true, run per-Grove bodies concurrently. Each Grove is an
   * independent SQLite DB so cross-Grove parallelism is safe. Use only
   * for read-only API endpoints — write-heavy fan-outs (backup,
   * optimize) must stay sequential to avoid VACUUM lock contention.
   */
  parallel?: boolean;
  /**
   * Optional pre-DB-open predicate. Groves for which this returns
   * `false` are skipped entirely — the DB is not opened, the body is
   * not invoked, and the Grove is not counted toward `attempted`.
   *
   * The intended use is cold-Grove avoidance: the cheapest signal a
   * caller can supply is a stat of the Grove DB mtime against an
   * activity threshold, or a Grove-level activity hint maintained
   * elsewhere. Skipping a cold Grove on a frequent-tick RunnerJob
   * avoids opening its SQLite handle and warming the
   * GroveRuntimeCache for no work.
   *
   * The predicate runs before the cache lookup, so a Grove the
   * caller decides to skip never displaces a warm entry.
   */
  shouldVisitGrove?: (grove: GroveRecord) => boolean;
}

export interface ScopeIterationSummary {
  attempted: number;
  ok: number;
  failed: number;
  /**
   * Groves filtered out by `shouldVisitGrove` before the body ran.
   * Always present; defaults to 0 when no filter is supplied.
   */
  skipped?: number;
}

/**
 * Visit every registered Grove. The body runs with the Grove's DB pinned
 * in `cache`, scoped via `withDatabase` so singleton helpers route to it,
 * and isolated from other Groves' failures.
 */
export async function forEachGrove(
  cache: GroveRuntimeCache,
  logger: Logger,
  body: (scope: GroveScope) => Promise<void> | void,
  options: ForEachGroveOptions,
): Promise<ScopeIterationSummary> {
  const mycoHome = options.mycoHome ?? resolveMycoHome();

  // Team Host never-materialize invariant (defense-in-depth): a member daemon
  // must never run intelligence for an attached project. Attached Groves are
  // hosted, so by invariant they have no local Grove dir and never appear in
  // listGroves — but if local state ever leaked for one, skipping its id here
  // keeps every housekeeping/scheduler fan-out structurally clear of it.
  const attachedGroveIds = attachTargetGroveIds();

  // Apply the pre-open filters before any cache touch so cold or attached
  // Groves don't displace warm entries. Filtering happens here rather than
  // inside `visit` so `attempted` reflects only Groves the body actually ran for.
  const groves: GroveRecord[] = [];
  let skipped = 0;
  const shouldVisitGrove = options.shouldVisitGrove;
  for (const grove of listGroves(mycoHome)) {
    if (attachedGroveIds.has(grove.id)) { skipped += 1; continue; }
    if (shouldVisitGrove && !shouldVisitGrove(grove)) { skipped += 1; continue; }
    groves.push(grove);
  }

  let ok = 0;
  let failed = 0;

  const visit = async (grove: GroveRecord): Promise<void> => {
    const databasePath = resolveGroveDbPath(grove.id, mycoHome);
    const groveHome = resolveGroveDir(grove.id, mycoHome);
    try {
      const db = cache.getDatabase(databasePath);
      await cache.withPinned(databasePath, async () => {
        await withDatabase(db, async () => {
          await body({ grove, groveHome, databasePath, db });
        });
      });
      ok += 1;
    } catch (err) {
      failed += 1;
      const message = options.jobName
        ? `Grove iteration body failed (${options.jobName})`
        : 'Grove iteration body failed';
      logger.error(LOG_KINDS.DAEMON_START, message, {
        grove_id: grove.id,
        grove_slug: grove.slug,
        database_path: databasePath,
        job_name: options.jobName ?? null,
        error: errorMessage(err),
      });
    }
  };

  if (options.parallel) {
    await Promise.all(groves.map(visit));
  } else {
    for (const grove of groves) await visit(grove);
  }

  return { attempted: groves.length, ok, failed, skipped };
}

// ---------------------------------------------------------------------------
// forEachRegisteredProject
// ---------------------------------------------------------------------------

/**
 * Per-(grove, project) iteration record yielded to bodies of
 * `forEachRegisteredProject`. Carries the open Grove DB plus the
 * registered-project tuple this body should operate on.
 *
 * Distinct from `ProjectScope` in `@myco/grove/ids` — that is the
 * read-side discriminated union used for SQL filter selection
 * (`{ kind: 'project'|'global'|'all' }`). The two never compose.
 */
export interface RegisteredProjectScope extends GroveScope {
  project: RegisteredProject;
  projectId: GroveProjectId;
  projectRoot: string;
  projectVaultDir: string;
  /**
   * Per-project request context built from the Grove + project tuple.
   * `sessionId` is null because background iteration is not bound to a
   * live session.
   */
  requestContext: MycoRequestContext;
}

export interface ForEachRegisteredProjectOptions extends ForEachGroveOptions {
  machineId: string;
  /**
   * Optional per-project predicate. Projects for which this returns
   * `false` are skipped before the body runs. Use for activity gating
   * (see `isProjectActive`) when fan-out is restricted to "warm"
   * projects.
   */
  shouldVisit?: (scope: RegisteredProjectScope) => boolean;
  /**
   * Optional notifier invoked alongside the error log when a per-project
   * body throws. Mirrors the `notifyOnFailure` convention in
   * `power-jobs.ts` for Grove-scope work: callers that own a vault dir
   * + notification pipeline use this hook to surface project failures
   * in the dashboard. Without it, a failure in one project's body is
   * recorded only in the daemon log and the operator never sees it.
   *
   * The callback is best-effort and must not throw; the iteration
   * continues regardless of what the notifier does. The error message
   * has already been extracted from the thrown value.
   */
  notifyOnProjectFailure?: (scope: RegisteredProjectScope, errorMessage: string) => void;
}

/**
 * Visit every `(grove, project)` tuple across all registered Groves.
 * The Grove's DB is opened/pinned once per Grove and reused across all
 * its projects, so Groves with many projects still cost one cache slot.
 * Body errors per project are isolated; one failed project does not
 * abort the sweep.
 */
export async function forEachRegisteredProject(
  cache: GroveRuntimeCache,
  logger: Logger,
  body: (scope: RegisteredProjectScope) => Promise<void> | void,
  options: ForEachRegisteredProjectOptions,
): Promise<ScopeIterationSummary> {
  const mycoHome = options.mycoHome ?? resolveMycoHome();
  const machineId = options.machineId;
  const shouldVisit = options.shouldVisit;

  let attempted = 0;
  let ok = 0;
  let failed = 0;

  await forEachGrove(
    cache,
    logger,
    async ({ grove, groveHome, databasePath, db }) => {
      const projects = listRegisteredProjects(grove.id, mycoHome);
      for (const project of projects) {
        const registeredScope = buildRegisteredProjectScope({
          grove,
          groveHome,
          databasePath,
          db,
          project,
          machineId,
        });
        if (shouldVisit && !shouldVisit(registeredScope)) continue;
        attempted += 1;
        try {
          // No additional pin/withDatabase — we're already inside the
          // Grove's pinned + scoped block from forEachGrove.
          await body(registeredScope);
          ok += 1;
        } catch (err) {
          failed += 1;
          const message = errorMessage(err);
          logger.error(LOG_KINDS.DAEMON_START, 'Project iteration body failed', {
            grove_id: grove.id,
            project_id: project.project_id,
            project_root: project.root,
            error: message,
          });
          if (options.notifyOnProjectFailure) {
            try {
              options.notifyOnProjectFailure(registeredScope, message);
            } catch (notifyErr) {
              // Notifier must never escalate a logged failure into a
              // sweep abort; swallow and continue. Log at warn so a
              // broken notifier is itself visible.
              logger.warn(
                LOG_KINDS.DAEMON_START,
                'Project iteration notifier threw',
                {
                  grove_id: grove.id,
                  project_id: project.project_id,
                  error: errorMessage(notifyErr),
                },
              );
            }
          }
        }
      }
    },
    { mycoHome, daemonStateDir: options.daemonStateDir },
  );

  return { attempted, ok, failed };
}

// ---------------------------------------------------------------------------
// isProjectActive
// ---------------------------------------------------------------------------

/**
 * Activity recency window for a project, used to gate token-spending
 * scheduled agent tasks. A project counts as active when its most recent
 * session or prompt_batch `created_at` is at or after `cutoffEpochSeconds`.
 */
export function isProjectActive(
  db: Database,
  projectId: GroveProjectId,
  cutoffEpochSeconds: number,
): boolean {
  const last = getProjectActivitySeconds(db, projectId);
  return last !== null && last >= cutoffEpochSeconds;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildRegisteredProjectScope(input: {
  grove: GroveRecord;
  groveHome: string;
  databasePath: string;
  db: Database;
  project: RegisteredProject;
  machineId: string;
}): RegisteredProjectScope {
  const projectRoot = path.resolve(input.project.root);
  const projectVaultDir = resolveProjectVaultDir(projectRoot);
  const projectId = assertGroveProjectId(input.project.project_id);
  const requestContext: MycoRequestContext = {
    projectRoot,
    callerRoot: null,
    projectId,
    groveId: input.grove.id,
    machineId: input.machineId,
    sessionId: null,
    projectVaultDir,
    databasePath: input.databasePath,
    source: 'explicit',
    // Daemon-internal sweep over registered projects: tenancy is derived
    // from the Grove registry, not supplied by an external caller. This is
    // project-scoped for DB reads/writes, but it is still rejected by external
    // request-principal authorization because it is not caller tenancy.
    tenancySource: 'daemon',
  };
  return {
    grove: input.grove,
    groveHome: input.groveHome,
    databasePath: input.databasePath,
    db: input.db,
    project: input.project,
    projectId,
    projectRoot,
    projectVaultDir,
    requestContext,
  };
}
