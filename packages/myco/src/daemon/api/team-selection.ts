/**
 * Team/project SELECTION API handlers.
 *
 * Backs the daemon UI's Team page. Selection is the act of mapping a
 * Grove's project to a team (one team per project). These handlers only
 * READ the team registry + Grove registry and WRITE team.json membership;
 * they never touch sync or connection logic.
 *
 * There is intentionally no CLI for selection — it is UI-driven.
 *
 * Factory pattern mirrors `createTeamHandlers`: `createTeamSelectionHandlers()`
 * returns the route handlers. `mycoHome` is never a route parameter — the
 * registry and Grove helpers default to `resolveMycoHome()` internally.
 */

import { teamRegistry, withProjectAdded, withProjectRemoved } from '@myco/team/registry.js';
import { listGroves } from '@myco/grove/registry.js';
import { assertAssignableProject, ProjectGroveMissingError } from '@myco/grove/project-tenancy.js';
import { listGroveSummaries } from './groves.js';
import type { RouteRequest, RouteResponse } from '../router.js';

export interface TeamSelectionProjectRow {
  grove_id: string;
  grove_name: string;
  project_id: string;
  project_name: string;
  team_id: string | null;
}

interface SetProjectMembershipBody {
  team_id?: unknown;
  grove_id?: unknown;
  project_id?: unknown;
  action?: unknown;
}

export function createTeamSelectionHandlers() {
  /**
   * GET /api/team/registry — list every team record.
   *
   * team.json holds no secrets, so the records are safe to return as-is.
   */
  function handleListTeams(_req: RouteRequest): RouteResponse {
    const teams = teamRegistry.list().map((team) => ({
      ...team,
      has_deployment: teamRegistry.readDeployment(team.team_id) != null,
    }));
    return { body: { teams } };
  }

  /**
   * GET /api/team/projects — enumerate every Grove's projects, annotated
   * with the team they belong to (or null).
   *
   * Project enumeration goes through `listGroveSummaries`, the same data
   * path `createListGroveProjectsHandler` uses — no reinvented query. The
   * summaries are computed per-Grove inside a try/catch so a single Grove
   * that can't be read (corrupt registry TOML, unreadable DB) is skipped
   * rather than failing the whole list.
   */
  function handleListProjects(_req: RouteRequest): RouteResponse {
    const membership = teamRegistry.membershipByProject();
    const rows: TeamSelectionProjectRow[] = [];

    for (const grove of listGroves()) {
      let projects: Array<{ project_id: string; name: string }>;
      try {
        // Scope to this single Grove so one bad Grove can't abort the rest.
        const summary = listGroveSummaries({ groveIds: [grove.id] }).groves[0];
        projects = summary?.projects ?? [];
      } catch {
        continue;
      }
      for (const project of projects) {
        rows.push({
          grove_id: grove.id,
          grove_name: grove.name,
          project_id: project.project_id,
          project_name: project.name,
          team_id: membership.get(project.project_id) ?? null,
        });
      }
    }

    return { body: { projects: rows } };
  }

  /**
   * POST /api/team/project-membership — add or remove a project from a team.
   *
   * Body: { team_id, grove_id, project_id, action: 'add' | 'remove' }.
   *
   * Enforces one-team-per-project on `add`: if the project already belongs
   * to a different team, the request is rejected with 409 rather than
   * silently re-homing it.
   *
   * On `add` the project is validated through the tenancy authority
   * (`assertAssignableProject`): a team is a global construct, so it may only
   * reference a project that resolves to a grove, and the caller's claimed
   * `grove_id` must match that resolved grove. `remove` skips the check — a
   * project being removed may already be grove-less (its grove was
   * deregistered), and we must still let it leave the team.
   */
  function handleSetProjectMembership(req: RouteRequest): RouteResponse {
    const body = (req.body ?? {}) as SetProjectMembershipBody;
    const teamId = typeof body.team_id === 'string' ? body.team_id : '';
    const groveId = typeof body.grove_id === 'string' ? body.grove_id : '';
    const projectId = typeof body.project_id === 'string' ? body.project_id : '';
    const action = body.action;

    if (!teamId || !groveId || !projectId || (action !== 'add' && action !== 'remove')) {
      return { status: 400, body: { error: 'missing_fields' } };
    }

    const team = teamRegistry.get(teamId);
    if (!team) {
      return { status: 404, body: { error: 'unknown_team' } };
    }

    if (action === 'add') {
      let tenancy;
      try {
        tenancy = assertAssignableProject(projectId);
      } catch (err) {
        if (err instanceof ProjectGroveMissingError) {
          return { status: 400, body: { error: 'project_not_assignable' } };
        }
        throw err;
      }
      if (tenancy.grove.id !== groveId) {
        return { status: 400, body: { error: 'grove_mismatch', grove_id: tenancy.grove.id } };
      }

      const existing = teamRegistry.membershipByProject().get(projectId);
      if (existing && existing !== teamId) {
        return { status: 409, body: { error: 'project_in_other_team', team_id: existing } };
      }
      teamRegistry.save(withProjectAdded(team, { grove_id: groveId, project_id: projectId }));
    } else {
      teamRegistry.save(withProjectRemoved(team, projectId));
    }

    return { body: { team: teamRegistry.get(teamId) } };
  }

  return { handleListTeams, handleListProjects, handleSetProjectMembership };
}
