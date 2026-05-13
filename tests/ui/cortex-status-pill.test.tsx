// @vitest-environment jsdom

import { describe, it, expect } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { CortexStatusPillView, computeIndexingPct } from '../../packages/myco/ui/src/components/ui/cortex-status-pill';

describe('computeIndexingPct', () => {
  it('returns 100 when fully described', () => {
    expect(computeIndexingPct(50, 50)).toBe(100);
  });
  it('returns 0 when entries_count is 0', () => {
    expect(computeIndexingPct(0, 0)).toBe(0);
  });
  it('returns floor of ratio * 100', () => {
    expect(computeIndexingPct(74, 100)).toBe(74);
    expect(computeIndexingPct(33, 100)).toBe(33);
    expect(computeIndexingPct(1, 3)).toBe(33);
  });
});

describe('CortexStatusPillView', () => {
  it('renders sage dot at 100% (idle)', () => {
    render(<CortexStatusPillView describedCount={10} entriesCount={10} />);
    expect(screen.getByTestId('status-dot').dataset.tone).toBe('sage');
    expect(screen.getByText('100%')).toBeDefined();
  });

  it('renders ochre pulsing dot when indexing', () => {
    render(<CortexStatusPillView describedCount={5} entriesCount={10} />);
    expect(screen.getByTestId('status-dot').dataset.tone).toBe('ochre');
    expect(screen.getByTestId('status-dot').dataset.pulsing).toBe('true');
    expect(screen.getByText('50%')).toBeDefined();
  });

  it('renders em-dash when data is missing', () => {
    render(<CortexStatusPillView describedCount={undefined} entriesCount={undefined} />);
    expect(screen.getByText('—')).toBeDefined();
  });
});
