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
    });
    mutateAsyncMock.mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  it('renders captured plans', () => {
    render(<SessionPlans sessionId="sess-1" />);
    expect(screen.getByText('Primary Plan')).toBeInTheDocument();
    expect(screen.getByText('Delete')).toBeInTheDocument();
  });

  it('deletes a plan after confirmation', async () => {
    render(<SessionPlans sessionId="sess-1" />);

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(mutateAsyncMock).toHaveBeenCalledWith('plan-1');
    });
  });

  it('does not delete when confirmation is canceled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<SessionPlans sessionId="sess-1" />);

    fireEvent.click(screen.getByText('Delete'));

    expect(mutateAsyncMock).not.toHaveBeenCalled();
  });

  it('renders a delete error banner', () => {
    useDeletePlanMock.mockReturnValue({
      mutateAsync: mutateAsyncMock,
      isError: true,
    });

    render(<SessionPlans sessionId="sess-1" />);

    expect(screen.getByText('Failed to delete plan.')).toBeInTheDocument();
  });
});
