// @vitest-environment jsdom

/**
 * Content-claim hooks (B6, spec §3/§4/§7): the inventory query, the four
 * mutations (including "Mark published", which closes the publish loop by
 * upserting `content_publications` and retiring the claim), and the
 * `useClaimAndMaterialize` orchestration that sequences "Publish" as ONE
 * user action — a claim POST followed by a materialize POST for the claim
 * just obtained — and surfaces a materialize failure as a distinct phase
 * (the claim stays active; nothing is silently dropped back to idle).
 */

import { renderHook, waitFor, act } from '@testing-library/react';
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { POLL_INTERVALS } from '../../packages/myco/ui/src/lib/constants';
import type {
  ContentClaimView,
  ContentClaimsListResponse,
  PublishedArtifactView,
} from '../../packages/myco/ui/src/hooks/use-content-claims';

/* ---------- Mocks ---------- */

const usePowerQueryMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectScopedQueryKey: (key: unknown[]) => [...key, { projectSelection: 'grove-a:project-a' }],
}));

const postJsonMock = vi.fn();
const fetchJsonMock = vi.fn();
class MockApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}
mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: (...args: unknown[]) => postJsonMock(...args),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: MockApiError,
}));

const useDaemonMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: (...args: unknown[]) => useDaemonMock(...args),
}));

import {
  useContentClaims,
  useCreateContentClaim,
  useReleaseContentClaim,
  useMarkContentClaimPublished,
  useMaterializeContentClaim,
  useClaimAndMaterialize,
  useMyMachineId,
  findClaimableArtifact,
  findPublishedArtifact,
  useContentFileStatus,
} from '../../packages/myco/ui/src/hooks/use-content-claims';

/* ---------- Fixtures ---------- */

function claimFixture(overrides: Partial<ContentClaimView> = {}): ContentClaimView {
  return {
    id: 'cclaim_aaaa',
    artifact_kind: 'skill',
    artifact_id: 'skill-1',
    generation: 2,
    claimed_by: 'machine-a',
    claimed_at: 1_000,
    expires_at: 1_000 + 86_400,
    state: 'active',
    released_at: null,
    published_at: null,
    stale: false,
    ...overrides,
  };
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/* ---------- Tests ---------- */

describe('useContentClaims', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
  });

  it('polls /content-claims at the CONTENT_CLAIMS interval', () => {
    const fixture: ContentClaimsListResponse = { ok: true, claimable: [], active_claims: [] };
    usePowerQueryMock.mockReturnValue({ data: fixture, isLoading: false, isError: false });

    const { result } = renderHook(() => useContentClaims());

    expect(usePowerQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: ['content-claims'],
        refetchInterval: POLL_INTERVALS.CONTENT_CLAIMS,
        pollCategory: 'standard',
      }),
    );
    expect(result.current.data).toBe(fixture);
  });
});

describe('findClaimableArtifact', () => {
  it('finds the matching artifact by kind + id', () => {
    const data: ContentClaimsListResponse = {
      ok: true,
      claimable: [
        { artifact_kind: 'skill', artifact_id: 'a', label: 'A', lineage_generation: 2, published_generation: 1, active_claim: null },
        { artifact_kind: 'skill', artifact_id: 'b', label: 'B', lineage_generation: 3, published_generation: null, active_claim: null },
      ],
      active_claims: [],
    };
    expect(findClaimableArtifact(data, 'skill', 'a')?.label).toBe('A');
    expect(findClaimableArtifact(data, 'skill', 'b')?.label).toBe('B');
    expect(findClaimableArtifact(data, 'skill', 'missing')).toBeUndefined();
  });

  it('degrades to undefined when claimable is absent from the response', () => {
    expect(findClaimableArtifact(undefined, 'skill', 'a')).toBeUndefined();
    expect(findClaimableArtifact({} as ContentClaimsListResponse, 'skill', 'a')).toBeUndefined();
  });
});

function publishedFixture(overrides: Partial<PublishedArtifactView> = {}): PublishedArtifactView {
  return {
    artifact_kind: 'skill',
    artifact_id: 'skill-1',
    name: 'my-skill',
    label: 'My Skill',
    published_generation: 3,
    lineage_generation: 3,
    active_claim: null,
    ...overrides,
  };
}

describe('findPublishedArtifact', () => {
  it('finds the matching published-at-latest artifact by kind + id', () => {
    const data: ContentClaimsListResponse = {
      ok: true,
      claimable: [],
      published: [publishedFixture(), publishedFixture({ artifact_id: 'skill-2', label: 'Other' })],
      active_claims: [],
    };
    expect(findPublishedArtifact(data, 'skill', 'skill-1')?.label).toBe('My Skill');
    expect(findPublishedArtifact(data, 'skill', 'skill-2')?.label).toBe('Other');
    expect(findPublishedArtifact(data, 'skill', 'missing')).toBeUndefined();
  });

  it('treats a missing `published` field as [] — a response from a daemon build that predates the field', () => {
    expect(findPublishedArtifact(undefined, 'skill', 'skill-1')).toBeUndefined();
    const withoutPublished: ContentClaimsListResponse = { ok: true, claimable: [], active_claims: [] };
    expect(findPublishedArtifact(withoutPublished, 'skill', 'skill-1')).toBeUndefined();
  });
});

describe('useContentFileStatus', () => {
  beforeEach(() => {
    usePowerQueryMock.mockReset();
    fetchJsonMock.mockReset();
  });

  it('polls /content-claims/file-status at the CONTENT_CLAIMS interval, keyed on root + the derived batch', () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });

    renderHook(() => useContentFileStatus('/proj', [publishedFixture()]));

    expect(usePowerQueryMock).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: [
          'content-claims',
          'file-status',
          '/proj',
          [{ artifact_kind: 'skill', artifact_id: 'skill-1', name: 'my-skill' }],
        ],
        enabled: true,
        refetchInterval: POLL_INTERVALS.CONTENT_CLAIMS,
        pollCategory: 'standard',
      }),
    );
  });

  it('is disabled (no request fires) when the published list is empty', () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });

    renderHook(() => useContentFileStatus('/proj', []));

    expect(usePowerQueryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('is disabled (no request fires) when there is no project root, even with published artifacts', () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: false, isError: false });

    renderHook(() => useContentFileStatus(undefined, [publishedFixture()]));

    expect(usePowerQueryMock).toHaveBeenCalledWith(expect.objectContaining({ enabled: false }));
  });

  it('the query function POSTs {project_root, artifacts} derived from the published entries', async () => {
    usePowerQueryMock.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    fetchJsonMock.mockResolvedValue({ statuses: [] });

    renderHook(() =>
      useContentFileStatus('/proj', [publishedFixture(), publishedFixture({ artifact_id: 'skill-2', name: 'other-skill' })]),
    );

    const call = usePowerQueryMock.mock.calls.at(-1)?.[0] as { queryFn: (ctx: { signal?: AbortSignal }) => unknown };
    await call.queryFn({});

    expect(fetchJsonMock).toHaveBeenCalledWith(
      '/content-claims/file-status',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          project_root: '/proj',
          artifacts: [
            { artifact_kind: 'skill', artifact_id: 'skill-1', name: 'my-skill' },
            { artifact_kind: 'skill', artifact_id: 'skill-2', name: 'other-skill' },
          ],
        }),
      }),
    );
  });
});

describe('useMyMachineId', () => {
  it("reads this daemon's own machine id off /stats", () => {
    useDaemonMock.mockReturnValue({
      data: { context: { request: { machine_id: 'machine-a' } } },
    });
    const { result } = renderHook(() => useMyMachineId());
    expect(result.current).toBe('machine-a');
  });

  it('returns undefined while stats has not resolved', () => {
    useDaemonMock.mockReturnValue({ data: undefined });
    const { result } = renderHook(() => useMyMachineId());
    expect(result.current).toBeUndefined();
  });
});

describe('mutations', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('useCreateContentClaim posts {artifact_kind, artifact_id} to /content-claims', async () => {
    postJsonMock.mockResolvedValue({ ok: true, claim: claimFixture(), content: {} });
    const { result } = renderHook(() => useCreateContentClaim(), { wrapper });

    result.current.mutate({ artifact_kind: 'skill', artifact_id: 'skill-1' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/content-claims', { artifact_kind: 'skill', artifact_id: 'skill-1' });
  });

  it('useReleaseContentClaim posts to /content-claims/:id/release', async () => {
    postJsonMock.mockResolvedValue({ ok: true, claim: claimFixture({ state: 'released' }) });
    const { result } = renderHook(() => useReleaseContentClaim(), { wrapper });

    result.current.mutate('cclaim_aaaa');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/release', {});
  });

  it('useMaterializeContentClaim posts {project_root} to /content-claims/:id/materialize', async () => {
    postJsonMock.mockResolvedValue({
      ok: true,
      path: '/proj/.claude/skills/foo/SKILL.md',
      skill_name: 'foo',
      generation: 2,
      auto_published: false,
    });
    const { result } = renderHook(() => useMaterializeContentClaim(), { wrapper });

    result.current.mutate({ claimId: 'cclaim_aaaa', projectRoot: '/proj' });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/materialize', { project_root: '/proj' });
  });

  it('useMarkContentClaimPublished posts to /content-claims/:id/published', async () => {
    postJsonMock.mockResolvedValue({
      ok: true,
      claim: claimFixture({ state: 'published' }),
      publication: {
        artifact_kind: 'skill',
        artifact_id: 'skill-1',
        published_generation: 2,
        published_at: 1_000,
        published_by: 'machine-a',
        machine_id: 'machine-a',
      },
    });
    const { result } = renderHook(() => useMarkContentClaimPublished(), { wrapper });

    result.current.mutate('cclaim_aaaa');
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/published', {});
  });
});

describe('useClaimAndMaterialize', () => {
  beforeEach(() => {
    postJsonMock.mockReset();
  });

  it('claims then materializes as one action, ending in success', async () => {
    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') return { ok: true, claim: claimFixture(), content: {} };
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        return {
          ok: true,
          path: '/proj/.claude/skills/foo/SKILL.md',
          skill_name: 'foo',
          generation: 2,
          auto_published: false,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = renderHook(() => useClaimAndMaterialize(), { wrapper });

    await act(async () => {
      await result.current.run({ artifactKind: 'skill', artifactId: 'skill-1', projectRoot: '/proj' });
    });

    expect(result.current.phase).toEqual({
      status: 'success',
      claimId: 'cclaim_aaaa',
      path: '/proj/.claude/skills/foo/SKILL.md',
      autoPublished: false,
    });
    expect(postJsonMock).toHaveBeenCalledWith('/content-claims', { artifact_kind: 'skill', artifact_id: 'skill-1' });
    expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/materialize', { project_root: '/proj' });
  });

  it('surfaces a 409 conflict as claim-failed with the holder, and never calls materialize', async () => {
    const holder = claimFixture({ claimed_by: 'machine-b' });
    postJsonMock.mockImplementation(async () => {
      throw new MockApiError(409, { error: { code: 'already_claimed', message: 'already claimed' }, holder });
    });

    const { result } = renderHook(() => useClaimAndMaterialize(), { wrapper });

    await act(async () => {
      await result.current.run({ artifactKind: 'skill', artifactId: 'skill-1', projectRoot: '/proj' });
    });

    expect(result.current.phase).toEqual({
      status: 'claim-failed',
      message: 'Already being published by machine-b',
      holder,
    });
    expect(postJsonMock).toHaveBeenCalledTimes(1);
  });

  it('surfaces a materialize failure as a distinct phase — the claim stays active, not silently dropped', async () => {
    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') return { ok: true, claim: claimFixture(), content: {} };
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        throw new Error('root_mismatch: attached checkout root does not match');
      }
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = renderHook(() => useClaimAndMaterialize(), { wrapper });

    await act(async () => {
      await result.current.run({ artifactKind: 'skill', artifactId: 'skill-1', projectRoot: '/proj' });
    });

    expect(result.current.phase).toEqual({
      status: 'materialize-failed',
      claimId: 'cclaim_aaaa',
      message: 'root_mismatch: attached checkout root does not match',
    });

    // Retrying materialize (without re-claiming) succeeds against the same held claim.
    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        return {
          ok: true,
          path: '/proj/.claude/skills/foo/SKILL.md',
          skill_name: 'foo',
          generation: 2,
          auto_published: false,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    await act(async () => {
      await result.current.retryMaterialize('cclaim_aaaa', '/proj');
    });

    expect(result.current.phase).toEqual({
      status: 'success',
      claimId: 'cclaim_aaaa',
      path: '/proj/.claude/skills/foo/SKILL.md',
      autoPublished: false,
    });
  });

  it('carries `auto_published: true` on the success phase for a same-generation republish', async () => {
    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') return { ok: true, claim: claimFixture(), content: {} };
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        return {
          ok: true,
          path: '/proj/.claude/skills/foo/SKILL.md',
          skill_name: 'foo',
          generation: 2,
          auto_published: true,
        };
      }
      throw new Error(`unexpected path ${path}`);
    });

    const { result } = renderHook(() => useClaimAndMaterialize(), { wrapper });

    await act(async () => {
      await result.current.run({ artifactKind: 'skill', artifactId: 'skill-1', projectRoot: '/proj' });
    });

    expect(result.current.phase).toEqual({
      status: 'success',
      claimId: 'cclaim_aaaa',
      path: '/proj/.claude/skills/foo/SKILL.md',
      autoPublished: true,
    });
  });
});
