import { describe, expect, it } from 'bun:test';
import { resolveDefaultSelectedTeamId } from '../../packages/myco/ui/src/pages/Team/select-default';

describe('Team page default team selection', () => {
  it('returns the URL team param when present', () => {
    expect(resolveDefaultSelectedTeamId('t-url', [{ team_id: 't1' }, { team_id: 't2' }])).toBe('t-url');
  });
  it('returns undefined (no auto-pick) when no URL param, instead of teams[0]', () => {
    expect(resolveDefaultSelectedTeamId(null, [{ team_id: 't1' }, { team_id: 't2' }])).toBeUndefined();
  });
  it('returns undefined when no URL param and no teams', () => {
    expect(resolveDefaultSelectedTeamId(null, [])).toBeUndefined();
  });
});
