// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { render, screen } from '@testing-library/react';
import { CompareBar } from '../../packages/myco/ui/src/components/ui/compare-bar';

describe('CompareBar', () => {
  it('renders count and primary label', () => {
    render(<CompareBar selectedCount={3} onClear={() => {}} onCompare={() => {}} />);
    expect(screen.getByText(/3 selected/i)).toBeDefined();
    expect(screen.getByRole('button', { name: /compare 3 runs/i })).toBeDefined();
  });

  it('singular noun when count is 1', () => {
    render(<CompareBar selectedCount={1} onClear={() => {}} onCompare={() => {}} />);
    expect(screen.getByRole('button', { name: /compare 1 run$/i })).toBeDefined();
  });

  it('disables Compare when count < minSelected (default 2)', () => {
    render(<CompareBar selectedCount={1} onClear={() => {}} onCompare={() => {}} />);
    const btn = screen.getByRole('button', { name: /compare/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables Compare when count >= minSelected', () => {
    render(<CompareBar selectedCount={2} onClear={() => {}} onCompare={() => {}} />);
    const btn = screen.getByRole('button', { name: /compare/i });
    expect((btn as HTMLButtonElement).disabled).toBe(false);
  });

  it('fires callbacks on click', () => {
    const onClear = mock(() => {});
    const onCompare = mock(() => {});
    render(<CompareBar selectedCount={3} onClear={onClear} onCompare={onCompare} />);
    screen.getByRole('button', { name: /compare/i }).click();
    screen.getByRole('button', { name: /clear selection/i }).click();
    expect(onCompare).toHaveBeenCalledTimes(1);
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('uses custom primaryLabel + noun pluralization', () => {
    render(
      <CompareBar
        selectedCount={2}
        onClear={() => {}}
        onCompare={() => {}}
        primaryLabel="Diff"
        nounSingular="session"
        nounPlural="sessions"
      />,
    );
    expect(screen.getByRole('button', { name: /diff 2 sessions/i })).toBeDefined();
  });
});
