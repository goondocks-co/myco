import { describe, it, expect } from 'bun:test';
import { buildTeamConfigSeed } from '../../packages/myco-team/src/cli.js';

describe('buildTeamConfigSeed', () => {
  it('includes team_id so /connect can echo a worker-authoritative id', () => {
    const seed = buildTeamConfigSeed({
      teamId: 'team_abc',
      teamName: 'Acme Core',
      createdBy: 'chris_a7b3c2',
      createdAt: '1780000000',
    });
    expect(seed.team_id).toBe('team_abc');
    expect(seed.team_name).toBe('Acme Core');
    expect(seed.embedding_model).toBe('@cf/baai/bge-m3');
    expect(seed.embedding_dimensions).toBe('1024');
    expect(seed.created_by).toBe('chris_a7b3c2');
    expect(seed.created_at).toBe('1780000000');
  });
});
