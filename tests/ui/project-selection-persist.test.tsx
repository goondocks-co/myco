// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'bun:test';
import { render, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectSelectionBoundary } from '../../packages/myco/ui/src/hooks/use-project-selection';
import { readLastSelection, type ProjectSelection } from '../../packages/myco/ui/src/lib/selection';

const sel: ProjectSelection = {
  grove: { id: 'grove-a', name: 'Default', slug: 'default', mode: 'local', is_default: true,
    created_at: '2026-01-01T00:00:00.000Z', project_count: 1, projects: [] },
  project: { project_id: 'p-bound', name: 'Bound', slug: 'bound-1', root: '/tmp/bound',
    binding_id: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
    manifest_state: 'present' },
};

function wrap(persist: boolean) {
  const qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <ProjectSelectionBoundary selection={sel} persist={persist}><div>child</div></ProjectSelectionBoundary>
    </QueryClientProvider>,
  );
}

describe('ProjectSelectionBoundary persistence', () => {
  afterEach(() => { cleanup(); window.localStorage.clear(); });

  it('persists the selection when persist is true', async () => {
    window.localStorage.setItem('myco.lastSelectedProject',
      JSON.stringify({ groveId: 'grove-x', projectId: 'p-prev' }));
    wrap(true);
    await waitFor(() => expect(readLastSelection()?.projectId).toBe('p-bound'));
  });

  it('does NOT overwrite the stored selection when persist is false', async () => {
    window.localStorage.setItem('myco.lastSelectedProject',
      JSON.stringify({ groveId: 'grove-x', projectId: 'p-prev' }));
    wrap(false);
    await waitFor(() => expect(document.body.textContent).toContain('child'));
    expect(readLastSelection()?.projectId).toBe('p-prev');
  });
});
