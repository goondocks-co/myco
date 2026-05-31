import { describe, it, expect, beforeEach } from 'bun:test';
import fs from 'node:fs';
import { teamRegistry, type TeamRecord } from '../../packages/myco/src/team/registry.js';

const HOME = '/tmp/teamreg-test';
const rec: TeamRecord = {
  team_id: `team_${'a'.repeat(32)}`,
  name: 'Myco Projects',
  worker_url: 'https://x.workers.dev',
  domain: null,
  mcp_endpoint: 'https://x.workers.dev/mcp',
  created_at: '2026-05-30T00:00:00Z',
  projects: [{ grove_id: `grove_${'b'.repeat(32)}`, project_id: `proj_${'c'.repeat(32)}` }],
};

beforeEach(() => { fs.rmSync(HOME, { recursive: true, force: true }); });

describe('teamRegistry', () => {
  it('list is empty when no teams dir', () => {
    expect(teamRegistry.list(HOME)).toEqual([]);
  });
  it('saves, lists, gets, and removes', () => {
    teamRegistry.save(rec, HOME);
    expect(teamRegistry.list(HOME).map(r => r.team_id)).toEqual([rec.team_id]);
    expect(teamRegistry.get(rec.team_id, HOME)?.name).toBe('Myco Projects');
    teamRegistry.remove(rec.team_id, HOME);
    expect(teamRegistry.list(HOME)).toEqual([]);
    expect(teamRegistry.get(rec.team_id, HOME)).toBeNull();
  });
  it('builds project->team and team->projects views', () => {
    teamRegistry.save(rec, HOME);
    expect(teamRegistry.membershipByProject(HOME).get(rec.projects[0].project_id)).toBe(rec.team_id);
    expect(teamRegistry.projectsForTeam(rec.team_id, HOME)).toEqual(rec.projects);
  });
  it('round-trips secrets separately from team.json', () => {
    teamRegistry.save(rec, HOME);
    teamRegistry.writeSecret(rec.team_id, 'MYCO_TEAM_API_KEY', 'k123', HOME);
    expect(teamRegistry.readSecrets(rec.team_id, HOME)['MYCO_TEAM_API_KEY']).toBe('k123');
    // secret must NOT leak into team.json
    expect(JSON.stringify(teamRegistry.get(rec.team_id, HOME))).not.toContain('k123');
  });
});
