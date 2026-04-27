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
  canopy_map_tool_calls: 3,
};

const ALL_NULL: SessionCanopyAggregate = {
  canopy_injections_offered: null,
  canopy_injection_total_tokens: null,
  canopy_skips_after_injection: null,
  canopy_reads_after_injection: null,
  canopy_tokens_saved: null,
  canopy_redundant_reads: null,
  canopy_map_tool_calls: 0,
};

const NEGATIVE: SessionCanopyAggregate = {
  canopy_injections_offered: 5,
  canopy_injection_total_tokens: 400,
  canopy_skips_after_injection: 0,
  canopy_reads_after_injection: 5,
  canopy_tokens_saved: -400,
  canopy_redundant_reads: 0,
  canopy_map_tool_calls: 0,
};

/* ---------- Tests ---------- */

describe('CanopyEfficiencyTile', () => {
  it('renders the compact card with the headline number and skip ratio', () => {
    renderTile(POPULATED);

    const tile = screen.getByTestId('canopy-efficiency-tile');
    expect(tile).toBeInTheDocument();
    expect(tile.textContent).toContain('Reads saved');
    // Compact-formatted prominent number (4_320 → "4.3k").
    expect(tile.textContent).toContain('4.3k');
    // Skip ratio sublabel ("8/12 skipped").
    expect(tile.textContent).toContain('8/12 skipped');
  });

  it('renders with zeros when fixture is null (pre-feature session)', () => {
    renderTile(null);

    const tile = screen.getByTestId('canopy-efficiency-tile');
    expect(tile).toBeInTheDocument();
    expect(tile.textContent).toContain('Reads saved');
    expect(tile.textContent).toContain('0');
  });

  it('renders with zeros when every column is null (non-Claude / disabled scope)', () => {
    renderTile(ALL_NULL);

    const tile = screen.getByTestId('canopy-efficiency-tile');
    expect(tile).toBeInTheDocument();
    expect(tile.textContent).toContain('Reads saved');
    expect(tile.textContent).toContain('0');
  });

  it('shows a negative net-spend when injection cost exceeds gain', () => {
    renderTile(NEGATIVE);

    const tile = screen.getByTestId('canopy-efficiency-tile');
    expect(tile).toBeInTheDocument();
    // -400 fits below the kilo threshold so it formats as a comma-grouped int.
    expect(tile.textContent).toContain('-400');
  });

  it('renders "Map calls: N" as a separate secondary metric when count is positive', () => {
    renderTile(POPULATED);

    const mapCalls = screen.getByTestId('canopy-map-calls');
    expect(mapCalls).toBeInTheDocument();
    expect(mapCalls.textContent).toBe('Map calls: 3');

    // Sanity-check that map calls is NOT folded into tokens saved — the
    // headline number must still be the unmodified tokens-saved value.
    const tile = screen.getByTestId('canopy-efficiency-tile');
    expect(tile.textContent).toContain('4.3k');
  });

  it('renders "Map calls: 0" when no map calls have been made', () => {
    // Matches the tile's existing zero-rendering behavior for tokens saved:
    // zeros are kept visible rather than hidden, since the tile is small
    // enough to tolerate them and they set the stage for the metric.
    renderTile(ALL_NULL);

    const mapCalls = screen.getByTestId('canopy-map-calls');
    expect(mapCalls).toBeInTheDocument();
    expect(mapCalls.textContent).toBe('Map calls: 0');
  });

  it('renders "Map calls: 0" for the null-fixture (pre-feature) path', () => {
    renderTile(null);

    const mapCalls = screen.getByTestId('canopy-map-calls');
    expect(mapCalls).toBeInTheDocument();
    expect(mapCalls.textContent).toBe('Map calls: 0');
  });

  it('exposes the headline savings via aria-label for assistive tech', () => {
    // Modal content (sub-stats + scope disclaimer) lives behind a click,
    // and the test runner's jsdom doesn't fully support Radix's portal
    // mounting (no MutationObserver). The aria-label is the always-visible
    // accessibility surface that mirrors the prominent number, so we
    // verify the data threading there instead of opening the dialog.
    renderTile(POPULATED);
    const tile = screen.getByTestId('canopy-efficiency-tile');
    expect(tile.getAttribute('aria-label')).toContain('4.3k');
    expect(tile.getAttribute('aria-label')).toMatch(/saved by canopy/i);
  });
});
