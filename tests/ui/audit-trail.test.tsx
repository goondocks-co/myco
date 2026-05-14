// @vitest-environment jsdom

import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuditTrail } from '../../packages/myco/ui/src/components/agent/AuditTrail';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';

const SAMPLE_AUDIT = {
  audit: {
    runId: 'run-1',
    taskName: 'describe',
    dryRun: false,
    phases: [
      {
        phaseName: 'describe',
        status: 'completed',
        summary: 'Extracted 3 entities.',
        turnsUsed: 2,
        maxTurns: null,
        tokensUsed: 1200,
        costUsd: 0.002,
        costSource: 'actual',
        durationMs: 2400,
        startedAt: null,
        completedAt: 1_700_000_120,
        skipReason: null,
        toolCalls: { Read: 1, Write: 1 },
        toolErrors: {},
        writeIntents: null,
        reports: [],
      },
      {
        phaseName: 'embed',
        status: 'completed',
        summary: null,
        turnsUsed: 1,
        maxTurns: null,
        tokensUsed: 400,
        costUsd: 0.001,
        costSource: 'actual',
        durationMs: 800,
        startedAt: null,
        completedAt: 1_700_000_180,
        skipReason: null,
        toolCalls: { Embed: 1 },
        toolErrors: {},
        writeIntents: null,
        reports: [],
      },
    ],
  },
};

const SAMPLE_TURNS = [
  {
    id: 1,
    run_id: 'run-1',
    agent_id: 'agent-1',
    turn_number: 1,
    tool_name: 'Read',
    tool_input: '{"path":"a.ts"}',
    tool_output_summary: 'read 12 lines',
    started_at: 1_700_000_005,
    completed_at: 1_700_000_006,
  },
  {
    id: 2,
    run_id: 'run-1',
    agent_id: 'agent-1',
    turn_number: 2,
    tool_name: 'Write',
    tool_input: '{"path":"a.ts"}',
    tool_output_summary: 'wrote 12 lines',
    started_at: 1_700_000_015,
    completed_at: 1_700_000_016,
  },
  {
    id: 3,
    run_id: 'run-1',
    agent_id: 'agent-1',
    turn_number: 3,
    tool_name: 'Embed',
    tool_input: '{"text":"..."}',
    tool_output_summary: null,
    started_at: 1_700_000_130,
    completed_at: 1_700_000_131,
  },
];

beforeEach(() => {
  // @ts-expect-error — test scaffold
  globalThis.fetch = mock(async (url: string) => {
    if (typeof url === 'string' && url.includes('/audit')) {
      return new Response(JSON.stringify(SAMPLE_AUDIT), { status: 200 });
    }
    if (typeof url === 'string' && url.includes('/turns')) {
      return new Response(JSON.stringify(SAMPLE_TURNS), { status: 200 });
    }
    return new Response('{}', { status: 200 });
  });
});

function renderTrail() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <AuditTrail runId="run-1" />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

describe('AuditTrail', () => {
  it('renders phase names from audit data', async () => {
    renderTrail();
    // Phase names appear as section headers in the phase cards
    const describePhrases = await screen.findAllByText(/describe/i);
    expect(describePhrases.length).toBeGreaterThan(0);
    const embedPhrases = await screen.findAllByText(/embed/i);
    expect(embedPhrases.length).toBeGreaterThan(0);
  });

  it('renders one row per turn with tool names', async () => {
    renderTrail();
    // Turn trace section header should appear
    await screen.findByText(/turn trace/i);
    // Tool names appear in turn rows (exact span text, unlike badges which show "Tool × N")
    const readItems = await screen.findAllByText('Read');
    expect(readItems.length).toBeGreaterThan(0);
    const writeItems = await screen.findAllByText('Write');
    expect(writeItems.length).toBeGreaterThan(0);
    const embedItems = await screen.findAllByText('Embed');
    expect(embedItems.length).toBeGreaterThan(0);
  });

  it('expands a turn row to show input/output on click', async () => {
    renderTrail();
    // Wait for turn trace to render, then find the exact "Read" tool name span
    await screen.findByText(/turn trace/i);
    const readSpans = await screen.findAllByText('Read');
    // The turn row div has role="button" — click the one that is inside a turn row
    const turnRow = readSpans
      .map((el) => el.closest('[role="button"]'))
      .find((el) => el !== null);
    expect(turnRow).toBeDefined();
    fireEvent.click(turnRow!);
    // After expansion, the parsed JSON and output summary should appear
    const jsonContent = screen.getAllByText(/"path": "a.ts"/);
    expect(jsonContent.length).toBeGreaterThan(0);
    expect(screen.getByText(/read 12 lines/i)).toBeDefined();
  });

  it('renders empty state when there are no turns or phases', async () => {
    // @ts-expect-error
    globalThis.fetch = mock(async (url: string) => {
      if (typeof url === 'string' && url.includes('/audit')) {
        return new Response(
          JSON.stringify({ audit: { runId: 'run-empty', taskName: null, dryRun: false, phases: [] } }),
          { status: 200 },
        );
      }
      if (typeof url === 'string' && url.includes('/turns')) {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <PowerProvider>
        <QueryClientProvider client={client}>
          <AuditTrail runId="run-empty" />
        </QueryClientProvider>
      </PowerProvider>,
    );
    await screen.findByText(/no recorded tool calls/i);
    expect(screen.getByText(/no recorded tool calls/i)).toBeDefined();
  });
});
