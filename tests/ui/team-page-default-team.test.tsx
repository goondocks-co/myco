import { describe, expect, it } from 'bun:test';
import { resolveDefaultSelectedTeamId } from '../../packages/myco/ui/src/pages/Team/select-default';

const TEAMS = [{ team_id: 't1' }, { team_id: 't2' }];

describe('Team page default team selection', () => {
  it('honors the URL team param when it is a registered team', () => {
    expect(resolveDefaultSelectedTeamId('t2', TEAMS)).toBe('t2');
  });
  it('auto-selects the first team when there is no URL param or stored selection', () => {
    expect(resolveDefaultSelectedTeamId(null, TEAMS)).toBe('t1');
  });
  it('honors a persisted selection over the first team', () => {
    expect(resolveDefaultSelectedTeamId(null, TEAMS, 't2')).toBe('t2');
  });
  it('URL param takes priority over the persisted selection', () => {
    expect(resolveDefaultSelectedTeamId('t1', TEAMS, 't2')).toBe('t1');
  });
  it('falls through a stale URL/stored id to the first team', () => {
    expect(resolveDefaultSelectedTeamId('gone', TEAMS, 'also-gone')).toBe('t1');
  });
  it('returns undefined only when there are no teams', () => {
    expect(resolveDefaultSelectedTeamId(null, [])).toBeUndefined();
    expect(resolveDefaultSelectedTeamId('x', [], 'y')).toBeUndefined();
  });
});
