// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../../../helpers/vi-shim.js';

/* ---------- jsdom polyfills ---------- */
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

const deleteMutate = vi.fn();
const deleteReset = vi.fn();

mock.module('../../../../packages/myco/ui/src/hooks/use-grove-mutations', () => ({
  useDeleteGrove: () => ({
    mutate: deleteMutate,
    reset: deleteReset,
    isPending: false,
  }),
}));

import { DeleteGroveModal } from '../../../../packages/myco/ui/src/components/groves/DeleteGroveModal';

describe('DeleteGroveModal', () => {
  beforeEach(() => {
    deleteMutate.mockReset();
    deleteReset.mockReset();
  });

  it('disables confirm when projectCount > 0', () => {
    render(
      <DeleteGroveModal
        open
        onOpenChange={() => {}}
        groveId="g-1"
        groveName="Personal"
        projectCount={2}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Delete Grove' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    expect(screen.getByText(/Move or remove/i)).toBeDefined();
  });

  it('calls mutate when projectCount = 0 and confirm clicked', () => {
    render(
      <DeleteGroveModal
        open
        onOpenChange={() => {}}
        groveId="g-1"
        groveName="Personal"
        projectCount={0}
      />,
    );
    const btn = screen.getByRole('button', { name: 'Delete Grove' }) as HTMLButtonElement;
    expect(btn.disabled).toBe(false);
    fireEvent.click(btn);
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0]![0]).toEqual({ id: 'g-1' });
  });
});
