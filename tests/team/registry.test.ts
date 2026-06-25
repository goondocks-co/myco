import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRegistry, type TeamRecord } from '../../packages/myco/src/team/registry.js';

let home: string;
let teamHome: string;
const rec: TeamRecord = {
  team_id: `team_${'a'.repeat(32)}`,
  name: 'Myco Projects',
  worker_url: 'https://x.workers.dev',
  domain: null,
  mcp_endpoint: 'https://x.workers.dev/mcp',
  created_at: '2026-05-30T00:00:00Z',
  projects: [{ grove_id: `grove_${'b'.repeat(32)}`, project_id: `proj_${'c'.repeat(32)}` }],
};

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'teamreg-'));
  teamHome = path.join(home, 'team-home');
  process.env.MYCO_TEAM_HOME = teamHome;
});
afterEach(() => {
  delete process.env.MYCO_TEAM_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('teamRegistry', () => {
  it('list is empty when no teams dir', () => {
    expect(teamRegistry.list()).toEqual([]);
  });
  it('saves, lists, gets, and removes', () => {
    teamRegistry.save(rec);
    expect(teamRegistry.list().map(r => r.team_id)).toEqual([rec.team_id]);
    expect(teamRegistry.get(rec.team_id)?.name).toBe('Myco Projects');
    teamRegistry.remove(rec.team_id);
    expect(teamRegistry.list()).toEqual([]);
    expect(teamRegistry.get(rec.team_id)).toBeNull();
  });
  it('builds project->team and team->projects views', () => {
    teamRegistry.save(rec);
    expect(teamRegistry.membershipByProject().get(rec.projects[0].project_id)).toBe(rec.team_id);
    expect(teamRegistry.projectsForTeam(rec.team_id)).toEqual(rec.projects);
  });
  it('round-trips secrets separately from team.json', () => {
    teamRegistry.save(rec);
    teamRegistry.writeSecret(rec.team_id, 'MYCO_TEAM_API_KEY', 'k123');
    expect(teamRegistry.readSecrets(rec.team_id)['MYCO_TEAM_API_KEY']).toBe('k123');
    // secret must NOT leak into team.json
    expect(JSON.stringify(teamRegistry.get(rec.team_id))).not.toContain('k123');
  });
});
