// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { SessionPlans } from '../../packages/myco/ui/src/components/sessions/SessionPlans';

const useSessionPlansMock = vi.fn();
const mutateAsyncMock = vi.fn();
const updateStatusMock = vi.fn();
const useDeletePlanMock = vi.fn();
const useUpdatePlanStatusMock = vi.fn();

mock.module('../../packages/myco/ui/src/hooks/use-sessions', () => ({
  useSessionPlans: (...args: unknown[]) => useSessionPlansMock(...args),
  useDeletePlan: (...args: unknown[]) => useDeletePlanMock(...args),
  useUpdatePlanStatus: (...args: unknown[]) => useUpdatePlanStatusMock(...args),
}));

mock.module('../../packages/myco/ui/src/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    disabled,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    disabled?: boolean;
    children: React.ReactNode;
  }) => (
    <select
      aria-label="Plan status"
      value={value}
      disabled={disabled}
      onClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => event.stopPropagation()}
      onChange={(event) => onValueChange(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  ),
}));

// Radix Dialog pulls React from the UI package's nested node_modules, which
// conflicts with the root React instance under vitest. Replace ConfirmDialog
// with a minimal shim that surfaces its props through the DOM.
mock.module('../../packages/myco/ui/src/components/ui/confirm-dialog', () => ({
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
    updateStatusMock.mockReset();
    useSessionPlansMock.mockReset();
    useDeletePlanMock.mockReset();
    useUpdatePlanStatusMock.mockReset();
    useSessionPlansMock.mockReturnValue({
      data: [{
        id: 'plan-1234567890abcdef',
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
    useUpdatePlanStatusMock.mockReturnValue({
      mutateAsync: updateStatusMock,
      isError: false,
      isPending: false,
    });
    mutateAsyncMock.mockResolvedValue({ ok: true });
    updateStatusMock.mockResolvedValue({ ok: true });
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
      expect(mutateAsyncMock).toHaveBeenCalledWith('plan-1234567890abcdef');
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

  it('shows the full plan ID and copy button does not toggle expansion', async () => {
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.resolve()) },
    });
    render(<SessionPlans sessionId="sess-1" />);

    const header = screen.getByRole('button', { name: /Primary Plan/ });
    expect(screen.getByText('plan-1234567890abcdef')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Copy plan ID/ }));

    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('plan-1234567890abcdef');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copy plan ID/ })).toHaveTextContent('Copied');
    });
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('status select updates status without toggling expansion', async () => {
    render(<SessionPlans sessionId="sess-1" />);

    const header = screen.getByRole('button', { name: /Primary Plan/ });
    expect(header).toHaveAttribute('aria-expanded', 'false');

    fireEvent.change(screen.getByRole('combobox', { name: 'Plan status' }), {
      target: { value: 'in_progress' },
    });

    await waitFor(() => {
      expect(updateStatusMock).toHaveBeenCalledWith({
        planId: 'plan-1234567890abcdef',
        status: 'in_progress',
      });
    });
    expect(header).toHaveAttribute('aria-expanded', 'false');
  });

  it('disables status select while update is pending', async () => {
    updateStatusMock.mockReturnValue(new Promise(() => {}));

    render(<SessionPlans sessionId="sess-1" />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Plan status' }), {
      target: { value: 'completed' },
    });

    await waitFor(() => {
      expect(screen.getByRole('combobox', { name: 'Plan status' })).toBeDisabled();
    });
  });

  it('renders status update errors, including remote-owned failures', async () => {
    updateStatusMock.mockRejectedValue({
      status: 403,
      body: {
        error: {
          code: 'cross-machine-plan-status',
          message: 'Plan belongs to another machine.',
        },
      },
    });

    render(<SessionPlans sessionId="sess-1" />);

    fireEvent.change(screen.getByRole('combobox', { name: 'Plan status' }), {
      target: { value: 'completed' },
    });

    await waitFor(() => {
      expect(screen.getByText(/Plan belongs to another machine/)).toBeInTheDocument();
    });
  });

  it('scopes remote-owned read-only state to the failed plan', async () => {
    useSessionPlansMock.mockReturnValue({
      data: [
        {
          id: 'remote-plan',
          status: 'active',
          title: 'Remote Plan',
          content: '# Remote Plan body',
          source_path: null,
          content_hash: 'hash-remote',
          session_id: 'sess-1',
          created_at: 1700000000,
          updated_at: 1700000000,
        },
        {
          id: 'local-plan',
          status: 'active',
          title: 'Local Plan',
          content: '# Local Plan body',
          source_path: null,
          content_hash: 'hash-local',
          session_id: 'sess-1',
          created_at: 1700000001,
          updated_at: 1700000001,
        },
      ],
      isLoading: false,
      isError: false,
    });
    updateStatusMock
      .mockRejectedValueOnce({
        status: 403,
        body: {
          error: {
            code: 'cross-machine-plan-status',
            message: 'Plan belongs to another machine.',
          },
        },
      })
      .mockResolvedValueOnce({ ok: true });

    render(<SessionPlans sessionId="sess-1" />);
    const statusSelects = screen.getAllByRole('combobox', { name: 'Plan status' });

    fireEvent.change(statusSelects[0], { target: { value: 'completed' } });

    await waitFor(() => {
      expect(screen.getByText(/Plan belongs to another machine/)).toBeInTheDocument();
      expect(statusSelects[0]).toBeDisabled();
    });
    expect(statusSelects[1]).not.toBeDisabled();

    fireEvent.change(statusSelects[1], { target: { value: 'in_progress' } });

    await waitFor(() => {
      expect(updateStatusMock).toHaveBeenLastCalledWith({
        planId: 'local-plan',
        status: 'in_progress',
      });
    });
  });

  it('renders in-progress plan expanded by default and others collapsed', () => {
    useSessionPlansMock.mockReturnValue({
      data: [
        {
          id: 'p1',
          status: 'completed',
          title: 'Completed Plan',
          content: '# Completed Plan body',
          source_path: null,
          content_hash: 'hash-p1',
          session_id: 'sess-1',
          created_at: 1700000000,
          updated_at: 1700000000,
        },
        {
          id: 'p2',
          status: 'in_progress',
          title: 'In Progress Plan',
          content: '# In Progress Plan body',
          source_path: null,
          content_hash: 'hash-p2',
          session_id: 'sess-1',
          created_at: 1700000100,
          updated_at: 1700000100,
        },
        {
          id: 'p3',
          status: 'active',
          title: 'Active Plan',
          content: '# Active Plan body',
          source_path: null,
          content_hash: 'hash-p3',
          session_id: 'sess-1',
          created_at: 1700000200,
          updated_at: 1700000200,
        },
      ],
      isLoading: false,
      isError: false,
    });

    render(<SessionPlans sessionId="sess-1" />);

    // in_progress card renders its body content (expanded)
    expect(screen.getByText('In Progress Plan body')).toBeInTheDocument();
    // completed and active cards do not render body content (collapsed)
    expect(screen.queryByText('Completed Plan body')).not.toBeInTheDocument();
    expect(screen.queryByText('Active Plan body')).not.toBeInTheDocument();
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
