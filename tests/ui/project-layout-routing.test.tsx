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

describe('project-scoped layout routing', () => {
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

  it('renders project navigation links without treating resolved paths as functions', () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
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

    // Grove section is Dashboard / Maintenance / Settings post-
    // sidebar-regroup; Operations dissolved into Dashboard +
    // Maintenance. The Grove > Maintenance link is the natural
    // assertion — it's Grove-scoped (no project segment) and
    // tests the same path-template-replacement that used to be
    // exercised by Operations.
    const maintenanceLink = screen.getAllByText('Maintenance')[0]?.closest('a');
    expect(maintenanceLink?.getAttribute('href')).toBe('/g/work/maintenance');
    expect(screen.getByText('Dashboard content')).toBeTruthy();
  });
});
