import { describe, it, expect } from 'bun:test';
import {
  resolveTeamsDir, resolveTeamDir, resolveTeamConfigPath, resolveTeamSecretsPath,
} from '../../packages/myco/src/grove/paths.js';

describe('team paths', () => {
  const home = '/tmp/mycohome-test';
  const teamId = `team_${'a'.repeat(32)}`;
  it('resolves the teams dir and per-team files', () => {
    expect(resolveTeamsDir(home)).toBe(`${home}/teams`);
    expect(resolveTeamDir(teamId, home)).toBe(`${home}/teams/${teamId}`);
    expect(resolveTeamConfigPath(teamId, home)).toBe(`${home}/teams/${teamId}/team.json`);
    expect(resolveTeamSecretsPath(teamId, home)).toBe(`${home}/teams/${teamId}/secrets.env`);
  });
});
