// @vitest-environment jsdom

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EventsPanel } from '../../packages/myco/ui/src/components/agent/EventsPanel';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';

const SAMPLE_EVENTS = {
  events: [
    {
      id: 1,
      run_id: 'run-1',
      phase_name: 'describe',
      event_type: 'phase_start',
      tool_name: null,
      outcome: null,
      duration_ms: null,
      payload: null,
      recorded_at: 1_700_000_000,
    },
    {
      id: 2,
      run_id: 'run-1',
      phase_name: 'describe',
      event_type: 'pre_tool_use',
      tool_name: 'Read',
      outcome: null,
      duration_ms: null,
      payload: { path: 'a.ts' },
      recorded_at: 1_700_000_005,
    },
    {
      id: 3,
      run_id: 'run-1',
      phase_name: 'describe',
      event_type: 'post_tool_use',
      tool_name: 'Read',
      outcome: 'success',
      duration_ms: 42,
      payload: { path: 'a.ts', bytes: 128 },
      recorded_at: 1_700_000_006,
    },
    {
      id: 4,
      run_id: 'run-1',
      phase_name: 'describe',
      event_type: 'model_switch',
      tool_name: null,
      outcome: null,
      duration_ms: null,
      payload: null,
      recorded_at: 1_700_000_007,
    },
  ],
  count: 4,
};

beforeEach(() => {
  // @ts-expect-error — test scaffold
  globalThis.fetch = mock(async (url: string) => {
    if (typeof url === 'string' && url.includes('/events')) {
      return new Response(JSON.stringify(SAMPLE_EVENTS), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
});

function renderPanel(runStatus?: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <EventsPanel runId="run-1" runStatus={runStatus ?? 'completed'} />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

describe('EventsPanel', () => {
  it('renders one row per event with event_type and tool_name', async () => {
    renderPanel();
    const readItems = await screen.findAllByText('Read');
    expect(readItems.length).toBeGreaterThan(0);
    expect(screen.getByText('phase_start')).toBeDefined();
    expect(screen.getByText('pre_tool_use')).toBeDefined();
    expect(screen.getByText('post_tool_use')).toBeDefined();
  });

  it('renders an unrecognized event_type value as a plain label', async () => {
    renderPanel();
    await screen.findAllByText('Read');
    expect(screen.getByText('model_switch')).toBeDefined();
  });

  it('expands a row with a payload to show truncated pretty-printed JSON', async () => {
    renderPanel();
    const readItems = await screen.findAllByText('Read');
    const row = readItems
      .map((el) => el.closest('[role="button"]'))
      .find((el) => el !== null);
    expect(row).toBeDefined();
    fireEvent.click(row!);
    const jsonContent = screen.getAllByText(/"path": "a.ts"/);
    expect(jsonContent.length).toBeGreaterThan(0);
  });

  it('does not make phase_start (no payload) rows expandable', async () => {
    renderPanel();
    const phaseStart = await screen.findByText('phase_start');
    const row = phaseStart.closest('div[role="button"]');
    expect(row).toBeNull();
  });

  it('renders empty state when there are no events', async () => {
    // @ts-expect-error
    globalThis.fetch = mock(async (url: string) => {
      if (typeof url === 'string' && url.includes('/events')) {
        return new Response(JSON.stringify({ events: [], count: 0 }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <PowerProvider>
        <QueryClientProvider client={client}>
          <EventsPanel runId="run-empty" runStatus="completed" />
        </QueryClientProvider>
      </PowerProvider>,
    );
    await screen.findByText(/no lifecycle events recorded/i);
    expect(screen.getByText(/no lifecycle events recorded/i)).toBeDefined();
  });

  it('truncates a large payload at render rather than dumping it whole into the DOM', async () => {
    const bigPayload = { data: 'x'.repeat(5_000) };
    // @ts-expect-error
    globalThis.fetch = mock(async (url: string) => {
      if (typeof url === 'string' && url.includes('/events')) {
        return new Response(JSON.stringify({
          events: [{
            id: 1,
            run_id: 'run-1',
            phase_name: null,
            event_type: 'post_tool_use',
            tool_name: 'Write',
            outcome: 'success',
            duration_ms: 10,
            payload: bigPayload,
            recorded_at: 1_700_000_000,
          }],
          count: 1,
        }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <PowerProvider>
        <QueryClientProvider client={client}>
          <EventsPanel runId="run-1" runStatus="completed" />
        </QueryClientProvider>
      </PowerProvider>,
    );
    const writeItems = await screen.findAllByText('Write');
    const row = writeItems.map((el) => el.closest('[role="button"]')).find((el) => el !== null);
    fireEvent.click(row!);
    const pre = document.querySelector('pre');
    expect(pre).not.toBeNull();
    expect(pre!.textContent!.length).toBeLessThan(5_000);
    expect(pre!.textContent).toContain('truncated');
  });
});
