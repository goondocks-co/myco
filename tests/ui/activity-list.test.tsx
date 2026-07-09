// @vitest-environment jsdom
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ActivityRow } from '../../packages/myco/ui/src/hooks/use-sessions';

let activitiesFixture: ActivityRow[] = [];

mock.module('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useBatchActivities: (batchId: number | undefined) => ({
    data: batchId === undefined ? undefined : activitiesFixture,
    isLoading: false,
  }),
}));

import { ActivityList } from '../../packages/myco/ui/src/components/sessions/ActivityList';

function activity(overrides: Partial<ActivityRow>): ActivityRow {
  return {
    id: 1,
    session_id: 'sess-1',
    prompt_batch_id: 10,
    tool_name: 'Read',
    tool_input: null,
    tool_output_summary: null,
    file_path: null,
    files_affected: null,
    duration_ms: null,
    success: 1,
    error_message: null,
    timestamp: 100,
    processed: 1,
    content_hash: null,
    created_at: 100,
    canopy_injection_tokens: null,
    myco_tool: null,
    myco_op: null,
    ...overrides,
  };
}

describe('ActivityList', () => {
  it('renders myco injection rows with their friendly injection labels even without myco_tool', () => {
    activitiesFixture = [
      activity({
        id: 42,
        tool_name: 'myco:inject_cortex',
        tool_input: 'session-start',
        tool_output_summary: 'Cortex instructions',
      }),
    ];

    render(<ActivityList batchId={10} activityCount={1} />);
    fireEvent.click(screen.getByRole('button', { name: /tool calls/i }));

    expect(screen.getByText('Cortex')).toBeInTheDocument();
    expect(screen.getByText('injection')).toBeInTheDocument();
    expect(screen.queryByText('myco:inject_cortex')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cortex/i }));
    expect(screen.getByText('Injected content')).toBeInTheDocument();
    expect(screen.getByText('Cortex instructions')).toBeInTheDocument();
  });
});
