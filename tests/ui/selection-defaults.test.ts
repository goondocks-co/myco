import { describe, expect, it } from 'bun:test';
import {
  mostRecentSelection,
  mostRecentProjectInGrove,
  type GroveSummary,
} from '../../packages/myco/ui/src/lib/selection';
import type { ProjectActivityRow } from '../../packages/myco/src/daemon/api/projects-activity';

function project(id: string, slug: string) {
  return {
    project_id: id, name: id, slug, root: `/tmp/${id}`, binding_id: null,
    created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    manifest_state: 'present' as const,
  };
}
const groveA: GroveSummary = {
  id: 'grove-a', name: 'Default', slug: 'default', mode: 'local', is_default: true,
  created_at: '2026-01-01T00:00:00.000Z', project_count: 2,
  projects: [project('p-first', 'p-first-1'), project('p-second', 'p-second-2')],
};
function activity(rows: Array<[string, string | null]>): ProjectActivityRow[] {
  return rows.map(([project_id, last_activity_at]) => ({
    grove_id: 'grove-a', grove_slug: 'default', project_id, project_name: project_id,
    project_root: `/tmp/${project_id}`, project_vault_dir: `/tmp/${project_id}/.myco`,
    last_activity_at, scheduled_runs_last_24h: 0, is_active: false,
  })) as ProjectActivityRow[];
}

describe('mostRecentSelection', () => {
  it('picks the project with the most recent activity across groves', () => {
    const sel = mostRecentSelection([groveA], activity([
      ['p-first', '2026-06-01T00:00:00.000Z'],
      ['p-second', '2026-06-10T00:00:00.000Z'],
    ]));
    expect(sel?.project.project_id).toBe('p-second');
  });
  it('falls back to the default grove first project when activity is absent', () => {
    const sel = mostRecentSelection([groveA], undefined);
    expect(sel?.project.project_id).toBe('p-first');
  });
  it('returns null when there are no projects', () => {
    expect(mostRecentSelection([], undefined)).toBeNull();
  });
  it('returns the first project when activity references only unknown projects', () => {
    const sel = mostRecentSelection([groveA], activity([
      ['unknown-x', '2026-06-10T00:00:00.000Z'],
    ]));
    expect(sel?.project.project_id).toBe('p-first');
  });
});

describe('mostRecentProjectInGrove', () => {
  it('picks the most recently active project within the grove', () => {
    const p = mostRecentProjectInGrove(groveA, activity([
      ['p-first', '2026-05-01T00:00:00.000Z'],
      ['p-second', '2026-06-10T00:00:00.000Z'],
    ]));
    expect(p?.project_id).toBe('p-second');
  });
  it('falls back to the first project when activity is absent', () => {
    expect(mostRecentProjectInGrove(groveA, undefined)?.project_id).toBe('p-first');
  });
  it('returns null when the grove has no projects', () => {
    const emptyGrove: GroveSummary = { ...groveA, projects: [], project_count: 0 };
    expect(mostRecentProjectInGrove(emptyGrove, undefined)).toBeNull();
  });
});
