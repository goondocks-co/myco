// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';

class MutationObserverStub {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return []; }
}
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const _g = globalThis as unknown as Record<string, unknown>;
if (typeof _g.MutationObserver === 'undefined') _g.MutationObserver = MutationObserverStub;
if (typeof _g.ResizeObserver === 'undefined') _g.ResizeObserver = ResizeObserverStub;

import type { GroveSummary, GrovesResponse } from '../../../packages/myco/ui/src/lib/selection';

const groves: GroveSummary[] = [
  {
    id: 'grove-a',
    name: 'Work',
    slug: 'work',
    mode: 'local',
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    project_count: 2,
    projects: [
      {
        project_id: 'project-a',
        name: 'Alpha',
        slug: 'alpha-abc',
        root: '/tmp/alpha',
        binding_id: 'gbind-a',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        manifest_state: 'present',
      },
      {
        project_id: 'project-b',
        name: 'Beta',
        slug: 'beta-def',
        root: '/tmp/beta',
        binding_id: 'gbind-b',
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
        manifest_state: 'present',
      },
    ],
  },
];

const grovesResponse: GrovesResponse = { groves };

mock.module('../../../packages/myco/ui/src/hooks/use-groves', () => ({
  useGroves: () => ({ data: grovesResponse }),
}));

import { ProjectSwitcher } from '../../../packages/myco/ui/src/components/ProjectSwitcher';

function renderSwitcher(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[ '/groves' ]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  render(<ProjectSwitcher />, { wrapper });
}

describe('ProjectSwitcher fallback on global routes', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('renders the remembered project label and grove subtitle when localStorage has a valid match', () => {
    window.localStorage.setItem(
      'myco.lastSelectedProject',
      JSON.stringify({ groveId: 'grove-a', projectId: 'project-b' }),
    );
    renderSwitcher();
    expect(screen.getByText('Beta')).toBeDefined();
    expect(screen.getByText('Work')).toBeDefined();
  });

  it('renders the placeholder when localStorage has no last-selection', () => {
    renderSwitcher();
    expect(screen.getByText('Select project')).toBeDefined();
  });

  it('renders the placeholder when the remembered ids do not match any loaded grove/project', () => {
    window.localStorage.setItem(
      'myco.lastSelectedProject',
      JSON.stringify({ groveId: 'grove-missing', projectId: 'project-missing' }),
    );
    renderSwitcher();
    expect(screen.getByText('Select project')).toBeDefined();
  });
});
