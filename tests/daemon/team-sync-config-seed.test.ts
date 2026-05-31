import { describe, it, expect } from 'bun:test';
import { planConfigSeed } from '../../packages/myco/src/daemon/team-sync-init.js';

const desired = { teamId: 'team_x', teamName: 'X', createdBy: 'm', createdAt: '1780000000' };

describe('planConfigSeed', () => {
  it('PUTs only team_id when the name is present but the id is missing', () => {
    const puts = planConfigSeed({ team_name: 'X' }, desired);
    expect(puts).toEqual([{ team_id: 'team_x' }]);
  });

  it('PUTs the full seed when nothing is set', () => {
    const puts = planConfigSeed({}, desired);
    expect(puts[0]).toEqual({ team_id: 'team_x' });
    expect(puts[1].team_name).toBe('X');
    expect(puts[1].embedding_model).toBe('@cf/baai/bge-m3');
  });

  it('PUTs nothing when both are already set', () => {
    expect(planConfigSeed({ team_id: 'team_x', team_name: 'X' }, desired)).toEqual([]);
  });
});
