// @vitest-environment jsdom

import { afterEach, describe, expect, it } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { fetchJson } from '../../packages/myco/ui/src/lib/api';
import { setCurrentRequestSelection, type ProjectSelection } from '../../packages/myco/ui/src/lib/selection';
import { projectScopedQueryKey } from '../../packages/myco/ui/src/hooks/use-project-selection';

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

describe('UI API request context', () => {
  afterEach(() => {
    setCurrentRequestSelection(null);
    vi.unstubAllGlobals();
  });

  it('injects selected Grove and project headers for project-scoped API calls', async () => {
    setCurrentRequestSelection(selection);
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ ok: true })));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson('/stats');

    const headers = fetchMock.mock.calls[0][1].headers as Headers;
    expect(headers.get('x-myco-grove-id')).toBe('grove-a');
    expect(headers.get('x-myco-project-id')).toBe('project-a');
  });

  it('skips request context headers for Grove discovery', async () => {
    setCurrentRequestSelection(selection);
    const fetchMock = vi.fn(() => Promise.resolve(Response.json({ groves: [] })));
    vi.stubGlobal('fetch', fetchMock);

    await fetchJson('/groves');

    const headers = fetchMock.mock.calls[0][1].headers as Headers | undefined;
    expect(headers?.get('x-myco-grove-id')).toBeNull();
    expect(headers?.get('x-myco-project-id')).toBeNull();
    expect(headers?.get('x-myco-auth')).toBeNull();
    // The activity header is deliberately NOT context-scoped. `/logs/stream`
    // is a context-free path and also the live log poller — the query most
    // likely to be left running unattended. Omitting the header there would
    // make it unclassified, unclassified counts as interaction, and the Logs
    // page alone would hold the daemon awake indefinitely.
    expect(headers?.get('x-myco-client-activity')).toBe('active');
  });

  it('appends project identity to query keys so positional prefix invalidation still matches', () => {
    expect(projectScopedQueryKey(selection, ['sessions', { status: 'active' }])).toEqual([
      'sessions',
      { status: 'active' },
      { projectSelection: 'grove-a:project-a' },
    ]);
    expect(projectScopedQueryKey(null, ['sessions'])).toEqual(['sessions']);
  });
});
