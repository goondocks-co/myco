import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertAssignableProject,
  machineHasAnyTeam,
  memberProjectIdsForGrove,
  ProjectGroveMissingError,
  resolveProjectTenancy,
} from '@myco/grove/project-tenancy.js';
import {
  clearGroveRegistryCaches,
  createGrove,
  registerProjectInGrove,
} from '@myco/grove/registry.js';
import { createTeamId } from '@myco/grove/ids.js';
import { teamRegistry, type TeamRecord } from '@myco/team/registry.js';

let home: string;
let prevHome: string | undefined;
const projectRoots: string[] = [];

function makeProjectRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenancy-proj-'));
  projectRoots.push(root);
  return root;
}

function saveTeam(projects: Array<{ grove_id: string; project_id: string }>): string {
  const teamId = createTeamId();
  const record: TeamRecord = {
    team_id: teamId,
    name: teamId,
    worker_url: 'https://example.invalid',
    domain: null,
    mcp_endpoint: null,
    created_at: new Date(0).toISOString(),
    projects,
  };
  teamRegistry.save(record, home);
  return teamId;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-tenancy-home-'));
  prevHome = process.env.MYCO_HOME;
  process.env.MYCO_HOME = home;
  clearGroveRegistryCaches();
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.MYCO_HOME;
  else process.env.MYCO_HOME = prevHome;
  fs.rmSync(home, { recursive: true, force: true });
  for (const root of projectRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  clearGroveRegistryCaches();
});

describe('project tenancy authority', () => {
  it('resolves a project to its (non-optional) grove and team membership', () => {
    const grove = createGrove('G', home);
    const projectRoot = makeProjectRoot();
    registerProjectInGrove(
      grove.id,
      { projectId: 'P', projectName: 'P', projectRoot },
      home,
    );
    const teamId = saveTeam([{ grove_id: grove.id, project_id: 'P' }]);

    const t = resolveProjectTenancy('P');
    expect(t.grove.id).toBe(grove.id);
    expect(t.project.project_id).toBe('P');
    expect(t.team?.team_id).toBe(teamId);
  });

  it('returns team=null for a project in no team', () => {
    const grove = createGrove('G', home);
    const projectRoot = makeProjectRoot();
    registerProjectInGrove(
      grove.id,
      { projectId: 'P-unassigned', projectName: 'P-unassigned', projectRoot },
      home,
    );

    const t = resolveProjectTenancy('P-unassigned');
    expect(t.team).toBeNull();
    expect(t.grove).toBeDefined();
    expect(t.grove.id).toBe(grove.id);
  });

  it('throws ProjectGroveMissingError for a project with no resolvable grove', () => {
    createGrove('G', home);
    expect(() => resolveProjectTenancy('ghost')).toThrow(ProjectGroveMissingError);
  });

  it("memberProjectIdsForGrove returns only this grove's team-member projects", () => {
    const grove = createGrove('G', home);
    const projectRoot = makeProjectRoot();
    registerProjectInGrove(
      grove.id,
      { projectId: 'P', projectName: 'P', projectRoot },
      home,
    );
    const otherGrove = createGrove('Other', home);
    const otherRoot = makeProjectRoot();
    registerProjectInGrove(
      otherGrove.id,
      { projectId: 'P-other', projectName: 'P-other', projectRoot: otherRoot },
      home,
    );
    // P (in grove G) and P-other (in otherGrove) both belong to one team.
    saveTeam([
      { grove_id: grove.id, project_id: 'P' },
      { grove_id: otherGrove.id, project_id: 'P-other' },
    ]);

    expect(new Set(memberProjectIdsForGrove(grove.id))).toEqual(new Set(['P']));
    // A grove with no team-member projects returns [].
    const emptyGrove = createGrove('Empty', home);
    expect(memberProjectIdsForGrove(emptyGrove.id)).toEqual([]);
    expect(memberProjectIdsForGrove(null)).toEqual([]);
  });

  it('machineHasAnyTeam reflects whether any team is registered', () => {
    expect(machineHasAnyTeam()).toBe(false);
    saveTeam([]);
    expect(machineHasAnyTeam()).toBe(true);
  });

  it('assertAssignableProject accepts a grove-bound project and rejects a grove-less one', () => {
    const grove = createGrove('G', home);
    const projectRoot = makeProjectRoot();
    registerProjectInGrove(
      grove.id,
      { projectId: 'P', projectName: 'P', projectRoot },
      home,
    );

    expect(() => assertAssignableProject('P')).not.toThrow();
    expect(() => assertAssignableProject('ghost')).toThrow(ProjectGroveMissingError);
  });
});
