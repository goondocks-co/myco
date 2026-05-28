// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../../../helpers/vi-shim.js';

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

mock.module('../../../../packages/myco/ui/src/hooks/use-grove-mutations', () => ({
  useDeleteProject: () => ({
    mutate: deleteMutate,
    isPending: false,
  }),
}));

import { DeleteProjectModal } from '../../../../packages/myco/ui/src/components/groves/DeleteProjectModal';

describe('DeleteProjectModal', () => {
  beforeEach(() => {
    deleteMutate.mockReset();
  });

  it('requires typing the project name before deleting', () => {
    render(
      <DeleteProjectModal
        open
        onOpenChange={() => {}}
        groveId="grove-1"
        projectId="proj-1"
        projectName="Temp Project"
      />,
    );

    const button = screen.getByRole('button', { name: 'Delete Permanently' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.change(screen.getByLabelText('Project name confirmation'), {
      target: { value: 'Temp Project' },
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(deleteMutate).toHaveBeenCalledTimes(1);
    expect(deleteMutate.mock.calls[0]![0]).toEqual({
      groveId: 'grove-1',
      projectId: 'proj-1',
      confirmationName: 'Temp Project',
    });
  });
});
