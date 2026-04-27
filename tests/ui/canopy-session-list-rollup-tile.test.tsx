// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CanopySessionListRollupTile } from '../../packages/myco/ui/src/components/sessions/CanopySessionListRollupTile';
import type { CanopyRollup } from '../../packages/myco/ui/src/hooks/use-canopy';

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderTile(fixture: CanopyRollup | null) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CanopySessionListRollupTile fixture={fixture} />
    </QueryClientProvider>,
  );
}

const POPULATED: CanopyRollup = {
  total_tokens_saved: 24_500,
  sessions_with_canopy: 17,
  avg_tokens_saved_per_session: 1_441,
  total_injections_offered: 60,
  total_skips_after_injection: 38,
  injection_effectiveness_ratio: 0.633,
};

const ALL_NULL: CanopyRollup = {
  total_tokens_saved: null,
  sessions_with_canopy: null,
  avg_tokens_saved_per_session: null,
  total_injections_offered: null,
  total_skips_after_injection: null,
  injection_effectiveness_ratio: null,
};

const ALL_ZERO: CanopyRollup = {
  total_tokens_saved: 0,
  sessions_with_canopy: 0,
  avg_tokens_saved_per_session: 0,
  total_injections_offered: 0,
  total_skips_after_injection: 0,
  injection_effectiveness_ratio: 0,
};

/* ---------- Tests ---------- */

describe('CanopySessionListRollupTile', () => {
  it('renders the rollup with populated data', () => {
    renderTile(POPULATED);

    expect(screen.getByTestId('canopy-rollup-tile')).toBeInTheDocument();
    expect(screen.getByText(/Canopy efficiency · lifetime/i)).toBeInTheDocument();
    // Compact-formatted values appear.
    expect(screen.getByText(/25k|24\.5k/)).toBeInTheDocument(); // total saved
    expect(screen.getByText(/63%/)).toBeInTheDocument(); // ratio
    expect(screen.getByText(/across 17 sessions/i)).toBeInTheDocument();
  });

  it('hides itself entirely when fixture is null', () => {
    const { container } = renderTile(null);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('canopy-rollup-tile')).not.toBeInTheDocument();
  });

  it('hides itself entirely when every column is null', () => {
    const { container } = renderTile(ALL_NULL);
    expect(container.firstChild).toBeNull();
  });

  it('hides itself entirely when the rollup endpoint returns an all-zero empty state', () => {
    const { container } = renderTile(ALL_ZERO);
    expect(container.firstChild).toBeNull();
  });

  it('renders em-dashes for partial-null payloads instead of falsy 0', () => {
    renderTile({
      ...POPULATED,
      avg_tokens_saved_per_session: null,
      injection_effectiveness_ratio: null,
    });
    // The "average per session" and "injection effectiveness" stats fall
    // back to em-dashes — better than rendering "0 tok" / "0%" which would
    // imply Canopy ran and produced no benefit.
    const dashes = screen.getAllByText(/—/);
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });
});
