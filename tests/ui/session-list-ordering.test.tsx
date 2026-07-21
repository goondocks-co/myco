// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import type { SessionDetail, SessionSummary } from '../../packages/myco/ui/src/hooks/use-sessions';

let sessionsFixture: SessionSummary[] = [];
let sessionDetailFixture: SessionDetail | null = null;
let symbiontsFixture = [
  { name: 'codex', displayName: 'Codex', enabled: true },
  { name: 'claude-code', displayName: 'Claude Code', enabled: true },
];

mock.module('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useSessions: () => ({
    data: {
      sessions: sessionsFixture,
      total: sessionsFixture.length,
      offset: 0,
      limit: sessionsFixture.length,
    },
    isLoading: false,
    isError: false,
    error: null,
  }),
  useSession: () => ({
    data: sessionDetailFixture,
    isLoading: false,
    isError: false,
    error: null,
  }),
  useDeleteSession: () => ({ mutate: () => {}, isPending: false }),
  useSessionImpact: () => ({ data: undefined }),
  useSessionPlans: () => ({ data: [] }),
  useCompleteSession: () => ({ mutate: () => {}, isPending: false, isSuccess: false }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-symbionts', () => ({
  useSymbionts: () => ({ data: { symbionts: symbiontsFixture } }),
  buildResumeCommand: () => null,
}));

mock.module('../../packages/myco/ui/src/hooks/use-agent', () => ({
  useTriggerRun: () => ({ mutateAsync: async () => undefined }),
}));

mock.module('../../packages/myco/ui/src/components/sessions/BatchTimeline', () => ({
  BatchTimeline: () => <div data-testid="batch-timeline" />,
}));

mock.module('../../packages/myco/ui/src/components/sessions/SessionPlans', () => ({
  SessionPlans: () => <div data-testid="session-plans" />,
}));

mock.module('../../packages/myco/ui/src/components/sessions/SessionSpores', () => ({
  SessionSpores: () => <div data-testid="session-spores" />,
}));

mock.module('../../packages/myco/ui/src/components/sessions/CanopyEfficiencyTile', () => ({
  CanopyEfficiencyTile: () => <div data-testid="canopy-efficiency" />,
}));

import { SessionList } from '../../packages/myco/ui/src/components/sessions/SessionList';
import { SessionDetail } from '../../packages/myco/ui/src/components/sessions/SessionDetail';

function makeSession(overrides: Partial<SessionSummary>): SessionSummary {
  return {
    id: 'sess-default',
    date: '2026-06-28',
    title: 'Default session',
    status: 'completed',
    agent: 'codex',
    prompt_count: 1,
    tool_count: 1,
    started_at: Date.UTC(2026, 5, 28, 10, 0, 0) / 1000,
    ended_at: null,
    activity_buckets: [],
    branch: null,
    ...overrides,
  };
}

function makeDetail(overrides: Partial<SessionDetail>): SessionDetail {
  return {
    id: 'sess-detail',
    agent: 'codex',
    user: null,
    project_id: null,
    project_root: null,
    branch: null,
    started_at: Date.UTC(2026, 5, 28, 10, 0, 0) / 1000,
    ended_at: null,
    status: 'completed',
    prompt_count: 1,
    tool_count: 1,
    title: 'Detail session',
    summary: null,
    transcript_path: null,
    parent_session_id: null,
    parent_session_reason: null,
    processed: 1,
    content_hash: null,
    created_at: Date.UTC(2026, 5, 28, 10, 0, 0) / 1000,
    ...overrides,
  };
}

function renderList(props: Partial<Parameters<typeof SessionList>[0]> = {}, initial = '/sessions') {
  const onSelectSession = mock(() => {});
  const view = render(
    <MemoryRouter initialEntries={[initial]}>
      <SessionList
        offset={0}
        onOffsetChange={() => {}}
        onSelectSession={onSelectSession}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...view, onSelectSession };
}

describe('SessionList rendered order', () => {
  it('auto-selects the first rendered row when raw API order differs from section order', async () => {
    sessionsFixture = [
      makeSession({ id: 'today', title: 'Today session', status: 'completed' }),
      makeSession({ id: 'active', title: 'Active session', status: 'active' }),
    ];

    const { onSelectSession } = renderList();

    await waitFor(() => {
      expect(onSelectSession).toHaveBeenCalledWith('active', { replace: true });
    });
  });

  it('moves and activates through rows in rendered order', async () => {
    sessionsFixture = [
      makeSession({ id: 'today', title: 'Today session', status: 'completed' }),
      makeSession({ id: 'active', title: 'Active session', status: 'active' }),
      makeSession({
        id: 'yesterday',
        title: 'Yesterday session',
        status: 'completed',
        started_at: Date.UTC(2026, 5, 27, 10, 0, 0) / 1000,
      }),
    ];

    const { onSelectSession } = renderList({ selectedId: 'active' });
    const list = screen.getByRole('list', { name: 'Session archive' });

    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });

    await waitFor(() => {
      expect(onSelectSession).toHaveBeenLastCalledWith('today');
    });
  });

  it('preserves a selected deep link outside the current page instead of auto-selecting a replacement', async () => {
    sessionsFixture = [
      makeSession({ id: 'active', title: 'Active session', status: 'active' }),
    ];

    const { onSelectSession } = renderList({ selectedId: 'not-on-this-page' });

    await waitFor(() => expect(screen.getByText('Active session')).toBeDefined());
    expect(onSelectSession).not.toHaveBeenCalled();
  });
});

describe('session symbiont labels', () => {
  it('renders manifest display labels without raw-plus-display duplication', async () => {
    sessionsFixture = [
      makeSession({ id: 'codex-session', title: 'Codex session', agent: 'codex', prompt_count: 2, tool_count: 1 }),
    ];

    renderList({ selectedId: 'codex-session' });

    await waitFor(() => expect(screen.getByText(/Codex · 2p · 1t/)).toBeDefined());
    expect(screen.queryByText(/codex · Codex/)).toBeNull();
  });

  it('falls back to the raw agent id for unknown symbionts', async () => {
    sessionsFixture = [
      makeSession({ id: 'unknown-session', title: 'Unknown session', agent: 'future-agent', prompt_count: 3, tool_count: 4 }),
    ];

    renderList({ selectedId: 'unknown-session' });

    await waitFor(() => expect(screen.getByText(/future-agent · 3p · 4t/)).toBeDefined());
  });

  it('uses the display label in the session detail header badge', async () => {
    sessionDetailFixture = makeDetail({ id: 'detail-1', agent: 'codex' });

    // SessionDetail reads the host membership list + active project selection
    // to un-synthesize an attached session's project root, both of which run
    // through React Query — provide a client (retry off; the reads settle to
    // empty, which the un-synthesize path treats as "no substitution").
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <PowerProvider>
        <QueryClientProvider client={client}>
          <MemoryRouter initialEntries={['/sessions/detail-1']}>
            <SessionDetail id="detail-1" />
          </MemoryRouter>
        </QueryClientProvider>
      </PowerProvider>,
    );

    await waitFor(() => expect(screen.getByText('Codex')).toBeDefined());
    expect(screen.queryByText('codex')).toBeNull();
  });
});
