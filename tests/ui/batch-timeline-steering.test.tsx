// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BatchTimeline } from '../../packages/myco/ui/src/components/sessions/BatchTimeline';
import type { BatchRow, AttachmentRow } from '../../packages/myco/ui/src/hooks/use-sessions';

/* ---------- Fixtures ---------- */

const parentBatch: BatchRow = {
  id: 1,
  session_id: 'sess-1',
  prompt_number: 1,
  user_prompt: 'Build the feature',
  response_summary: 'Done.',
  classification: null,
  started_at: 100,
  ended_at: 200,
  status: 'complete',
  activity_count: 0,
  processed: 1,
  content_hash: null,
  created_at: 100,
  parent_prompt_batch_id: null,
  kind: 'initial',
};

const steeringChild: BatchRow = {
  id: 2,
  session_id: 'sess-1',
  prompt_number: 2,
  user_prompt: 'Wait — skip the validation for now',
  response_summary: null,
  classification: null,
  started_at: 150,
  ended_at: null,
  status: 'complete',
  activity_count: 0,
  processed: 1,
  content_hash: null,
  created_at: 150,
  parent_prompt_batch_id: 1,
  kind: 'steering',
};

const noAttachments: AttachmentRow[] = [];

/* ---------- Mock UI sub-components that pull in heavy deps ---------- */

vi.mock('../../packages/myco/ui/src/components/ui/markdown-content', () => ({
  MarkdownContent: ({ content }: { content: string }) => <span>{content}</span>,
}));

vi.mock('../../packages/myco/ui/src/components/ui/lightbox', () => ({
  Lightbox: () => null,
}));

vi.mock('../../packages/myco/ui/src/components/sessions/ActivityList', () => ({
  ActivityList: () => null,
}));

/* ---------- Mock setup ---------- */

const useSessionBatchesMock = vi.fn();
const useSessionAttachmentsMock = vi.fn();
const useBatchActivitiesMock = vi.fn();

vi.mock('../../packages/myco/ui/src/hooks/use-sessions', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../packages/myco/ui/src/hooks/use-sessions')>();
  return {
    ...actual,
    useSessionBatches: (...args: unknown[]) => useSessionBatchesMock(...args),
    useSessionAttachments: (...args: unknown[]) => useSessionAttachmentsMock(...args),
    useBatchActivities: (...args: unknown[]) => useBatchActivitiesMock(...args),
  };
});

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderWithClient(ui: React.ReactElement) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>{ui}</QueryClientProvider>,
  );
}

/* ---------- Tests ---------- */

describe('BatchTimeline — steering children', () => {
  beforeEach(() => {
    useSessionBatchesMock.mockReturnValue({
      data: [parentBatch, steeringChild],
      isLoading: false,
      isError: false,
    });
    useSessionAttachmentsMock.mockReturnValue({
      data: noAttachments,
      isLoading: false,
      isError: false,
    });
    useBatchActivitiesMock.mockReturnValue({
      data: [],
      isLoading: false,
    });
  });

  it('renders both prompt texts and a steering label', () => {
    renderWithClient(<BatchTimeline sessionId="sess-1" />);

    // Parent prompt appears
    expect(screen.getByText('Build the feature')).toBeInTheDocument();

    // Child prompt appears (inside collapsed parent card — DOM-present regardless of CSS)
    expect(screen.getByText('Wait — skip the validation for now')).toBeInTheDocument();

    // A "steering" label should be present (case-insensitive)
    expect(screen.getByText(/steering/i)).toBeInTheDocument();
  });

  it('renders the parent response_summary exactly once; children do not add their own', () => {
    renderWithClient(<BatchTimeline sessionId="sess-1" />);

    // "Done." appears exactly once (parent's response_summary)
    const matches = screen.queryAllByText(/done\./i);
    expect(matches).toHaveLength(1);
  });
});
