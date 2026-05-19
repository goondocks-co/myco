// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { MetricCard } from '../../packages/myco/ui/src/components/ui/metric-card';

describe('MetricCard', () => {
  it('renders label + value', () => {
    render(<MetricCard label="Sessions" value="412" />);
    expect(screen.getByText('Sessions')).toBeDefined();
    expect(screen.getByText('412')).toBeDefined();
  });

  it('paints accent-toned top border when tone is set', () => {
    const { container, rerender } = render(<MetricCard label="x" value="1" tone="sage" />);
    expect((container.firstChild as HTMLElement).className).toContain('border-t-sage');
    rerender(<MetricCard label="x" value="1" tone="ochre" />);
    expect((container.firstChild as HTMLElement).className).toContain('border-t-ochre');
    rerender(<MetricCard label="x" value="1" tone="terra" />);
    expect((container.firstChild as HTMLElement).className).toContain('border-t-terracotta');
  });

  it('renders sub line when provided', () => {
    render(<MetricCard label="Canopy" value="510/540" sub="described" />);
    expect(screen.getByText('described')).toBeDefined();
  });

  it('renders sparkline when sparklineData has ≥2 points', () => {
    const { container } = render(
      <MetricCard label="Embed queue" value="12" sparklineData={[1, 2, 3, 4]} />,
    );
    // Sparkline renders an <svg>; verify presence.
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('does not render sparkline when sparklineData has <2 points', () => {
    const { container } = render(
      <MetricCard label="Embed queue" value="12" sparklineData={[1]} />,
    );
    expect(container.querySelector('svg')).toBeNull();
  });
});
