// @vitest-environment jsdom
/**
 * RC-10 regression — project-scoped query keys must stay visible to
 * namespace-shaped invalidation.
 *
 * TanStack's partial key matching is positional: `invalidateQueries({
 * queryKey: ['ns', id] })` only matches cached keys whose leading elements
 * are `'ns', id`. The old scoped-key shape inserted the
 * `{ projectSelection }` marker at INDEX 1, so every `['ns', id]`-shaped
 * invalidation in the app silently no-oped (resumed runs stayed "failed",
 * task-config forms re-seeded stale values, etc). The marker now goes at
 * the END of the key; these tests pin that contract against a real
 * QueryClient so the bug class can't come back.
 */

import { afterEach, describe, expect, it } from 'bun:test';
import { renderHook, act } from '@testing-library/react';
import { createElement, type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { vi } from '../helpers/vi-shim.js';
import type { ProjectSelection } from '../../packages/myco/ui/src/lib/selection';
import { projectScopedQueryKey } from '../../packages/myco/ui/src/hooks/use-project-selection';
import { useResumeRun } from '../../packages/myco/ui/src/hooks/use-agent';

const selection: ProjectSelection = {
  grove: {
    id: 'grove-a',
    name: 'Work',
    slug: 'work',
    mode: 'local',
    is_default: true,
    created_at: '2026-01-01T00:00:00.000Z',
    project_count: 1,
    projects: [],
  },
  project: {
    project_id: 'project-a',
    name: 'Project A',
    slug: 'project-a-123abc',
    root: '/tmp/project-a',
    binding_id: 'gbind-a',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    manifest_state: 'present',
  },
};

describe('projectScopedQueryKey invalidation visibility (RC-10)', () => {
  it('keeps the namespace at index 0 so the selection-boundary predicate still works', () => {
    const key = projectScopedQueryKey(selection, ['agent-run', 'run-1']);
    expect(key[0]).toBe('agent-run');
  });

  it("['ns', id]-shaped invalidation marks the scoped query stale", async () => {
    const qc = new QueryClient();
    const scopedKey = projectScopedQueryKey(selection, ['agent-run', 'run-1']);
    qc.setQueryData(scopedKey, { run: { id: 'run-1', status: 'failed' } });

    await qc.invalidateQueries({ queryKey: ['agent-run', 'run-1'] });

    const query = qc.getQueryCache().find({ queryKey: scopedKey, exact: true });
    expect(query).toBeDefined();
    expect(query!.state.isInvalidated).toBe(true);
  });

  it("['ns']-shaped invalidation matches scoped keys with trailing params", async () => {
    const qc = new QueryClient();
    const scopedKey = projectScopedQueryKey(selection, [
      'task-config',
      'skill-survey',
    ]);
    qc.setQueryData(scopedKey, { provider: 'ollama' });

    await qc.invalidateQueries({ queryKey: ['task-config', 'skill-survey'] });

    const query = qc.getQueryCache().find({ queryKey: scopedKey, exact: true });
    expect(query!.state.isInvalidated).toBe(true);
  });

  it('different selections keep distinct cache entries for the same logical key', () => {
    const otherSelection: ProjectSelection = {
      ...selection,
      project: { ...selection.project, project_id: 'project-b' },
    };
    const keyA = projectScopedQueryKey(selection, ['sessions']);
    const keyB = projectScopedQueryKey(otherSelection, ['sessions']);
    expect(JSON.stringify(keyA)).not.toBe(JSON.stringify(keyB));
  });
});

describe('useResumeRun optimistic restart (RC-10)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("flips the cached run detail to 'running' so terminal-status polling restarts", async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(Response.json({ ok: true, message: 'resumed' }))));

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    // No ProjectSelectionBoundary in the tree → selection is null → the hook
    // reads/writes the unscoped key, matching how useAgentRun keys outside a
    // project route.
    qc.setQueryData(['agent-run', 'run-1'], { run: { id: 'run-1', status: 'failed' } });

    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(QueryClientProvider, { client: qc }, children);
    const { result } = renderHook(() => useResumeRun(), { wrapper });

    await act(async () => {
      await result.current.mutateAsync({ runId: 'run-1' });
    });

    const detail = qc.getQueryData<{ run: { status: string } }>(['agent-run', 'run-1']);
    expect(detail?.run.status).toBe('running');
  });
});
