/**
 * `team-write` route class — the served grove's PER-TASK config overrides
 * (server-mode design spec §6.3's "per-task table"), reached by a member
 * through their own daemon exactly like the sibling `team-config.ts` routes.
 *
 *   GET /api/team/agent-tasks/:id/config
 *   PUT /api/team/agent-tasks/:id/config
 *
 * The bespoke `PUT /api/agent/tasks/:id/config` route is `config-lock`
 * stamped (`host/routing.ts`) and refuses attached-project writes by design
 * — the underlying data is grove config already, so this module is the
 * sanctioned parallel path spec §6 calls for: same read/write logic, a
 * different (team-write) wall.
 *
 * Delegates to the SAME `handleGetTaskConfig` / `handleUpdateTaskConfig`
 * `agent-tasks.ts` exports for the bespoke route — single write path, no
 * parallel writer. The served grove id is derived EXCLUSIVELY from
 * `hostServe.servedGroveId` via `resolveServedGroveIdOrRefusal` (never a
 * request header / `req.requestContext`), matching every handler in
 * `team-config.ts`. `projectTierOptional` is forced `true` unconditionally
 * — a team-write request never carries a project working tree to merge, so
 * the merged config resolves from machine+grove tiers only, regardless of
 * whether some unrelated directory happens to exist on disk at the vaultDir
 * stand-in passed through (the served grove's own directory, which never
 * holds a `myco.yaml`).
 */
import { handleGetTaskConfig, handleUpdateTaskConfig } from './agent-tasks.js';
import { resolveGroveDir, resolveMycoHome } from '../../grove/paths.js';
import { resolveServedGroveIdOrRefusal, isRefusal, type TeamConfigRouteDeps } from './team-config.js';
import type { RouteRegistrar, RouteRequest, RouteResponse } from '../router.js';

/** GET /api/team/agent-tasks/:id/config — the served grove's config override
 *  for one task, same response shape `GET /api/agent/tasks/:id/config` returns. */
export async function handleGetTeamTaskConfig(
  deps: TeamConfigRouteDeps,
  req: RouteRequest,
): Promise<RouteResponse> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) return groveIdOrRefusal;
  const groveId = groveIdOrRefusal;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const groveDir = resolveGroveDir(groveId, mycoHome);

  return handleGetTaskConfig(req, groveDir, { groveId, projectTierOptional: true });
}

/** PUT /api/team/agent-tasks/:id/config — patches the served grove's
 *  `agent.tasks.<id>` override through the SAME single write path
 *  `PUT /api/agent/tasks/:id/config` uses when a Grove is bound. */
export async function handlePutTeamTaskConfig(
  deps: TeamConfigRouteDeps,
  req: RouteRequest,
): Promise<{ response: RouteResponse; touchedPaths: string[]; groveId: string | null }> {
  const groveIdOrRefusal = resolveServedGroveIdOrRefusal(deps);
  if (isRefusal(groveIdOrRefusal)) {
    return { response: groveIdOrRefusal, touchedPaths: [], groveId: null };
  }
  const groveId = groveIdOrRefusal;
  const mycoHome = deps.mycoHome ?? resolveMycoHome();
  const groveDir = resolveGroveDir(groveId, mycoHome);

  const response = await handleUpdateTaskConfig(req, groveDir, groveId);
  const ok = !response.status || response.status < 400;
  const touchedPaths = ok ? [`agent.tasks.${req.params.id}`] : [];
  return { response, touchedPaths, groveId: ok ? groveId : null };
}

export function registerTeamAgentTaskRoutes(server: RouteRegistrar, deps: TeamConfigRouteDeps): void {
  server.registerRoute('GET', '/api/team/agent-tasks/:id/config', async (req: RouteRequest) =>
    handleGetTeamTaskConfig(deps, req));

  server.registerRoute('PUT', '/api/team/agent-tasks/:id/config', async (req: RouteRequest) => {
    const { response, touchedPaths, groveId } = await handlePutTeamTaskConfig(deps, req);
    if ((!response.status || response.status < 400) && groveId) {
      await deps.onConfigWrite?.(touchedPaths, groveId);
    }
    return response;
  });
}
