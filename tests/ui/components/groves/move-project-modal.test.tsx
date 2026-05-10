// @vitest-environment jsdom

import { render, screen, fireEvent } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../../../helpers/vi-shim.js';
import type { GroveSummary } from '../../../../packages/myco/ui/src/lib/selection';

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

const moveMutate = vi.fn();
const moveReset = vi.fn();

mock.module('../../../../packages/myco/ui/src/hooks/use-grove-mutations', () => ({
  useMoveProject: () => ({
    mutate: moveMutate,
    reset: moveReset,
    isPending: false,
  }),
}));

import { MoveProjectModal } from '../../../../packages/myco/ui/src/components/groves/MoveProjectModal';

const SOURCE: GroveSummary = {
  id: 'src-id',
  name: 'Source',
  slug: 'source',
  mode: 'local',
  is_default: false,
  created_at: '',
  project_count: 1,
  projects: [],
};

const TARGET: GroveSummary = {
  id: 'tgt-id',
  name: 'Target',
  slug: 'target',
  mode: 'local',
  is_default: false,
  created_at: '',
  project_count: 0,
  projects: [],
};

describe('MoveProjectModal', () => {
  beforeEach(() => {
    moveMutate.mockReset();
    moveReset.mockReset();
  });

  it('renders grove picker excluding source', () => {
    render(
      <MoveProjectModal
        open
        onOpenChange={() => {}}
        sourceGroveId={SOURCE.id}
        projectId="proj-1"
        projectName="My Project"
        groves={[SOURCE, TARGET]}
      />,
    );
    const select = screen.getByLabelText('Destination Grove') as HTMLSelectElement;
    const optionValues = Array.from(select.options).map((o) => o.value);
    expect(optionValues).toEqual(['tgt-id']);
    expect(optionValues).not.toContain('src-id');
  });

  it('shows empty state when no other groves exist', () => {
    render(
      <MoveProjectModal
        open
        onOpenChange={() => {}}
        sourceGroveId={SOURCE.id}
        projectId="proj-1"
        projectName="My Project"
        groves={[SOURCE]}
      />,
    );
    expect(screen.getByText(/No other Groves available/i)).toBeDefined();
  });

  it('calls mutate with target on confirm', () => {
    render(
      <MoveProjectModal
        open
        onOpenChange={() => {}}
        sourceGroveId={SOURCE.id}
        projectId="proj-1"
        projectName="My Project"
        groves={[SOURCE, TARGET]}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Confirm move/i }));
    expect(moveMutate).toHaveBeenCalledTimes(1);
    expect(moveMutate.mock.calls[0]![0]).toEqual({
      targetGroveId: 'tgt-id',
      projectId: 'proj-1',
    });
  });
});
