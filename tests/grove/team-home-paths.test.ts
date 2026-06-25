import { describe, expect, it, afterEach } from 'bun:test';
import os from 'node:os';
import path from 'node:path';
import { resolveTeamsHome, resolveTeamsDir, resolveTeamConfigPath } from '@myco/grove/paths.js';
import { sandboxMycoHome } from '../helpers/myco-home-sandbox.js';
import { teamRegistry } from '@myco/team/registry.js';

describe('resolveTeamsHome', () => {
  const prevTeam = process.env.MYCO_TEAM_HOME;
  const prevHome = process.env.MYCO_HOME;
  afterEach(() => {
    if (prevTeam === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = prevTeam;
    if (prevHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = prevHome;
  });

  it('defaults to ~/.myco-team independent of MYCO_HOME', () => {
    delete process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = '/tmp/some-dev-home';
    expect(resolveTeamsHome()).toBe(path.join(os.homedir(), '.myco-team'));
    expect(resolveTeamsDir()).toBe(path.join(os.homedir(), '.myco-team', 'teams'));
  });

  it('honors MYCO_TEAM_HOME override', () => {
    process.env.MYCO_TEAM_HOME = '/tmp/team-sandbox';
    expect(resolveTeamsHome()).toBe('/tmp/team-sandbox');
    expect(resolveTeamConfigPath('team_' + 'a'.repeat(32)))
      .toBe(path.join('/tmp/team-sandbox', 'teams', 'team_' + 'a'.repeat(32), 'team.json'));
  });
});

describe('sandbox isolates the team home', () => {
  it('writes team records under the sandbox, never under real ~/.myco-team', () => {
    const sb = sandboxMycoHome();
    try {
      const teamId = 'team_' + 'b'.repeat(32);
      teamRegistry.save({ team_id: teamId, name: 'T', worker_url: 'https://x.workers.dev',
        domain: null, mcp_endpoint: null, created_at: '2026-06-24T00:00:00Z', projects: [] });
      expect(resolveTeamConfigPath(teamId).startsWith(process.env.MYCO_TEAM_HOME!)).toBe(true);
    } finally { sb.restore(); }
  });
});
