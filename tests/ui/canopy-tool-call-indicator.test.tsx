// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CanopyToolCallIndicator } from '../../packages/myco/ui/src/components/sessions/CanopyToolCallIndicator';
import type { ActivityRow } from '../../packages/myco/ui/src/hooks/use-sessions';

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderIndicator(activity: ActivityRow) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CanopyToolCallIndicator sessionId="sess-1" activity={activity} />
    </QueryClientProvider>,
  );
}

const baseActivity: ActivityRow = {
  id: 42,
  session_id: 'sess-1',
  prompt_batch_id: 1,
  tool_name: 'Read',
  tool_input: '{"path":"src/foo.ts"}',
  tool_output_summary: null,
  file_path: 'src/foo.ts',
  files_affected: null,
  duration_ms: 12,
  success: 1,
  error_message: null,
  timestamp: 100,
  processed: 1,
  content_hash: null,
  created_at: 100,
};

/* ---------- Tests ---------- */

describe('CanopyToolCallIndicator', () => {
  it('renders the badge for a Read tool with non-null injection tokens', () => {
    renderIndicator({ ...baseActivity, canopy_injection_tokens: 60 });

    const badge = screen.getByTestId('canopy-tool-call-indicator');
    expect(badge).toBeInTheDocument();
    expect(badge.textContent).toContain('60');
    expect(badge.textContent).toContain('tok');
  });

  it('renders nothing when canopy_injection_tokens is null', () => {
    const { container } = renderIndicator({ ...baseActivity, canopy_injection_tokens: null });
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('canopy-tool-call-indicator')).not.toBeInTheDocument();
  });

  it('renders nothing for a non-Read tool even when injection tokens are populated', () => {
    // Defensive: the column should always be NULL for non-Read tools, but
    // the component must guard regardless so a stale row never produces a
    // misleading indicator on the wrong tool.
    const { container } = renderIndicator({
      ...baseActivity,
      tool_name: 'Bash',
      canopy_injection_tokens: 60,
    });
    expect(container.firstChild).toBeNull();
  });

  it('lower-cases read alias also qualifies', () => {
    renderIndicator({ ...baseActivity, tool_name: 'read', canopy_injection_tokens: 75 });
    expect(screen.getByTestId('canopy-tool-call-indicator')).toBeInTheDocument();
  });
});
