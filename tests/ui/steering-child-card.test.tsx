// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { SteeringChildCard } from '../../packages/myco/ui/src/components/sessions/SteeringChildCard';
import type { BatchRow } from '../../packages/myco/ui/src/hooks/use-sessions';

function makeChild(overrides: Partial<BatchRow> = {}): BatchRow {
  return {
    id: 3,
    session_id: 'sess-test',
    prompt_number: 3,
    user_prompt: 'i can already see one issue',
    response_summary: null,
    classification: null,
    started_at: 1780326031,
    ended_at: 1780326527,
    status: 'completed',
    activity_count: 0, // 0 → ActivityList (which fetches) is not rendered
    processed: 1,
    content_hash: null,
    created_at: 1780326031,
    parent_prompt_batch_id: 2,
    kind: 'steering',
    origin: 'human',
    ...overrides,
  };
}

describe('SteeringChildCard', () => {
  it('renders the steering prompt', () => {
    render(<SteeringChildCard child={makeChild()} />);
    expect(screen.getByText('i can already see one issue')).toBeDefined();
  });

  it('renders the steering turn response when captured', () => {
    render(<SteeringChildCard child={makeChild({ response_summary: 'I can see it clearly in your screenshot' })} />);
    expect(screen.getByText('Response')).toBeDefined();
    expect(screen.getByText(/I can see it clearly in your screenshot/)).toBeDefined();
  });

  it('omits the Response block when the child has no response', () => {
    render(<SteeringChildCard child={makeChild({ response_summary: null })} />);
    expect(screen.queryByText('Response')).toBeNull();
  });
});
