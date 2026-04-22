// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionPlans } from '../../packages/myco/ui/src/components/sessions/SessionPlans';

const useSessionPlansMock = vi.fn();
const mutateAsyncMock = vi.fn();
const useDeletePlanMock = vi.fn();

vi.mock('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useSessionPlans: (...args: unknown[]) => useSessionPlansMock(...args),
  useDeletePlan: (...args: unknown[]) => useDeletePlanMock(...args),
}));

// Radix Dialog pulls React from the UI package's nested node_modules, which
// conflicts with the root React instance under vitest. Replace ConfirmDialog
// with a minimal shim that surfaces its props through the DOM.
vi.mock('../../packages/myco/ui/src/components/ui/confirm-dialog', () => ({
  ConfirmDialog: ({
    open,
    title,
    confirmLabel,
    onConfirm,
    onOpenChange,
  }: {
    open: boolean;
    title: string;
    confirmLabel?: string;
    onConfirm: () => void;
    onOpenChange: (open: boolean) => void;
  }) => {
    if (!open) return null;
    return (
      <div role="dialog" aria-label={title}>
        <button onClick={onConfirm}>{confirmLabel ?? 'Confirm'}</button>
        <button onClick={() => onOpenChange(false)}>Cancel</button>
      </div>
    );
  },
}));

describe('SessionPlans', () => {
  beforeEach(() => {
    mutateAsyncMock.mockReset();
    useSessionPlansMock.mockReset();
    useDeletePlanMock.mockReset();
    useSessionPlansMock.mockReturnValue({
      data: [{
        id: 'plan-1',
        status: 'active',
        title: 'Primary Plan',
        content: '# Primary Plan\n\nDetails',
        source_path: 'docs/plans/primary.md',
        content_hash: 'hash-1',
        session_id: 'sess-1',
        created_at: 1700000000,
        updated_at: 1700000000,
      }],
      isLoading: false,
      isError: false,
    });
    useDeletePlanMock.mockReturnValue({
      mutateAsync: mutateAsyncMock,
      isError: false,
      isPending: false,
    });
    mutateAsyncMock.mockResolvedValue({ ok: true });
  });

  it('renders captured plans', () => {
    render(<SessionPlans sessionId="sess-1" />);
    expect(screen.getByText('Primary Plan')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete plan' })).toBeInTheDocument();
  });

  it('opens a confirmation dialog before deleting', () => {
    render(<SessionPlans sessionId="sess-1" />);

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete plan' }));

    expect(screen.getByRole('dialog', { name: 'Delete Plan' })).toBeInTheDocument();
    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('deletes the plan after confirmation', async () => {
    render(<SessionPlans sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Plan' }));

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith('plan-1');
    });
  });

  it('does not delete when the dialog is cancelled', () => {
    render(<SessionPlans sessionId="sess-1" />);

    fireEvent.click(screen.getByRole('button', { name: 'Delete plan' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(mutateAsyncMock).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('expands and collapses the plan when the header is clicked', () => {
    render(<SessionPlans sessionId="sess-1" />);

    const header = screen.getByRole('button', { name: /Primary Plan/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(header);
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not toggle expansion when the delete button is clicked', () => {
    render(<SessionPlans sessionId="sess-1" />);

    const header = screen.getByRole('button', { name: /Primary Plan/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(screen.getByRole('button', { name: 'Delete plan' }));
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('renders a delete error banner', () => {
    useDeletePlanMock.mockReturnValue({
      mutateAsync: mutateAsyncMock,
      isError: true,
      isPending: false,
    });

    render(<SessionPlans sessionId="sess-1" />);

    expect(screen.getByText('Failed to delete plan.')).toBeInTheDocument();
  });
});
