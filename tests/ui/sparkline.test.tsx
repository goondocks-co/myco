// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render } from '@testing-library/react';
import { Sparkline } from '../../packages/myco/ui/src/components/ui/sparkline';

describe('Sparkline', () => {
  it('renders an svg with width/height defaults', () => {
    const { container } = render(<Sparkline data={[1, 2, 3]} />);
    const svg = container.querySelector('svg');
    expect(svg).not.toBeNull();
    expect(svg?.getAttribute('width')).toBe('56');
    expect(svg?.getAttribute('height')).toBe('16');
  });

  it('renders one <rect> per data point', () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 4]} />);
    expect(container.querySelectorAll('rect').length).toBe(4);
  });

  it('scales bar heights to the max value', () => {
    const { container } = render(<Sparkline data={[1, 4]} heightPx={16} />);
    const rects = container.querySelectorAll('rect');
    expect(rects[0]?.getAttribute('height')).toBe('4');
    expect(rects[1]?.getAttribute('height')).toBe('16');
  });

  it('renders an empty svg for empty data', () => {
    const { container } = render(<Sparkline data={[]} />);
    expect(container.querySelector('svg')).not.toBeNull();
    expect(container.querySelectorAll('rect').length).toBe(0);
  });

  it('renders all-zero bars with zero height for all-zero data', () => {
    const { container } = render(<Sparkline data={[0, 0, 0]} />);
    const rects = container.querySelectorAll('rect');
    expect(rects.length).toBe(3);
    rects.forEach((r) => expect(r.getAttribute('height')).toBe('0'));
  });

  it('honors widthPx / heightPx overrides', () => {
    const { container } = render(<Sparkline data={[1]} widthPx={100} heightPx={24} />);
    const svg = container.querySelector('svg');
    expect(svg?.getAttribute('width')).toBe('100');
    expect(svg?.getAttribute('height')).toBe('24');
  });
});
