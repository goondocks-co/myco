// @vitest-environment jsdom

/**
 * `findSelection` / `selectionFromLast` must resolve an ATTACHED project entry
 * exactly like a local one, so a deep link `/g/<groveSlug>/p/<projectSlug>` and a
 * switcher click both land on the right project while an attached project is the
 * member's active selection (E-4 local-view requirement, part c). Attached
 * entries are appended into their local Grove's `projects[]` by the daemon merge
 * and slugged with the SAME `projectUrlSlug` formula, so these resolvers need no
 * attach-specific branch — this pins that they in fact resolve.
 */
import { beforeEach, describe, expect, it } from 'bun:test';
import {
  findSelection,
  selectionFromLast,
  writeLastSelection,
  type GroveProjectSummary,
  type GroveSummary,
} from '../../packages/myco/ui/src/lib/selection';

const EPOCH = new Date(0).toISOString();

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

describe('selection resolution for attached entries', () => {
  beforeEach(() => window.localStorage.clear());

  it('findSelection resolves an attached entry by (groveSlug, projectSlug) deep link', () => {
    const result = findSelection([grove], 'team-projects', 'shared-service-abcdef');
    expect(result?.project.project_id).toBe(attached.project_id);
    expect(result?.project.attached).toBe(true);
    expect(result?.grove.id).toBe(grove.id);
  });

  it('findSelection resolves an attached entry by project_id (switcher click fallback)', () => {
    const result = findSelection([grove], grove.id, attached.project_id);
    expect(result?.project.project_id).toBe(attached.project_id);
  });

  it('selectionFromLast rehydrates an attached entry from stored last-selection', () => {
    writeLastSelection({ grove, project: attached });
    const result = selectionFromLast([grove]);
    expect(result?.grove.id).toBe(grove.id);
    expect(result?.project.project_id).toBe(attached.project_id);
    expect(result?.project.attached).toBe(true);
  });
});
