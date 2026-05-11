// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../../../helpers/vi-shim.js';

/* ---------- jsdom polyfills (Radix focus-scope needs these) ---------- */
class MutationObserverStub {
  observe(): void {}
  disconnect(): void {}
  takeRecords(): unknown[] { return []; }
}
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
const _g = globalThis as unknown as Record<string, unknown>;
if (typeof _g.MutationObserver === 'undefined') _g.MutationObserver = MutationObserverStub;
if (typeof _g.ResizeObserver === 'undefined') _g.ResizeObserver = ResizeObserverStub;
if (typeof _g.NodeFilter === 'undefined' && typeof document !== 'undefined') {
  const win = document.defaultView as unknown as Record<string, unknown> | null;
  if (win && win.NodeFilter) _g.NodeFilter = win.NodeFilter;
}

const createMutate = vi.fn();
const createReset = vi.fn();

mock.module('../../../../packages/myco/ui/src/hooks/use-grove-mutations', () => ({
  useCreateGrove: () => ({
    mutate: createMutate,
    reset: createReset,
    isPending: false,
  }),
}));

import { NewGroveModal } from '../../../../packages/myco/ui/src/components/groves/NewGroveModal';

describe('NewGroveModal', () => {
  beforeEach(() => {
    createMutate.mockReset();
    createReset.mockReset();
  });

  it('renders when open', () => {
    render(<NewGroveModal open onOpenChange={() => {}} />);
    expect(screen.getByText('New Grove')).toBeDefined();
    expect(screen.getByLabelText('Name')).toBeDefined();
  });

  it('shows inline form error when submitting empty name', () => {
    render(<NewGroveModal open onOpenChange={() => {}} />);
    const submit = screen.getByRole('button', { name: 'Create' });
    // Submit button is disabled when name is empty, so trigger form submit directly.
    const form = submit.closest('form')!;
    fireEvent.submit(form);
    expect(screen.getByText('Name is required.')).toBeDefined();
    expect(createMutate).not.toHaveBeenCalled();
  });

  it('calls mutate with trimmed name on submit', () => {
    render(<NewGroveModal open onOpenChange={() => {}} />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '  My Grove  ' } });
    const submit = screen.getByRole('button', { name: 'Create' });
    fireEvent.click(submit);
    expect(createMutate).toHaveBeenCalledTimes(1);
    expect(createMutate.mock.calls[0]![0]).toEqual({ name: 'My Grove' });
  });

  it('shows slug preview while typing', () => {
    render(<NewGroveModal open onOpenChange={() => {}} />);
    const input = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Hello World!' } });
    expect(screen.getByText('slug: hello-world')).toBeDefined();
  });
});
