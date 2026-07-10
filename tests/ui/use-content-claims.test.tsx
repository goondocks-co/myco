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
import type { ContentClaimView, ContentClaimsListResponse } from '../../packages/myco/ui/src/hooks/use-content-claims';

/* ---------- Mocks ---------- */

const usePowerQueryMock = vi.fn();
mock.module('../../packages/myco/ui/src/hooks/use-power-query', () => ({
  usePowerQuery: (...args: unknown[]) => usePowerQueryMock(...args),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useProjectScopedQueryKey: (key: unknown[]) => [...key, { projectSelection: 'grove-a:project-a' }],
}));

const postJsonMock = vi.fn();
class MockApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API error ${status}`);
  }
}
mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: vi.fn(),
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
        { artifact_kind: 'okf_page', artifact_id: 'p', label: 'P', lineage_generation: 3, published_generation: null, active_claim: null },
      ],
      active_claims: [],
    };
    expect(findClaimableArtifact(data, 'skill', 'a')?.label).toBe('A');
    expect(findClaimableArtifact(data, 'okf_page', 'p')?.label).toBe('P');
    expect(findClaimableArtifact(data, 'skill', 'missing')).toBeUndefined();
  });

  it('degrades to undefined when claimable is absent from the response', () => {
    expect(findClaimableArtifact(undefined, 'skill', 'a')).toBeUndefined();
    expect(findClaimableArtifact({} as ContentClaimsListResponse, 'skill', 'a')).toBeUndefined();
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
    postJsonMock.mockResolvedValue({ ok: true, path: '/proj/.claude/skills/foo/SKILL.md', skill_name: 'foo', generation: 2 });
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
        return { ok: true, path: '/proj/.claude/skills/foo/SKILL.md', skill_name: 'foo', generation: 2 };
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
        return { ok: true, path: '/proj/.claude/skills/foo/SKILL.md', skill_name: 'foo', generation: 2 };
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
    });
  });
});
