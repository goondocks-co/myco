import { findRegisteredProject, type GroveRecord, type RegisteredProject } from './registry.js';
import { teamRegistry } from '@myco/team/registry.js';

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
 * Member projects (assigned to any team) that live in this grove. The authority
 * computation that `reconcileClient` projects into `team_sync_membership`.
 */
export function memberProjectIdsForGrove(groveId: string | null): string[] {
  if (!groveId) return [];
  return [
    ...new Set(
      teamRegistry.list()
        .flatMap((t) => t.projects)
        .filter((p) => p.grove_id === groveId)
        .map((p) => p.project_id),
    ),
  ];
}

/** True when this machine has joined at least one team. */
export const machineHasAnyTeam = (): boolean => teamRegistry.list().length > 0;

/**
 * The "check" at assignment boundaries: a project may only be referenced by a
 * global construct (team) if it exists and resolves to a grove.
 */
export function assertAssignableProject(projectId: string): ProjectTenancy {
  return resolveProjectTenancy(projectId);
}
