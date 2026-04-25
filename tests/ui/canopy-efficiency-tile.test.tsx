// @vitest-environment jsdom

import { render, screen } from '@testing-library/react';
import { describe, it, expect } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CanopyEfficiencyTile } from '../../packages/myco/ui/src/components/sessions/CanopyEfficiencyTile';
import type { SessionCanopyAggregate } from '../../packages/myco/ui/src/hooks/use-canopy';

/* ---------- Helpers ---------- */

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

function renderTile(fixture: SessionCanopyAggregate | null) {
  const client = makeQueryClient();
  return render(
    <QueryClientProvider client={client}>
      <CanopyEfficiencyTile sessionId="sess-1" fixture={fixture} />
    </QueryClientProvider>,
  );
}

const POPULATED: SessionCanopyAggregate = {
  canopy_injections_offered: 12,
  canopy_injection_total_tokens: 720,
  canopy_skips_after_injection: 8,
  canopy_reads_after_injection: 4,
  canopy_tokens_saved: 4_320,
  canopy_redundant_reads: 1,
};

const ALL_NULL: SessionCanopyAggregate = {
  canopy_injections_offered: null,
  canopy_injection_total_tokens: null,
  canopy_skips_after_injection: null,
  canopy_reads_after_injection: null,
  canopy_tokens_saved: null,
  canopy_redundant_reads: null,
};

const NEGATIVE: SessionCanopyAggregate = {
  canopy_injections_offered: 5,
  canopy_injection_total_tokens: 400,
  canopy_skips_after_injection: 0,
  canopy_reads_after_injection: 5,
  canopy_tokens_saved: -400,
  canopy_redundant_reads: 0,
};

/* ---------- Tests ---------- */

describe('CanopyEfficiencyTile', () => {
  it('renders the tile with populated data', () => {
    renderTile(POPULATED);

    expect(screen.getByTestId('canopy-efficiency-tile')).toBeInTheDocument();
    expect(screen.getByText(/token efficiency/i)).toBeInTheDocument();
    // Compact-formatted prominent number (4_320 → "4.3k").
    expect(screen.getByText(/4\.3k/)).toBeInTheDocument();
    expect(screen.getByText(/net tokens saved/i)).toBeInTheDocument();
    // Sub-stats render their values.
    expect(screen.getByText('12')).toBeInTheDocument(); // injections offered
    expect(screen.getByText('8')).toBeInTheDocument();  // skipped
    expect(screen.getByText('4')).toBeInTheDocument();  // read anyway
  });

  it('hides itself entirely when fixture is null', () => {
    const { container } = renderTile(null);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('canopy-efficiency-tile')).not.toBeInTheDocument();
  });

  it('hides itself entirely when every column is null', () => {
    const { container } = renderTile(ALL_NULL);
    expect(container.firstChild).toBeNull();
    expect(screen.queryByTestId('canopy-efficiency-tile')).not.toBeInTheDocument();
  });

  it('shows a negative net-spend when injection cost exceeds gain', () => {
    renderTile(NEGATIVE);

    expect(screen.getByTestId('canopy-efficiency-tile')).toBeInTheDocument();
    // -400 fits below the kilo threshold so it formats as a comma-grouped int.
    expect(screen.getByText(/-400/)).toBeInTheDocument();
    expect(screen.getByText(/net tokens spent/i)).toBeInTheDocument();
  });

  it('omits the redundant-reads row when count is zero', () => {
    renderTile({ ...POPULATED, canopy_redundant_reads: 0 });
    expect(screen.queryByText(/redundant reads/i)).not.toBeInTheDocument();
  });
});
