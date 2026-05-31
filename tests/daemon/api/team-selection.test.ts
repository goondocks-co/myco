import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { vi } from '../../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createTeamId } from '@myco/grove/ids.js';
import { teamRegistry, type TeamRecord } from '@myco/team/registry.js';
import { clearGroveRegistryCaches } from '@myco/grove/registry.js';
import { createTeamSelectionHandlers } from '@myco/daemon/api/team-selection.js';
import type { RouteRequest, RouteResponse } from '@myco/daemon/router.js';

function seedTeam(name: string): TeamRecord {
  const record: TeamRecord = {
    team_id: createTeamId(),
    name,
    worker_url: 'https://example.workers.dev',
    domain: null,
    mcp_endpoint: null,
    created_at: '2026-05-30T00:00:00.000Z',
    projects: [],
  };
  teamRegistry.save(record);
  return record;
}

function membershipBody(
  team_id: string,
  grove_id: string,
  project_id: string,
  action: 'add' | 'remove',
): RouteRequest {
  return { body: { team_id, grove_id, project_id, action } } as RouteRequest;
}

describe('createTeamSelectionHandlers', () => {
  let tempDir: string;
  let originalMycoHome: string | undefined;
  let handlers: ReturnType<typeof createTeamSelectionHandlers>;

  beforeEach(() => {
    originalMycoHome = process.env.MYCO_HOME;
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-selection-'));
    process.env.MYCO_HOME = path.join(tempDir, '.myco-home');
    fs.mkdirSync(process.env.MYCO_HOME, { recursive: true });
    clearGroveRegistryCaches();
    handlers = createTeamSelectionHandlers();
  });

  afterEach(() => {
    vi.resetModules();
    clearGroveRegistryCaches();
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('adds a project to a team and reflects it via get()', () => {
    const team = seedTeam('Alpha');

    const response = handlers.handleSetProjectMembership(
      membershipBody(team.team_id, 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'add'),
    );

    const body = response.body as { team: TeamRecord };
    expect(response.status).toBeUndefined();
    expect(body.team.projects).toContainEqual({
      grove_id: 'grove_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      project_id: 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });

    const persisted = teamRegistry.get(team.team_id);
    expect(persisted?.projects.some((p) => p.project_id === 'proj_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).toBe(true);
  });

  it('rejects adding a project already owned by another team with 409', () => {
    const teamA = seedTeam('Alpha');
    const teamB = seedTeam('Beta');
    const projectId = 'proj_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    handlers.handleSetProjectMembership(
      membershipBody(teamA.team_id, 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', projectId, 'add'),
    );

    const response = handlers.handleSetProjectMembership(
      membershipBody(teamB.team_id, 'grove_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', projectId, 'add'),
    );

    expect(response.status).toBe(409);
    const body = response.body as { error: string; team_id: string };
    expect(body.error).toBe('project_in_other_team');
    expect(body.team_id).toBe(teamA.team_id);

    // Beta did not gain the project.
    expect(teamRegistry.get(teamB.team_id)?.projects).toHaveLength(0);
  });

  it('removes a project from a team', () => {
    const team = seedTeam('Alpha');
    const groveId = 'grove_cccccccccccccccccccccccccccccccc';
    const projectId = 'proj_cccccccccccccccccccccccccccccccc';

    handlers.handleSetProjectMembership(membershipBody(team.team_id, groveId, projectId, 'add'));
    expect(teamRegistry.get(team.team_id)?.projects).toHaveLength(1);

    const response = handlers.handleSetProjectMembership(membershipBody(team.team_id, groveId, projectId, 'remove'));
    const body = response.body as { team: TeamRecord };

    expect(response.status).toBeUndefined();
    expect(body.team.projects.some((p) => p.project_id === projectId)).toBe(false);
    expect(teamRegistry.get(team.team_id)?.projects).toHaveLength(0);
  });

  it('returns missing_fields (400) when the body is incomplete', () => {
    const team = seedTeam('Alpha');
    const response = handlers.handleSetProjectMembership({
      body: { team_id: team.team_id, action: 'add' },
    } as RouteRequest);
    expect(response.status).toBe(400);
    expect((response.body as { error: string }).error).toBe('missing_fields');
  });

  it('returns unknown_team (404) for an unregistered team id', () => {
    const response = handlers.handleSetProjectMembership(
      membershipBody(createTeamId(), 'grove_dddddddddddddddddddddddddddddddd', 'proj_dddddddddddddddddddddddddddddddd', 'add'),
    );
    expect(response.status).toBe(404);
    expect((response.body as { error: string }).error).toBe('unknown_team');
  });

  it('handleListTeams returns the seeded teams', () => {
    const team = seedTeam('Alpha');
    const response = handlers.handleListTeams({} as RouteRequest);
    const body = response.body as { teams: TeamRecord[] };
    expect(body.teams.map((t) => t.team_id)).toContain(team.team_id);
  });

  it('annotates teams with has_deployment from the deployment record', () => {
    const opId = createTeamId();
    const joinedId = createTeamId();
    teamRegistry.save({ team_id: opId, name: 'Op', worker_url: 'https://op.dev', domain: null, mcp_endpoint: null, created_at: '', projects: [] });
    teamRegistry.saveDeployment({ team_id: opId, worker_name: 'w', worker_url: 'https://op.dev', package_version: '0', created_at: '', last_upgraded: '', config_version: 1 });
    teamRegistry.save({ team_id: joinedId, name: 'Joined', worker_url: 'https://j.dev', domain: null, mcp_endpoint: null, created_at: '', projects: [] });

    const response = handlers.handleListTeams({} as RouteRequest);
    const teams = (response.body as { teams: Array<{ team_id: string; has_deployment: boolean }> }).teams;
    expect(teams.find((t) => t.team_id === opId)?.has_deployment).toBe(true);
    expect(teams.find((t) => t.team_id === joinedId)?.has_deployment).toBe(false);
  });

  it('handleListProjects returns a projects array (empty home → [])', () => {
    const response: RouteResponse = handlers.handleListProjects({} as RouteRequest);
    const body = response.body as { projects: unknown[] };
    expect(Array.isArray(body.projects)).toBe(true);
    expect(body.projects).toHaveLength(0);
  });
});
