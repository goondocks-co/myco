// @vitest-environment jsdom

import { describe, it, expect, mock } from 'bun:test';
import { fireEvent, render, screen } from '@testing-library/react';
import { FilterPill } from '../../packages/myco/ui/src/components/ui/filter-pill';

describe('FilterPill', () => {
  it('renders the trigger with default label', () => {
    render(<FilterPill activeCount={0}>options</FilterPill>);
    expect(screen.getByRole('button', { name: /filter/i })).toBeDefined();
  });

  it('hides popover content initially', () => {
    render(<FilterPill activeCount={0}><div>options</div></FilterPill>);
    expect(screen.queryByText('options')).toBeNull();
  });

  it('opens popover on click and shows children', () => {
    render(<FilterPill activeCount={0}><div>options</div></FilterPill>);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    expect(screen.getByText('options')).toBeDefined();
  });

  it('closes on Escape', () => {
    render(<FilterPill activeCount={0}><div>options</div></FilterPill>);
    fireEvent.click(screen.getByRole('button', { name: /filter/i }));
    expect(screen.getByText('options')).toBeDefined();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByText('options')).toBeNull();
  });

  it('shows active count badge when activeCount > 0', () => {
    render(<FilterPill activeCount={3}>options</FilterPill>);
    expect(screen.getByLabelText(/3 active filters/i)).toBeDefined();
  });

  it('hides active count badge at zero', () => {
    render(<FilterPill activeCount={0}>options</FilterPill>);
    expect(screen.queryByLabelText(/active filter/i)).toBeNull();
  });

  it('supports a custom label', () => {
    render(<FilterPill activeCount={0} label="Refine">options</FilterPill>);
    expect(screen.getByRole('button', { name: /refine/i })).toBeDefined();
  });
});
