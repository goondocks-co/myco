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

/** The ApiError class the component sees — hoisted so tests can throw REAL
 *  instances of it (the component's `instanceof ApiError` checks, e.g. the
 *  mark-published error-code mapping, only match this exact class). */
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

mock.module('../../packages/myco/ui/src/hooks/use-daemon', () => ({
  useDaemon: () => ({ data: { context: { request: { machine_id: 'machine-a' } } } }),
}));

// Mutable so a single test (item 2 — Retry publish visibly disabled once the
// project root becomes unavailable) can simulate the active project being
// deselected mid-session without a fresh mount (which would reset the local
// phase state we need to still be in `materialize-failed`).
let projectRootOverride: string | undefined = '/repo';

mock.module('../../packages/myco/ui/src/hooks/use-project-selection', () => ({
  useActiveProjectSelection: () =>
    projectRootOverride === undefined
      ? undefined
      : {
          grove: { id: 'grove-a', name: 'Work', slug: 'work', mode: 'local', is_default: true, created_at: '', project_count: 1, projects: [] },
          project: {
            project_id: 'project-a',
            name: 'Project A',
            slug: 'project-a-123',
            root: projectRootOverride,
            binding_id: null,
            created_at: '',
            updated_at: '',
            manifest_state: 'present',
          },
        },
  useProjectScopedQueryKey: (key: unknown[]) => [...key, { projectSelection: 'grove-a:project-a' }],
}));

const { ClaimControl } = await import('../../packages/myco/ui/src/components/content-claims/ClaimControl');

/* ---------- Fake server ---------- */

let activeClaim: ContentClaimView | null = null;
let materializeShouldFail = false;
// Overridable by a test that needs a specific thrown error shape (e.g. a
// real `MockApiError` carrying an `error.code`) instead of the plain-Error
// default — reset in `beforeEach` so tests don't leak into each other.
let materializeFailureError: Error = new Error('root_mismatch: attached checkout root does not match');
let published = false;
// Item 3 — a claim's `stale` flag comes straight off the fixture, same as
// every other field; a dedicated switch lets a test flip it without hand-
// building a whole ContentClaimView.
let claimStale = false;

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
    stale: claimStale,
  };
}

/** A promise a test controls the resolution of — used to pause a mocked
 *  claim/materialize mid-flight so an in-progress render (disabled buttons,
 *  suppressed holder chip) can be asserted before letting it complete. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function renderControl() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const utils = render(
    <PowerProvider>
      <QueryClientProvider client={client}>
        <ClaimControl artifactKind="skill" artifactId="skill-1" />
      </QueryClientProvider>
    </PowerProvider>,
  );
  return { ...utils, client };
}

beforeEach(() => {
  activeClaim = null;
  materializeShouldFail = false;
  materializeFailureError = new Error('root_mismatch: attached checkout root does not match');
  published = false;
  claimStale = false;
  projectRootOverride = '/repo';
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
      if (materializeShouldFail) throw materializeFailureError;
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
  it('shows the Ready to publish badge and a Publish button', async () => {
    renderControl();

    await waitFor(() => expect(screen.getByText('Ready to publish')).toBeInTheDocument());
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

  it('maps a host_unreachable materialize failure (C-6 503) to outcome copy — never "writing the file failed" or the raw API suffix', async () => {
    materializeShouldFail = true;
    materializeFailureError = new MockApiError(503, {
      error: {
        code: 'host_unreachable',
        message: 'The Team Host could not be reached. Check your connection and try again.',
      },
    });
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => expect(screen.getByTestId('materialize-failed')).toBeInTheDocument());
    const errorEl = screen.getByTestId('materialize-failed');
    expect(errorEl).toHaveTextContent("Your Team Host can't be reached right now");
    expect(errorEl).not.toHaveTextContent('API');
    expect(errorEl).not.toHaveTextContent('writing the file failed');
    // The claim is still active and held by this machine — nothing was
    // silently dropped just because the copy changed shape.
    expect(screen.getByTestId('claim-held-by-me')).toBeInTheDocument();
  });

  it('keeps the generic "writing the file failed" fallback for an unrecognized materialize error code', async () => {
    materializeShouldFail = true;
    materializeFailureError = new MockApiError(500, { error: { code: 'some_other_code', message: 'boom' } });
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => expect(screen.getByTestId('materialize-failed')).toBeInTheDocument());
    expect(screen.getByTestId('materialize-failed')).toHaveTextContent("Couldn't finish publishing — writing the file failed:");
  });

  it('surfaces a Retry publish button that is visibly disabled once the project root becomes unavailable (item 2)', async () => {
    materializeShouldFail = true;
    const { rerender, client } = renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));
    await waitFor(() => expect(screen.getByTestId('materialize-failed')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /retry publish/i })).not.toBeDisabled();

    // Simulate the active project being deselected while the failure is
    // still showing — the button used to stay visibly clickable even though
    // its onClick was a silent no-op (`projectRoot &&`) once root was gone.
    // `rerender` reuses the same fiber (and the same QueryClient, so cached
    // data survives) — only the mocked hook's return value changes.
    projectRootOverride = undefined;
    rerender(
      <PowerProvider>
        <QueryClientProvider client={client}>
          <ClaimControl artifactKind="skill" artifactId="skill-1" />
        </QueryClientProvider>
      </PowerProvider>,
    );

    await waitFor(() => expect(screen.getByRole('button', { name: /retry publish/i })).toBeDisabled());
  });

  it('keeps Publish visible and disabled through claiming and materializing — the holder chip never shows mid-flight (item 1)', async () => {
    const claimGate = deferred<void>();
    const materializeGate = deferred<void>();
    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') {
        await claimGate.promise;
        seedActiveClaim('machine-a');
        return { ok: true, claim: activeClaim, content: {} };
      }
      if (path === '/content-claims/cclaim_aaaa/materialize') {
        await materializeGate.promise;
        return { ok: true, path: '.claude/skills/my-skill/SKILL.md', skill_name: 'my-skill', generation: 3 };
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

    // Materializing: still the SAME button, still visible+disabled — not
    // swapped out for a holder/Release display, even though the server now
    // has an active claim held by this machine. This is the exact
    // double-click window the old `!activeClaim`/`phase.status==='claiming'`
    // gating missed: once the claim POST resolved but before the inventory
    // refetch caught up, `activeClaim` was still null, so the button
    // rendered enabled during materializing.
    await waitFor(() => expect(screen.getByTestId('materializing')).toBeInTheDocument());
    expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument();
    expect(screen.getByTestId('claim-and-materialize')).toBeDisabled();
    expect(screen.queryByTestId('claim-held-by-me')).toBeNull();

    await act(async () => {
      materializeGate.resolve();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId('materialize-success')).toBeInTheDocument());
    expect(screen.queryByTestId('claim-and-materialize')).toBeNull();
    expect(screen.getByTestId('claim-held-by-me')).toBeInTheDocument();
  });

  it('does not re-offer Publish at the materializing→success boundary while the claims refetch is still pending (item 1 regression)', async () => {
    // The reviewer's repro: phase reaches 'success' while the claims-list
    // refetch (which would set activeClaim) is gated — the claimId-matched
    // display flags are all false in that window, so a gate built from THEM
    // would re-show an enabled Publish mid-flow. The phase-only exclusions
    // must keep it hidden until the refetch lands.
    let gateRefetches = false;
    const listGate = deferred<void>();
    fetchJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') {
        if (gateRefetches) await listGate.promise;
        return listResponse();
      }
      return {};
    });

    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    // From here on, every list refetch hangs — the phase machine outruns it.
    gateRefetches = true;
    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/materialize', { project_root: '/repo' });
    });
    // Boundary: phase is 'success', activeClaim still null (refetch gated).
    // Publish must be GONE — with the old activeClaim-based gate it stayed
    // rendered and enabled here, and this waitFor would time out.
    await waitFor(() => expect(screen.queryByTestId('claim-and-materialize')).toBeNull());
    expect(screen.queryByTestId('mark-published')).toBeNull();
    expect(postJsonMock.mock.calls.filter((c) => c[0] === '/content-claims').length).toBe(1);

    // Refetch lands: the full success UI appears, still exactly one claim POST.
    await act(async () => {
      listGate.resolve();
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId('mark-published')).toBeInTheDocument());
    expect(screen.getByTestId('materialize-success')).toBeInTheDocument();
    expect(postJsonMock.mock.calls.filter((c) => c[0] === '/content-claims').length).toBe(1);
  });

  it('releasing after a successful publish resets the flow and re-offers Publish', async () => {
    // The phase-only showPublishButton exclusions would pin the button
    // hidden after a release if the terminal 'success' phase survived the
    // release — the Release handler resets the phase machine alongside.
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('claim-and-materialize'));
    await waitFor(() => expect(screen.getByTestId('release-claim')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('release-claim'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/release', {});
    });
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
    expect(screen.getByTestId('claim-and-materialize')).not.toBeDisabled();
  });

  it('shows a hint beside Mark published when the held claim has drifted from lineage-latest (item 3)', async () => {
    claimStale = true;
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => expect(screen.getByTestId('mark-published')).toBeInTheDocument());
    expect(screen.getByTestId('claim-stale-hint')).toBeInTheDocument();
  });

  it('shows no stale hint for a fresh claim', async () => {
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('claim-and-materialize'));

    await waitFor(() => expect(screen.getByTestId('mark-published')).toBeInTheDocument());
    expect(screen.queryByTestId('claim-stale-hint')).toBeNull();
  });

  /** Drive the publish flow to the point where Mark published is offered,
   *  then make the /published POST fail with `err`. */
  async function reachMarkPublishedThenFailWith(err: Error): Promise<void> {
    renderControl();
    await waitFor(() => expect(screen.getByTestId('claim-and-materialize')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('claim-and-materialize'));
    await waitFor(() => expect(screen.getByTestId('mark-published')).toBeInTheDocument());

    postJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims/cclaim_aaaa/published') throw err;
      throw new Error(`unexpected POST ${path}`);
    });

    fireEvent.click(screen.getByTestId('mark-published'));
    await waitFor(() => expect(screen.getByTestId('mark-published-error')).toBeInTheDocument());
  }

  it('surfaces a Mark published failure instead of silently doing nothing — raw message fallback for unrecognized errors (item 4)', async () => {
    await reachMarkPublishedThenFailWith(new Error('disk full'));

    expect(screen.getByTestId('mark-published-error')).toHaveTextContent('disk full');
    // The claim is still active and held by this machine — the mutation
    // failure didn't silently drop the affordance.
    expect(screen.getByTestId('mark-published')).toBeInTheDocument();
  });

  it('maps a lost publish window (claim_not_active) to outcome copy, never the raw API message', async () => {
    await reachMarkPublishedThenFailWith(
      new MockApiError(409, { error: { code: 'claim_not_active', message: 'claim cclaim_aaaa is no longer active' } }),
    );

    const errorEl = screen.getByTestId('mark-published-error');
    expect(errorEl).toHaveTextContent('This publish window has ended');
    expect(errorEl).not.toHaveTextContent('cclaim');
    expect(errorEl).not.toHaveTextContent('API');
  });

  it('maps a not_holder refusal to outcome copy, never the raw API message', async () => {
    await reachMarkPublishedThenFailWith(
      new MockApiError(403, { error: { code: 'not_holder', message: 'only the claim holder may do this' } }),
    );

    const errorEl = screen.getByTestId('mark-published-error');
    expect(errorEl).toHaveTextContent('Another machine holds this publish.');
    expect(errorEl).not.toHaveTextContent('claim holder');
    expect(errorEl).not.toHaveTextContent('API');
  });
});

describe('ClaimControl — fetch error', () => {
  it('surfaces a persistent /content-claims failure instead of silently rendering nothing (item 4)', async () => {
    fetchJsonMock.mockImplementation(async (path: string) => {
      if (path === '/content-claims') throw new Error('network unreachable');
      return {};
    });

    renderControl();

    await waitFor(() => expect(screen.getByTestId('claims-fetch-error')).toBeInTheDocument());
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
    // Reloading the page while already holding an active claim (e.g. from a
    // prior session): held-by-me renders, but the local phase state never
    // went through 'success' here, so there is nothing provably written to
    // mark — the recovery affordance for that window is Finish publishing
    // (item 5), which re-runs the write and unlocks Mark published through
    // the normal success flow.
    seedActiveClaim('machine-a');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-held-by-me')).toBeInTheDocument());
    expect(screen.queryByTestId('mark-published')).toBeNull();
    expect(screen.getByTestId('finish-publishing')).toBeInTheDocument();
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

describe('ClaimControl — Finish publishing after a reload (item 5)', () => {
  // Simulates reloading the page while already holding an active claim from
  // a prior session — the local `phase` state is idle (never went through
  // 'success' HERE), so Mark published cannot be offered: file PRESENCE
  // can't prove the file carries the claimed generation (a pre-existing
  // old-generation file would satisfy it while materialize never ran).
  // Instead the holder gets "Finish publishing" — re-running the write is
  // always generation-correct and idempotent, and Mark published follows
  // through the normal this-session success flow.
  it('offers Finish publishing (never Mark published) to the holder in the reload window', async () => {
    seedActiveClaim('machine-a');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('finish-publishing')).toBeInTheDocument());
    expect(screen.getByTestId('publish-unfinished')).toBeInTheDocument();
    expect(screen.queryByTestId('mark-published')).toBeNull();
    // File presence is deliberately not consulted — a pre-existing OLD
    // generation file on disk must not unlock Mark published, so nothing
    // about the offer depends on disk state (no file-status probe fires
    // from the claimable branch at all).
    expect(fetchJsonMock.mock.calls.some((c) => c[0] === '/content-claims/file-status')).toBe(false);
  });

  it('clicking Finish publishing re-writes the HELD claim (no re-claim), then offers Mark published as designed', async () => {
    seedActiveClaim('machine-a');
    renderControl();
    await waitFor(() => expect(screen.getByTestId('finish-publishing')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('finish-publishing'));

    await waitFor(() => {
      expect(postJsonMock).toHaveBeenCalledWith('/content-claims/cclaim_aaaa/materialize', { project_root: '/repo' });
    });
    // The held claim was reused — no claim POST ever fires.
    expect(postJsonMock.mock.calls.filter((c) => c[0] === '/content-claims').length).toBe(0);

    await waitFor(() => expect(screen.getByTestId('mark-published')).toBeInTheDocument());
    expect(screen.getByTestId('materialize-success')).toBeInTheDocument();
    expect(screen.queryByTestId('finish-publishing')).toBeNull();
  });

  it('shows the stale hint (pointing at Release) beside Finish publishing when the claim has drifted', async () => {
    claimStale = true;
    seedActiveClaim('machine-a');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('finish-publishing')).toBeInTheDocument());
    expect(screen.getByTestId('claim-stale-hint')).toHaveTextContent(/Release and publish again/);
  });

  it('does not offer Finish publishing when the active claim is held by another machine', async () => {
    seedActiveClaim('machine-b');
    renderControl();

    await waitFor(() => expect(screen.getByTestId('claim-held-by-other')).toBeInTheDocument());
    expect(screen.queryByTestId('finish-publishing')).toBeNull();
    expect(screen.queryByTestId('mark-published')).toBeNull();
  });
});

/* ---------- Merged state: published-at-latest but missing from disk ---------- */

/**
 * A second fake-server model, independent of the `claimable` one above: one
 * skill already published at its lineage-latest generation (so it's ONLY in
 * `published`, never `claimable`), plus a controllable file-status batch
 * response. Exercises the real `useContentFileStatus`/`findPublishedArtifact`
 * wiring against a mocked `lib/api`, matching this file's existing "exercise
 * the real hooks" convention. (`deferred` is shared with the claimable-branch
 * tests above — defined once near the top of the file.)
 */

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
    expect(screen.queryByText('Ready to publish')).toBeNull();
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
