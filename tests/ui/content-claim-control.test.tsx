// @vitest-environment jsdom

/**
 * ClaimControl (B6) — the shared claim affordance rendered on the Skills
 * detail page: the unpublished badge, "Publish"
 * (one user action, two calls per spec §4), "Release" for the holder, "Mark
 * published" once THIS session's materialize has succeeded (closes the
 * publish loop, spec §3 step 6), and a holder+age display when someone else
 * holds it. Exercises the REAL hooks (`use-content-claims.ts`) against a
 * mocked `lib/api`, so this covers the wiring end to end — not just the hook
 * unit behavior already covered by tests/ui/use-content-claims.test.tsx.
 *
 * `fetchJsonMock`/`postJsonMock` model a tiny stateful fake server (one
 * claimable skill, at most one active claim, a `published` flag) so a
 * claim's mutations and the list refetch they trigger stay consistent — a
 * static fixture would make the post-claim refetch silently "forget" the
 * claim just created, or leave a published artifact still in the inventory.
 */

import { render, screen, waitFor, fireEvent, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PowerProvider } from '../../packages/myco/ui/src/providers/power';
import type { ContentClaimsListResponse, ContentClaimView } from '../../packages/myco/ui/src/hooks/use-content-claims';

/* ---------- Mocks ---------- */

const fetchJsonMock = vi.fn();
const postJsonMock = vi.fn();

mock.module('../../packages/myco/ui/src/lib/api', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
  postJson: (...args: unknown[]) => postJsonMock(...args),
  putJson: async () => ({}),
  patchJson: async () => ({}),
  deleteJson: async () => ({}),
  ApiError: class ApiError extends Error {
    constructor(public status: number, public body: unknown) {
      super(`API error ${status}`);
    }
  },
}));

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: { context: { request: { machine_id: 'machine-a' } } } }),
}));

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () => ({
    grove: { id: 'grove-a', name: 'Work', slug: 'work', mode: 'local', is_default: true, created_at: '', project_count: 1, projects: [] },
    project: {
      project_id: 'project-a',
      name: 'Project A',
      slug: 'project-a-123',
      root: '/repo',
      binding_id: null,
      created_at: '',
      updated_at: '',
      manifest_state: 'present',
    },
  }),
  useProjectScopedQueryKey: (key: unknown[]) => [...key, { projectSelection: 'grove-a:project-a' }],
}));

const { ClaimControl } = await import('../../packages/myco/ui/src/components/content-claims/ClaimControl');

/* ---------- Fake server ---------- */

let activeClaim: ContentClaimView | null = null;
let materializeShouldFail = false;
let published = false;

function listResponse(): ContentClaimsListResponse {
  return {
    ok: true,
    // Once published, the artifact leaves the claimable inventory entirely —
    // the real daemon excludes it once published_generation === lineage_generation.
    claimable: published
      ? []
      : [
          {
            artifact_kind: 'skill',
            artifact_id: 'skill-1',
            label: 'My Skill',
            lineage_generation: 3,
            published_generation: 2,
            active_claim: activeClaim,
          },
        ],
    active_claims: activeClaim ? [activeClaim] : [],
  };
}

function seedActiveClaim(claimedBy: string): void {
  activeClaim = {
    id: 'cclaim_aaaa',
    artifact_kind: 'skill',
    artifact_id: 'skill-1',
    generation: 3,
    claimed_by: claimedBy,
    claimed_at: Math.floor(Date.now() / 1000) - 120,
    expires_at: Math.floor(Date.now() / 1000) + 86_400,
    state: 'active',
    released_at: null,
    published_at: null,
    stale: false,
  };
}

function renderControl() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <ClaimControl artifactKind="skill" artifactId="skill-1" />
      </QueryClientProvider>
    </PowerProvider>,
  );
}

beforeEach(() => {
  activeClaim = null;
  materializeShouldFail = false;
  published = false;
  fetchJsonMock.mockReset();
  postJsonMock.mockReset();

  fetchJsonMock.mockImplementation(async (path: string) => (path === '/content-claims' ? listResponse() : {}));

  postJsonMock.mockImplementation(async (path: string) => {
    if (path === '/content-claims') {
      if (activeClaim) {
        throw new (class ApiError extends Error {
          status = 409;
          body = { error: { code: 'already_claimed' }, holder: activeClaim };
        })('already claimed');
      }
      seedActiveClaim('machine-a');
      return { ok: true, claim: activeClaim, content: {} };
    }
    if (path === '/content-claims/cclaim_aaaa/materialize') {
      if (materializeShouldFail) throw new Error('root_mismatch: attached checkout root does not match');
      return { ok: true, path: '.claude/skills/my-skill/SKILL.md', skill_name: 'my-skill', generation: 3 };
    }
    if (path === '/content-claims/cclaim_aaaa/release') {
      const released = { ...(activeClaim as ContentClaimView), state: 'released' as const };
      activeClaim = null;
      return { ok: true, claim: released };
    }
    if (path === '/content-claims/cclaim_aaaa/published') {
      const claim = { ...(activeClaim as ContentClaimView), state: 'published' as const, published_at: Math.floor(Date.now() / 1000) };
      activeClaim = null;
      published = true;
      return {
        ok: true,
        claim,
        publication: {
          artifact_kind: 'skill',
          artifact_id: 'skill-1',
          published_generation: 3,
          published_at: claim.published_at,
          published_by: claim.claimed_by,
          machine_id: claim.claimed_by,
        },
      };
    }
    throw new Error(`unexpected POST ${path}`);
  });
});

// Without this, an earlier test's ClaimControl instance stays mounted (and
// its QueryClient's background refetches keep running) while a later test
// executes — a stray invalidation from that leftover instance updates state
// outside any `act()` the later test controls, and React warns about it
// attributed to a generically-named component with no test context. Flush
// one macrotask under `act()` BEFORE unmounting so an in-flight mock fetch
// (the mocks don't honor AbortSignal) settles and its state update lands
// while the tree is still mounted and act-tracked, not after.
afterEach(async () => {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  cleanup();
});

/* ---------- Tests ---------- */

describe('ClaimControl — already published', () => {
  it('renders nothing when the artifact is not in the claimable inventory', async () => {
    fetchJsonMock.mockImplementation(async (path: string) =>
      path === '/content-claims' ? { ok: true, claimable: [], active_claims: [] } : {},
    );
    const { container } = renderControl();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });
});

describe('ClaimControl — unclaimed', () => {
  it('shows the Unpublished badge and a Publish button', async () => {
    renderControl();

    await waitFor(() => expect(screen.getByText('Unpublished')).toBeInTheDocument());
    expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument();
    expect(screen.getByText(/gen 3/)).toBeInTheDocument();
  });

  it('Publish sequences claim then materialize, then shows the holder (you) with Release and Mark published', async () => {
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims', { artifact_kind: 'skill', artifact_id: 'skill-1' });
    });
    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/materialize', { project_root: '/repo' });
    });
    await waitFor(() => {
      expect(screen.getByTestId('materialize-success')).toHaveTextContent('.claude/skills/my-skill/SKILL.md');
    });
    await waitFor(() => expect(screen.getByTestId('release-claim')).toBeInTheDocument());
    expect(screen.getByTestId('claim-held-by-me')).toHaveTextContent('this machine');
    expect(screen.getByTestId('mark-published')).toHaveTextContent('Mark published');
  });

  it('surfaces a materialize failure without losing the claim, then Retry publish recovers', async () => {
    materializeShouldFail = true;
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    // The claim succeeded (still active, held by this machine) but the write failed —
    // the claim is NOT silently dropped: a distinct failure state names the error and
    // offers Retry publish against the SAME claim (no re-claim needed).
    await waitFor(() => {
      expect(screen.getByTestId('materialize-failed')).toHaveTextContent(/root_mismatch/);
    });
    expect(postJsonMock.mock.calls.filter((c) => c[0] === '/content-claims').length).toBe(1);
    expect(screen.getByTestId('claim-held-by-me')).toBeInTheDocument();

    materializeShouldFail = false;
    fireEvent.click(screen.getByRole('button', { name: /retry publish/i }));

    await waitFor(() => {
      expect(screen.getByTestId('materialize-success')).toHaveTextContent('.claude/skills/my-skill/SKILL.md');
    });
    // Retry reused the claim from the failed attempt — no second claim POST.
    expect(postJsonMock.mock.calls.filter((c) => c[0] === '/content-claims').length).toBe(1);
  });
});

describe('ClaimControl — claimed by another machine', () => {
  it('shows the holder id and age, and no action buttons', async () => {
    seedActiveClaim('machine-b');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-held-by-other')).toBeInTheDocument());
    expect(screen.getByTestId('claim-held-by-other')).toHaveTextContent('machine-b');
    expect(screen.queryByTestId('release-claim')).toBeNull();
    expect(screen.queryByTestId('claim-and-materialize')).toBeNull();
    expect(screen.queryByTestId('mark-published')).toBeNull();
  });
});

describe('ClaimControl — mark published', () => {
  it('does not show Mark published merely from holding the claim — only after THIS session materializes', async () => {
    // Simulates reloading the page while already holding an active claim
    // (e.g. from a prior session): held-by-me renders, but the local phase
    // state never went through 'success' here, so there is nothing to mark.
    seedActiveClaim('machine-a');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-held-by-me')).toBeInTheDocument());
    expect(screen.queryByTestId('mark-published')).toBeNull();
  });

  it('clicking Mark published posts to /content-claims/:id/published and the artifact leaves the inventory', async () => {
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('claim-and-materialize'));
    await waitFor(() => expect(screen.getByTestId('mark-published')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('mark-published'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/published', {});
    });
    // The inventory invalidation this mutation triggers refetches the list;
    // the artifact is no longer claimable once published, so the whole
    // control (badge included) unmounts.
    await waitFor(() => expect(screen.queryByTestId('claim-control-skill-skill-1')).toBeNull());
  });
});

describe('ClaimControl — release', () => {
  it('clicking Release posts to /content-claims/:id/release and returns to the unclaimed state', async () => {
    seedActiveClaim('machine-a');
    renderControl();
    await waitFor(() => expect(screen.getByTestId('release-claim')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('release-claim'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/release', {});
    });
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
  });
});

/* ---------- Merged state: published-at-latest but missing from disk ---------- */

/**
 * A second fake-server model, independent of the `claimable` one above: one
 * skill already published at its lineage-latest generation (so it's ONLY in
 * `published`, never `claimable`), plus a controllable file-status batch
 * response. Exercises the real `useContentFileStatus`/`findPublishedArtifact`
 * wiring against a mocked `lib/api`, matching this file's existing "exercise
 * the real hooks" convention.
 */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('ClaimControl — published but missing from the working tree (merged state)', () => {
  let mergedActiveClaim: ContentClaimView | null;
  let filePresent: boolean | null;
  let fileStatusOk: boolean;
  let autoPublishOnMaterialize: boolean;

  function mergedListResponse(): ContentClaimsListResponse {
    return {
      ok: true,
      claimable: [],
      published: [
        {
          artifact_kind: 'skill',
          artifact_id: 'skill-1',
          name: 'my-skill',
          label: 'My Skill',
          published_generation: 3,
          lineage_generation: 3,
          active_claim: mergedActiveClaim,
        },
      ],
      active_claims: mergedActiveClaim ? [mergedActiveClaim] : [],
    };
  }

  function seedMergedActiveClaim(claimedBy: string): void {
    mergedActiveClaim = {
      id: 'cclaim_aaaa',
      artifact_kind: 'skill',
      artifact_id: 'skill-1',
      generation: 3,
      claimed_by: claimedBy,
      claimed_at: Math.floor(Date.now() / 1000) - 120,
      expires_at: Math.floor(Date.now() / 1000) + 86_400,
      state: 'active',
      released_at: null,
      published_at: null,
      stale: false,
    };
  }

  beforeEach(() => {
    mergedActiveClaim = null;
    filePresent = false;
    fileStatusOk = true;
    autoPublishOnMaterialize = true;

    fetchJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') return mergedListResponse();
      if (path === '/content-claims/file-status') {
        if (!fileStatusOk) {
          throw new (class ApiError extends Error {
            status = 409;
            body = { error: { code: 'root_mismatch' } };
          })('root mismatch');
        }
        return { statuses: [{ artifact_kind: 'skill', artifact_id: 'skill-1', file_present: filePresent }] };
      }
      return {};
    });

    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') {
        if (mergedActiveClaim) {
          throw new (class ApiError extends Error {
            status = 409;
            body = { error: { code: 'already_claimed' }, holder: mergedActiveClaim };
          })('already claimed');
        }
        seedMergedActiveClaim('machine-a');
        return { ok: true, claim: mergedActiveClaim, content: {} };
      }
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        filePresent = true;
        if (autoPublishOnMaterialize) mergedActiveClaim = null;
        return {
          ok: true,
          path: '.claude/skills/my-skill/SKILL.md',
          skill_name: 'my-skill',
          generation: 3,
          auto_published: autoPublishOnMaterialize,
        };
      }
      if (path === '/content-claims/cclaim_aaaa/release') {
        const released = { ...(mergedActiveClaim as ContentClaimView), state: 'released' as const };
        mergedActiveClaim = null;
        return { ok: true, claim: released };
      }
      throw new Error(`unexpected POST ${path}`);
    });
  });

  it('renders nothing for a healthy published artifact (file present, no claim) — same as today', async () => {
    filePresent = true;
    const { container } = renderControl();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/content-claims', expect.anything()));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders Publish when published-at-latest, the file is missing, and there is no active claim', async () => {
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
    expect(screen.getByTestId('claim-and-materialize')).toHaveTextContent('Publish');
    expect(screen.getByText(/Published file missing from your checkout/)).toBeInTheDocument();
    expect(screen.queryByText('Unpublished')).toBeNull();
  });

  it('renders nothing when file_present is null (degraded) — no affordance', async () => {
    filePresent = null;
    const { container } = renderControl();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/content-claims/file-status', expect.anything()));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing when the file-status batch fails (non-200) — no affordance', async () => {
    fileStatusOk = false;
    const { container } = renderControl();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalledWith('/content-claims/file-status', expect.anything()));
    await waitFor(() => expect(container.textContent).toBe(''));
  });

  it('renders nothing when `published` is missing entirely from the response', async () => {
    fetchJsonMock.mockImplementation(async (path: string) =>
      path === '/content-claims' ? { ok: true, claimable: [], active_claims: [] } : {},
    );
    const { container } = renderControl();

    await waitFor(() => expect(fetchJsonMock).toHaveBeenCalled());
    expect(container.textContent).toBe('');
  });

  it('keeps Publish visible and disabled through claiming and materializing — never vanishes mid-flow', async () => {
    const claimGate = deferred<void>();
    const materializeGate = deferred<void>();
    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') {
        await claimGate.promise;
        seedMergedActiveClaim('machine-a');
        return { ok: true, claim: mergedActiveClaim, content: {} };
      }
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        await materializeGate.promise;
        filePresent = true;
        mergedActiveClaim = null;
        return {
          ok: true,
          path: '.claude/skills/my-skill/SKILL.md',
          skill_name: 'my-skill',
          generation: 3,
          auto_published: true,
        };
      }
      throw new Error(`unexpected POST ${path}`);
    });

    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    // Claiming: the button stays in the DOM, disabled, labeled as in-flight.
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeDisabled());
    expect(screen.getByTestId('claim-and-materialize')).toHaveTextContent('Publishing…');

    await act(async () => {
      claimGate.resolve();
      await Promise.resolve();
    });

    // Materializing: still the SAME button, still visible and disabled — not
    // swapped out for a holder/Release display, even though the server now
    // has an active claim held by this machine.
    await waitFor(() => expect(screen.getByTestId('materializing')).toBeInTheDocument());
    expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument();
    expect(screen.getByTestId('claim-and-materialize')).toBeDisabled();
    expect(screen.queryByTestId('claim-held-by-me')).toBeNull();

    await act(async () => {
      materializeGate.resolve();
      await Promise.resolve();
    });

    // Same-generation republish auto-closes; the repair is complete and the
    // control returns to rendering nothing, with no Mark-published step ever
    // shown for this flow.
    await waitFor(() => expect(screen.queryByTestId('claim-control-skill-skill-1')).toBeNull());
    expect(screen.queryByTestId('mark-published')).toBeNull();
  });

  it('a stale active claim held by this machine shows Release, not Mark published', async () => {
    seedMergedActiveClaim('machine-a');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-held-by-me')).toBeInTheDocument());
    expect(screen.getByTestId('release-claim')).toBeInTheDocument();
    expect(screen.queryByTestId('mark-published')).toBeNull();
    expect(screen.queryByTestId('claim-and-materialize')).toBeNull();
  });

  it('a stale active claim held by another machine shows the holder and age, no actions', async () => {
    seedMergedActiveClaim('machine-b');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-held-by-other')).toBeInTheDocument());
    expect(screen.getByTestId('claim-held-by-other')).toHaveTextContent('machine-b');
    expect(screen.queryByTestId('release-claim')).toBeNull();
    expect(screen.queryByTestId('claim-and-materialize')).toBeNull();
  });

  it('clicking Publish auto-closes on a same-generation republish — invalidates and clears the affordance', async () => {
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/materialize', { project_root: '/repo' });
    });
    // auto_published: true closed the claim server-side (simulated by the fake
    // server clearing `mergedActiveClaim`) — no Mark-published affordance
    // ever appears, and the repaired entry drops out once the invalidated
    // queries refetch.
    await waitFor(() => expect(screen.queryByTestId('claim-control-skill-skill-1')).toBeNull());
    expect(screen.queryByTestId('mark-published')).toBeNull();
  });

  it('Release still works from the merged state and returns to Publish', async () => {
    seedMergedActiveClaim('machine-a');
    renderControl();
    await waitFor(() => expect(screen.getByTestId('release-claim')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('release-claim'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/release', {});
    });
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
  });
});
