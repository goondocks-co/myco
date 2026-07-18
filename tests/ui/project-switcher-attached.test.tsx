// @vitest-environment jsdom

/**
 * `ProjectSwitcher` renders an ATTACHED project inside its local Grove section
 * with a compact "Team" badge (E-4 local-view requirement, part c). The daemon
 * merge appends attached entries into `projects[]`, so the switcher needs no
 * attach-specific data plumbing — this pins the badge + section membership on a
 * fixture that mixes a local and an attached project in one Grove.
 */
import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { GroveSummary, GroveProjectSummary } from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();

const local: GroveProjectSummary = {
  project_id: 'proj_2222222222222222222222222222bbbb',
  name: 'Local Project',
  slug: 'local-project-123456',
  root: '/Users/dev/local-project',
  binding_id: 'gbind_x',
  status: 'active',
  archived_at: null,
  created_at: EPOCH,
  updated_at: EPOCH,
  manifest_state: 'present',
  capabilities: { cortex: true },
};

const attached: GroveProjectSummary = {
  project_id: 'proj_1111111111111111111111111111aaaa',
  name: 'Shared Service',
  slug: 'shared-service-abcdef',
  root: null,
  binding_id: null,
  status: 'active',
  archived_at: null,
  created_at: EPOCH,
  updated_at: EPOCH,
  manifest_state: 'present',
  attached: true,
  host_id: 'host_mac_studio',
  host_label: 'Mac Studio',
};

const grove: GroveSummary = {
  id: 'grove_teamprojects00000000000000000000',
  name: 'Team Projects',
  slug: 'team-projects',
  mode: 'local',
  is_default: true,
  created_at: EPOCH,
  project_count: 2,
  projects: [local, attached],
};

mock.module('../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({ data: { groves: [grove] } }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-maintenance-summary', () => ({
  useProjectsActivity: () => ({ data: { projects: [] } }),
}));
mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectSelection: () => null,
}));

// Imported AFTER the mocks so the component binds the stubbed hooks.
const { ProjectSwitcher } = await import('../../packages/myco/ui/src/components/ProjectSwitcher');

describe('ProjectSwitcher — attached project', () => {
  it('renders the attached project under its Grove section with a Team badge; local project has none', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/g/team-projects/p/local-project-123456']}>
        <ProjectSwitcher />
      </MemoryRouter>,
    );

    // Open the switcher dropdown (two projects ⇒ canSwitch).
    fireEvent.click(container.querySelector('button')!);

    // Section membership: the dropdown groups projects under the Grove's
    // uppercase heading (the trigger echoes the grove name too, so scope to the
    // heading element).
    const heading = screen
      .getAllByText('Team Projects')
      .find((el) => el.className.includes('uppercase'));
    expect(heading).toBeDefined();

    // The attached project renders as a row carrying the compact "Team" badge.
    const attachedRow = screen.getByText('Shared Service').closest('button')!;
    expect(within(attachedRow).getByText('Team')).toBeDefined();

    // That badge is the ONLY one in the list — the local project row has none.
    expect(screen.getAllByText('Team')).toHaveLength(1);
  });
});
