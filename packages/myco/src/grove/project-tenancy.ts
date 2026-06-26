import {
  findRegisteredProject,
  listGroves,
  listRegisteredProjects,
  type GroveRecord,
  type RegisteredProject,
} from './registry.js';
import { teamRegistry, type TeamRecord } from '@myco/team/registry.js';

/**
 * A project's resolved tenancy. grove is ALWAYS present (every project belongs to
 * exactly one grove); team is the zero-or-one global construct it syncs to.
 */
export interface ProjectTenancy {
  project: RegisteredProject;
  grove: GroveRecord;
  team: { team_id: string } | null;
}

/**
 * Thrown when a project has no resolvable grove. A grove-less project is a loud
 * failure, never a silent "global".
 */
export class ProjectGroveMissingError extends Error {
  constructor(public readonly projectId: string) {
    super(`Project ${projectId} has no resolvable grove (every project must belong to a grove)`);
    this.name = 'ProjectGroveMissingError';
  }
}

/** THE authority. The only sanctioned way to answer "what grove/team owns this project". */
export function resolveProjectTenancy(projectId: string): ProjectTenancy {
  const resolved = findRegisteredProject({ projectId });
  if (!resolved) throw new ProjectGroveMissingError(projectId);
  const teamId = teamRegistry.membershipByProject().get(projectId) ?? null;
  return {
    project: resolved.project,
    grove: resolved.grove,
    team: teamId ? { team_id: teamId } : null,
  };
}

/**
 * Discriminated result from `memberProjectIdsForGrove`. `resolved: true` means
 * the team registry was successfully read (even if the project list is empty —
 * that is a confirmed non-member state). `resolved: false` means the registry
 * directory exists but could not be read (indeterminate — callers must NOT
 * treat this as confirmed-empty and must leave any enabled/membership state
 * unchanged).
 */
export type MemberProjectResolution =
  | { resolved: true; projectIds: string[]; memberships: Array<{ project_id: string; team_id: string }> }
  | { resolved: false };

export interface ServedTeamProjectRef {
  grove_id: string;
  project_id: string;
  team_id: string;
}

export type ServedTeamProjectRefsResolution =
  | { resolved: true; refs: ServedTeamProjectRef[] }
  | { resolved: false };

function membershipByProjectFromTeams(teams: TeamRecord[]): Map<string, string> {
  const membership = new Map<string, string>();
  for (const team of teams) {
    for (const project of team.projects) {
      if (membership.has(project.project_id)) continue;
      membership.set(project.project_id, team.team_id);
    }
  }
  return membership;
}

/**
 * Member projects (assigned to any team) that live in this grove. The authority
 * computation that `reconcileClient` projects into `team_sync_membership`.
 *
 * Returns a discriminated result so callers can distinguish a confirmed
 * non-member state (`resolved: true, projectIds: []`) from an indeterminate
 * read failure (`resolved: false`). Only the former should disable team sync.
 */
export function memberProjectIdsForGrove(groveId: string | null): MemberProjectResolution {
  if (!groveId) return { resolved: true, projectIds: [], memberships: [] };
  const result = teamRegistry.listResolved();
  if (!result.resolved) return { resolved: false };
  const membership = membershipByProjectFromTeams(result.teams);
  const byProject = new Map<string, { project_id: string; team_id: string }>();
  for (const project of listRegisteredProjects(groveId)) {
    const teamId = membership.get(project.project_id);
    if (!teamId || byProject.has(project.project_id)) continue;
    byProject.set(project.project_id, {
      project_id: project.project_id,
      team_id: teamId,
    });
  }
  const memberships = [...byProject.values()];
  return {
    resolved: true,
    projectIds: memberships.map((p) => p.project_id),
    memberships,
  };
}

/**
 * Project refs for a team, resolved against the current MYCO_HOME. The
 * machine Team registry is authoritative for project -> team membership by
 * portable project_id; the current home's Grove registry is authoritative for
 * local Grove placement. Active registered projects therefore win over the
 * stored team.json Grove hint, with an owned-raw-ref fallback for legacy rows
 * whose project is no longer registered but whose Grove exists in this home.
 */
export function memberProjectRefsForTeam(teamId: string): ServedTeamProjectRefsResolution {
  const result = teamRegistry.listResolved();
  if (!result.resolved) return { resolved: false };
  const team = result.teams.find((candidate) => candidate.team_id === teamId);
  if (!team) return { resolved: true, refs: [] };

  const membership = membershipByProjectFromTeams(result.teams);
  const refsByProject = new Map<string, ServedTeamProjectRef>();
  const ownedGroveIds = new Set<string>();

  for (const grove of listGroves()) {
    ownedGroveIds.add(grove.id);
    for (const project of listRegisteredProjects(grove.id)) {
      if (membership.get(project.project_id) !== teamId) continue;
      refsByProject.set(project.project_id, {
        grove_id: grove.id,
        project_id: project.project_id,
        team_id: teamId,
      });
    }
  }

  for (const project of team.projects) {
    if (refsByProject.has(project.project_id)) continue;
    if (!ownedGroveIds.has(project.grove_id)) continue;
    refsByProject.set(project.project_id, {
      grove_id: project.grove_id,
      project_id: project.project_id,
      team_id: teamId,
    });
  }

  return { resolved: true, refs: [...refsByProject.values()] };
}

/** True when this machine has joined at least one team. */
export const machineHasAnyTeam = (): boolean => teamRegistry.list().length > 0;

/**
 * Discriminated variant of `machineHasAnyTeam`. Returns `{ resolved: false }`
 * when the team directory exists but cannot be read (e.g. ENOTDIR during a
 * migration window). Callers that must not act on an unconfirmed "no teams"
 * state — such as paths that would delete pending outbox rows — should use
 * this instead of `machineHasAnyTeam()`.
 */
export type MachineTeamResolution =
  | { resolved: true; hasTeam: boolean }
  | { resolved: false };

export function machineHasAnyTeamResolved(): MachineTeamResolution {
  const result = teamRegistry.listResolved();
  if (!result.resolved) return { resolved: false };
  return { resolved: true, hasTeam: result.teams.length > 0 };
}

/**
 * The "check" at assignment boundaries: a project may only be referenced by a
 * global construct (team) if it exists and resolves to a grove.
 */
export function assertAssignableProject(projectId: string): ProjectTenancy {
  return resolveProjectTenancy(projectId);
}
