/**
 * Regression coverage for the sidebar nav-link URL resolver.
 *
 * Bug: On machine-wide pages (/groves, /logs, /settings) the
 * GlobalSelectionBoundary leaves ProjectSelection null. The previous
 * resolver fell back to '/' for any grove-scoped nav item with a
 * `:groveSlug` template, which then redirected via RootRedirect to the
 * Dashboard — making Operations, Grove, and Team unreachable from
 * machine-wide pages without first picking a project.
 *
 * Fix: resolve a fallback grove from the loaded grove list the same way
 * LegacyGroveRedirect does (selectionFromLast → defaultSelection →
 * first grove). These tests pin both branches of the new behavior.
 */

import { describe, it, expect } from 'bun:test';
import { resolveNavLinkTo, type NavItem } from '../../../packages/myco/ui/src/layout/Layout';
import type { GroveSummary, ProjectSelection } from '../../../packages/myco/ui/src/lib/selection';

const groveA: GroveSummary = {
  id: 'grove-a',
  name: 'Alpha',
  slug: 'alpha',
  mode: 'local',
  is_default: true,
  created_at: '2026-01-01T00:00:00.000Z',
  project_count: 1,
  projects: [
    {
      project_id: 'proj-1',
      name: 'P1',
      slug: 'p1',
      root: '/tmp/p1',
      binding_id: 'bind-1',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      manifest_state: 'present',
    },
  ],
};

const groveB: GroveSummary = {
  ...groveA,
  id: 'grove-b',
  name: 'Beta',
  slug: 'beta',
  is_default: false,
  projects: [
    {
      ...groveA.projects[0]!,
      project_id: 'proj-2',
      slug: 'p2',
      root: '/tmp/p2',
      binding_id: 'bind-2',
    },
  ],
};

const machineItem: NavItem = {
  to: '/groves',
  label: 'Groves',
  icon: (() => null) as never,
  scope: 'machine',
  category: 'Grove management',
};

const projectItem: NavItem = {
  to: '/sessions',
  label: 'Sessions',
  icon: (() => null) as never,
  scope: 'project',
  category: 'Project',
};

const groveItem: NavItem = {
  to: '/g/:groveSlug/team',
  label: 'Team',
  icon: (() => null) as never,
  scope: 'grove',
  category: 'Grove management',
};

const groveItemNoSlug: NavItem = {
  to: '/g/somewhere',
  label: 'Other',
  icon: (() => null) as never,
  scope: 'grove',
  category: 'Grove management',
};

const selectionA: ProjectSelection = { grove: groveA, project: groveA.projects[0]! };

describe('resolveNavLinkTo', () => {
  it('returns item.to unchanged for machine-scoped items regardless of selection', () => {
    expect(resolveNavLinkTo(machineItem, null, '/anything', [])).toBe('/groves');
    expect(resolveNavLinkTo(machineItem, selectionA, '/anything', [groveA])).toBe('/groves');
  });

  it('returns projectScopedTo for project-scoped items', () => {
    expect(resolveNavLinkTo(projectItem, selectionA, '/g/alpha/p/p1/sessions', [groveA]))
      .toBe('/g/alpha/p/p1/sessions');
    // When selection is null, useProjectPath returns the legacy un-grove
    // path; the helper should pass that through verbatim.
    expect(resolveNavLinkTo(projectItem, null, '/sessions', [groveA])).toBe('/sessions');
  });

  it('substitutes the selected grove slug into a grove-scoped template', () => {
    expect(resolveNavLinkTo(groveItem, selectionA, '/anything', [groveA]))
      .toBe('/g/alpha/team');
  });

  it('falls back to the first available grove when ProjectSelection is null (the bug)', () => {
    // Pre-fix this returned '/' and silently redirected to the Dashboard.
    expect(resolveNavLinkTo(groveItem, null, '/anything', [groveA]))
      .toBe('/g/alpha/team');
  });

  it('falls back to the default grove when multiple groves exist and no selection', () => {
    // groveA has is_default: true.
    expect(resolveNavLinkTo(groveItem, null, '/anything', [groveB, groveA]))
      .toBe('/g/alpha/team');
  });

  it('returns "/" only when there are NO groves at all (truly empty install)', () => {
    expect(resolveNavLinkTo(groveItem, null, '/anything', [])).toBe('/');
  });

  it('returns projectScopedTo for a grove-scoped item without :groveSlug (legacy shape)', () => {
    // Some grove-scoped items in the past lacked a :groveSlug template
    // and stayed under the project-scoped layout. The helper still
    // honors that shape.
    expect(resolveNavLinkTo(groveItemNoSlug, selectionA, '/g/alpha/p/p1/somewhere', [groveA]))
      .toBe('/g/alpha/p/p1/somewhere');
  });
});
