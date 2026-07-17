// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { PromptBatchCard } from '../../packages/myco/ui/src/components/sessions/PromptBatchCard';
import type { BatchRow } from '../../packages/myco/ui/src/hooks/use-sessions';

function makeBatch(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id: 1,
    session_id: 'sess-test',
    prompt_number: 1,
    user_prompt: 'review the diff',
    response_summary: null,
    classification: null,
    started_at: 1780326031,
    ended_at: 1780326527,
    status: 'completed',
    activity_count: 0,
    processed: 1,
    content_hash: null,
    created_at: 1780326031,
    parent_prompt_batch_id: null,
    kind: 'initial',
    origin: 'agent_dispatch',
    thread_id: null,
    thread_label: null,
    ...overrides,
  };
}

describe('PromptBatchCard', () => {
  it('renders the thread label chip when the batch carries a thread_label', () => {
    render(
      <PromptBatchCard
        batch={makeBatch({ thread_id: 'thread-abc', thread_label: 'task_6_reviewer' })}
        batchAttachments={[]}
        steeringChildren={[]}
        promptIndex={0}
        isLast
      />,
    );
    expect(screen.getByText('task_6_reviewer')).toBeDefined();
  });

  it('omits the thread label chip when thread_label is null', () => {
    render(
      <PromptBatchCard
        batch={makeBatch()}
        batchAttachments={[]}
        steeringChildren={[]}
        promptIndex={0}
        isLast
      />,
    );
    expect(screen.queryByText('task_6_reviewer')).toBeNull();
  });
});
