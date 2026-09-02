import { describe, expect, it } from 'bun:test';
import { scopeOf, titleOf } from '../../packages/myco-server/ui/src/layout/Topbar';
import { projectRouteSuffix } from '../../packages/myco-server/ui/src/components/ProjectSwitcher';

describe('the breadcrumb', () => {
  it('names every page under a project and every server page, and says not found for the rest', () => {
    expect([
      titleOf('/p/x'), titleOf('/p/x/'), titleOf('/p/x/sessions'), titleOf('/p/x/sessions/abc'), titleOf('/p/x/cortex'),
      titleOf('/p/x/skills/sk1'), titleOf('/p/x/runs/r1'), titleOf('/p/x/access'), titleOf('/p/x/nope'),
      titleOf('/projects'), titleOf('/status'), titleOf('/access'), titleOf('/settings'), titleOf('/operations'), titleOf('/notifications'), titleOf('/nope'),
    ]).toEqual([
      'Overview', 'Overview', 'Sessions', 'Sessions', 'Cortex',
      'Skills', 'Agent runs', 'Access', 'Not found',
      'Projects', 'Status', 'Access', 'Settings', 'Operations', 'Notifications', 'Not found',
    ]);
    expect([scopeOf('/p/x/sessions'), scopeOf('/settings')]).toEqual(['project', 'server']);
  });

  it('keeps the page, not the record, when switching projects', () => {
    expect([projectRouteSuffix('/p/x'), projectRouteSuffix('/p/x/'), projectRouteSuffix('/p/x/sessions/abc'), projectRouteSuffix('/p/x/runs/r1'), projectRouteSuffix('/p/x/skills/sk1'), projectRouteSuffix('/projects')])
      .toEqual(['', '', '/sessions', '/runs', '/skills', '']);
  });
});
