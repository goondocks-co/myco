import { describe, it, expect } from 'bun:test';
import { withProjectAdded, withProjectRemoved, type TeamRecord } from '../../packages/myco/src/team/registry.js';

const base: TeamRecord = { team_id:'team_'+'a'.repeat(32), name:'T', worker_url:'u', domain:null, mcp_endpoint:null, created_at:'t', projects:[] };
const ref = { grove_id:'grove_'+'b'.repeat(32), project_id:'proj_'+'c'.repeat(32) };

describe('membership helpers', () => {
  it('adds idempotently', () => {
    const once = withProjectAdded(base, ref);
    expect(once.projects).toEqual([ref]);
    expect(withProjectAdded(once, ref).projects).toEqual([ref]); // no dup
  });
  it('removes by project_id', () => {
    const withIt = withProjectAdded(base, ref);
    expect(withProjectRemoved(withIt, ref.project_id).projects).toEqual([]);
  });
});
