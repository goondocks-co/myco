import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'bun:test';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionLineageTab } from '../../packages/myco-server/ui/src/features/sessions/Lineage';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
it('lists disagreeing key reports without presenting either as the selected parent', async () => {
  const node = (sessionId: string) => ({
    sessionId,
    captured: true,
    label: sessionId,
    agent: null,
    startedAt: null,
    endedAt: null,
    depth: 0,
    placedUnder: null,
    current: sessionId === 'worker',
  });
  const report = (parentId: string, keyLabel: string) => ({
    parentId,
    childId: 'worker',
    kind: 'launched',
    reason: null,
    source: 'telemetry',
    keyLabel,
    serviceName: 'claimed service',
  });
  globalThis.fetch = (async (input) => String(input).endsWith('/invocations')
    ? Response.json({ rows: [], nextCursor: null })
    : Response.json({
      nodes: [
        node('worker'),
        node('lead-a'),
        { ...node('lead-a'), projectId: 'proj_2', label: 'Other Project lead' },
      ],
      edges: [],
      reports: [
        report('lead-a', 'First key'),
        { ...report('lead-a', 'Second key'), parentProjectId: 'proj_2' },
      ],
      truncated: false,
    })) as typeof fetch;
  render(
    <MemoryRouter>
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <SessionLineageTab projectId="proj_1" sessionId="worker" now={Date.now()} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
  expect(
    await screen.findByText('Reports disagree about a parent. No disputed parent is selected.'),
  ).toBeTruthy();
  expect(screen.getByText(/reported by First key/)).toBeTruthy();
  expect(
    screen.getByText(/worker: reported parent Other Project lead · reported by Second key/),
  ).toBeTruthy();
  expect(screen.queryByText(/Child of/)).toBeNull();
});
