// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { RefreshIndicator } from '../../packages/myco/ui/src/components/ui/refresh-indicator';

describe('RefreshIndicator', () => {
  it('shows the interval in seconds when idle', () => {
    render(
      <RefreshIndicator intervalMs={5_000} isFetching={false} onManualRefresh={() => {}} />,
    );
    expect(screen.getByText(/5s/)).toBeDefined();
  });

  it('shows a breathing dot while fetching', () => {
    render(
      <RefreshIndicator intervalMs={5_000} isFetching onManualRefresh={() => {}} />,
    );
    const dot = screen.getByTestId('refresh-indicator-dot');
    expect(dot.className).toMatch(/animate-pulse/);
  });

  it('invokes onManualRefresh when the button is clicked', () => {
    const handler = mock(() => {});
    render(
      <RefreshIndicator intervalMs={5_000} isFetching={false} onManualRefresh={handler} />,
    );
    screen.getByRole('button', { name: /refresh now/i }).click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('renders manual-only mode without cadence text when intervalMs is undefined', () => {
    render(
      <RefreshIndicator isFetching={false} onManualRefresh={() => {}} />,
    );
    expect(screen.queryByText(/s$/)).toBeNull();
  });
});
