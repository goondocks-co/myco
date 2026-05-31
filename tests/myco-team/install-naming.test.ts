import { describe, it, expect } from 'bun:test';
import { resourceName } from '../../packages/myco-team/src/cli.js';
import { slugifyGroveName, createTeamId } from '../../packages/myco/src/grove/ids.js';

describe('install team naming', () => {
  it('derives the asset name from the team name + team id, not the Grove', () => {
    const teamId = createTeamId();
    const scope = {
      vaultDir: '/tmp/v', requestContext: { groveId: `grove_${'a'.repeat(32)}` },
      stateDir: '/tmp/v', resourceSeed: teamId,
      resourceSlug: slugifyGroveName('Myco Projects'), label: 'team',
    } as any;
    expect(scope.resourceSlug).toBe('myco-projects');
    expect(resourceName(scope)).toMatch(/^myco-team-myco-projects-[0-9a-f]+$/);
  });
});
