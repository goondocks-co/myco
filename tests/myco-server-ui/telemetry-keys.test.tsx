import { MemoryRouter } from 'react-router-dom';
import { afterEach, expect, it } from 'bun:test';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TelemetryKeys } from '../../packages/myco-server/ui/src/features/admin/settings/TelemetryKeys';
import { parentWords, SessionLineageTab } from '../../packages/myco-server/ui/src/features/sessions/Lineage';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});
it('shows connection counts and a key header once, then revokes with removal explained', async () => {
  let revoked = false;
  globalThis.fetch = (async (input, init) => {
    const path = String(input);
    if (init?.method === 'POST' && path.endsWith('/revoke')) {
      revoked = true;
      return Response.json({ revoked: true });
    }
    if (init?.method === 'POST')
      return Response.json({
        key: 'example-key',
        headers: 'Authorization=Bearer%20example-key',
        endpoint: 'https://example.test',
      });
    return Response.json({
      endpoint: 'https://example.test',
      keys: [
        {
          id: 'tk_test',
          label: 'Build service',
          lastUsedAt: Date.now(),
          revokedAt: revoked ? Date.now() : null,
          usedSpans: 100,
          spanQuota: 100,
          dailySpans: 3,
          clockSkewMs: 120000,
          quotaReached: true,
          cleanupDone: false,
          accepted: 8,
          rejected: 1,
        },
      ],
    });
  }) as typeof fetch;
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}
    >
      <TelemetryKeys />
    </QueryClientProvider>,
  );
  expect(await screen.findByText('8 accepted · 1 rejected spans in the last day')).toBeTruthy();
  expect(
    await screen.findByText('100 / 100 retained spans · about 3 a day over 30 days · Span quota reached'),
  ).toBeTruthy();
  expect(screen.getByText(/120 seconds/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Add telemetry key' }));
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'My sender' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
  expect(await screen.findByText('Authorization=Bearer%20example-key')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Done' }));
  await waitFor(() => expect(screen.queryByText('Authorization=Bearer%20example-key')).toBeNull());
  fireEvent.click(screen.getByRole('button', { name: 'Revoke' }));
  expect(await screen.findByText(/reports stop being used immediately/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke key' }));
  await waitFor(() => expect(revoked).toBe(true));
  expect(
    parentWords(
      {
        parentId: 'a',
        childId: 'b',
        kind: 'launched',
        reason: null,
        source: 'telemetry',
        serviceName: 'Build service',
        inferred: true,
        keyLabel: 'Approved sender',
      },
      'the lead',
    ),
  ).toBe('Probably started by the lead · reported by Approved sender (sender claims Build service)');
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
  globalThis.fetch = (async () =>
    Response.json({
      nodes: [
        node('worker'),
        node('lead-a'),
        { ...node('lead-a'), projectId: 'proj_2', label: 'Other Project lead' },
      ],
      edges: [],
      reports: [
        report('lead-a', 'First key'),
        { ...report('lead-a', 'Second key'), parentProjectId: 'proj_2', inferred: true },
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
    screen.getByText(/worker: probable parent Other Project lead · reported by Second key/),
  ).toBeTruthy();
  expect(screen.queryByText(/Child of/)).toBeNull();
});
