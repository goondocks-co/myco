// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from '../helpers/vi-shim.js';
import Layout from '../../packages/myco/ui/src/layout/Layout';
import { ProjectSelectionBoundary } from '../../packages/myco/ui/src/hooks/use-project-selection';
import type { ProjectSelection } from '../../packages/myco/ui/src/lib/selection';

mock.module('../../packages/myco/ui/src/hooks/use-update-status', () => ({
  useUpdateStatus: () => ({ data: { exempt: false, update_available: false } }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: null }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-restart', () => ({
  useRestart: () => ({ restart: vi.fn(), isRestarting: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-notifications', () => ({
  useUnreadCount: () => ({ data: { count: 0 } }),
}));

mock.module('../../packages/myco/ui/src/components/search/GlobalSearch', () => ({
  GlobalSearch: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/NotificationBanner', () => ({
  NotificationBanner: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/NotificationPanel', () => ({
  NotificationPanel: () => null,
}));

mock.module('../../packages/myco/ui/src/components/notifications/SystemNotifications', () => ({
  SystemNotifications: () => null,
}));

mock.module('../../packages/myco/ui/src/layout/AppearanceSection', () => ({
  AppearanceSection: () => null,
}));

mock.module('../../packages/myco/ui/src/hooks/use-git-identity', () => ({
  useGitIdentity: () => ({ data: null, isPending: false, isError: false }),
}));

const selection: ProjectSelection = {
  grove: {
    id: 'grove-a',
    name: 'Work',
    slug: 'work',
    mode: 'local',
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    project_count: 1,
    projects: [],
  },
  project: {
    project_id: 'project-a',
    name: 'Project A',
    slug: 'project-a-123abc',
    root: '/tmp/project-a',
    binding_id: 'gbind-a',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    manifest_state: 'present',
  },
};

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/g/work/p/project-a-123abc']}>
        <Routes>
          <Route
            path="/g/work/p/project-a-123abc"
            element={(
              <ProjectSelectionBoundary selection={selection}>
                <Layout />
              </ProjectSelectionBoundary>
            )}
          >
            <Route index element={<div>Dashboard content</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('sidebar v7 IA grouping', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    const localStorageMock = {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, String(value)),
      removeItem: (key: string) => storage.delete(key),
      clear: () => storage.clear(),
      key: (index: number) => Array.from(storage.keys())[index] ?? null,
      get length() {
        return storage.size;
      },
    };
    vi.stubGlobal('localStorage', localStorageMock);
    window.localStorage = localStorageMock as Storage;
    vi.stubGlobal('location', window.location);
    const matchMedia = () => ({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    vi.stubGlobal('matchMedia', matchMedia);
    window.matchMedia = matchMedia as unknown as typeof window.matchMedia;
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'getContext', {
      configurable: true,
      value: () => ({
        beginPath: vi.fn(),
        rect: vi.fn(),
        fill: vi.fn(),
        fillText: vi.fn(),
      }),
    });
    Object.defineProperty(window.HTMLCanvasElement.prototype, 'toDataURL', {
      configurable: true,
      value: () => 'data:image/png;base64,',
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the four nav group labels in v7 order', () => {
    renderLayout();
    const nav = screen.getByLabelText('Main navigation');
    const labels = Array.from(nav.querySelectorAll('div'))
      .map((el) => el.textContent?.trim())
      .filter((text): text is string =>
        text === 'Project' ||
        text === 'Observability' ||
        text === 'Grove management' ||
        text === 'Settings',
      );
    expect(labels).toEqual(['Project', 'Observability', 'Grove management', 'Settings']);
  });

  it('groups items into the correct categories', () => {
    renderLayout();
    const nav = screen.getByLabelText('Main navigation');
    // Each group is a direct child <div> of <nav>; the first <div> inside
    // it (when expanded) is the uppercase label, so we filter to the
    // group block whose first child div text matches.
    const groups = Array.from(nav.children) as HTMLElement[];

    function itemsInGroup(label: string): string[] {
      const group = groups.find((g) => g.querySelector('div')?.textContent?.trim() === label);
      if (!group) return [];
      return Array.from(group.querySelectorAll('a'))
        .map((a) => a.getAttribute('href') ?? '')
        .filter((h) => h.length > 0);
    }

    const projectHrefs = itemsInGroup('Project');
    expect(projectHrefs).toContain('/g/work/p/project-a-123abc');
    expect(projectHrefs.some((h) => h.endsWith('/sessions'))).toBe(true);
    expect(projectHrefs.some((h) => h.endsWith('/agent'))).toBe(true);

    const observabilityHrefs = itemsInGroup('Observability');
    expect(observabilityHrefs).toContain('/g/work/operations');
    expect(observabilityHrefs).toContain('/logs');

    const groveMgmtHrefs = itemsInGroup('Grove management');
    expect(groveMgmtHrefs).toContain('/g/work/dashboard');
    expect(groveMgmtHrefs).toContain('/groves');
    expect(groveMgmtHrefs).toContain('/g/work/team');

    const settingsHrefs = itemsInGroup('Settings');
    expect(settingsHrefs.some((h) => h.endsWith('/settings'))).toBe(true);
  });

  it('has exactly one Settings link in the sidebar', () => {
    renderLayout();
    const nav = screen.getByLabelText('Main navigation');
    const settingsLinks = Array.from(nav.querySelectorAll('a')).filter(
      (a) => a.textContent?.trim() === 'Settings',
    );
    expect(settingsLinks.length).toBe(1);
  });

  it('does not render any Maintenance link in the sidebar', () => {
    renderLayout();
    const nav = screen.getByLabelText('Main navigation');
    const maintenanceLinks = Array.from(nav.querySelectorAll('a')).filter(
      (a) => a.textContent?.trim() === 'Maintenance',
    );
    expect(maintenanceLinks.length).toBe(0);
  });
});
