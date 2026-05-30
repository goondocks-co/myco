import { describe, it, expect } from 'bun:test';
import { createTeamId, assertTeamId, isGroveEraId } from '../../packages/myco/src/grove/ids.js';

describe('team id', () => {
  it('mints a prefixed opaque id', () => {
    const id = createTeamId();
    expect(id).toMatch(/^team_[0-9a-f]{32}$/);
    expect(isGroveEraId(id, 'team')).toBe(true);
  });
  it('asserts valid ids and rejects others', () => {
    expect(assertTeamId(createTeamId())).toMatch(/^team_/);
    expect(() => assertTeamId('grove_'.padEnd(38, 'a'))).toThrow();
    expect(() => assertTeamId('nope')).toThrow();
  });
});
