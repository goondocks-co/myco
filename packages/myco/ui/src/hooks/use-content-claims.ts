import { useCallback, useState } from 'react';
import { useMutation, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { fetchJson, postJson, ApiError } from '../lib/api';
import { usePowerQuery } from './use-power-query';
import { useProjectScopedQueryKey } from './use-project-selection';
import { useDaemon } from './use-daemon';
import { POLL_INTERVALS } from '../lib/constants';

/**
 * Content-claim system hooks (design:
 * docs/superpowers/specs/2026-07-09-content-claim-system-design.md §3/§7) —
 * the publication-lock surface over DB-resident skills and OKF pages. One
 * inventory query backs every claim affordance on the Skills dashboard and
 * the OKF page; every mutation invalidates it so a claim/release/materialize
 * anywhere in the app is immediately visible everywhere it's rendered.
 */

/* ---------- Types (mirrors daemon/api/content-claims.ts's wire shapes) ---------- */

export type ContentClaimArtifactKind = 'skill' | 'okf_page';
export type ContentClaimState = 'active' | 'released' | 'published' | 'expired';

export interface ContentClaimView {
  id: string;
  artifact_kind: ContentClaimArtifactKind;
  artifact_id: string;
  generation: number;
  claimed_by: string;
  claimed_at: number;
  expires_at: number;
  state: ContentClaimState;
  released_at: number | null;
  published_at: number | null;
  /** Computed host-side against the artifact's CURRENT lineage-latest generation — never recompute this client-side. */
  stale: boolean;
}

/** One claimable artifact: lineage-latest differs from last-published (or was never published). */
export interface ClaimableArtifact {
  artifact_kind: ContentClaimArtifactKind;
  artifact_id: string;
  label: string;
  lineage_generation: number;
  /** Null when the artifact has never been published. */
  published_generation: number | null;
  active_claim: ContentClaimView | null;
}

export interface ContentClaimsListResponse {
  ok: boolean;
  claimable: ClaimableArtifact[];
  active_claims: ContentClaimView[];
}

export interface CreateContentClaimResponse {
  ok: boolean;
  claim: ContentClaimView;
  content: { artifact_kind: ContentClaimArtifactKind; artifact_id: string; generation: number };
}

export interface ReleaseContentClaimResponse {
  ok: boolean;
  claim: ContentClaimView;
}

export interface ContentPublicationView {
  artifact_kind: ContentClaimArtifactKind;
  artifact_id: string;
  published_generation: number;
  published_at: number;
  published_by: string;
  machine_id: string;
}

export interface MarkContentClaimPublishedResponse {
  ok: boolean;
  claim: ContentClaimView;
  publication: ContentPublicationView;
}

export type MaterializeContentClaimResponse =
  | { ok: true; path: string; skill_name: string; generation: number }
  | { ok: true; path: string; page_path: string; generation: number };

const CONTENT_CLAIMS_BASE_KEY = ['content-claims'] as const;

/* ---------- Queries ---------- */

/** GET /api/content-claims — the claimable inventory + active claims for the active project. */
export function useContentClaims(): UseQueryResult<ContentClaimsListResponse> {
  return usePowerQuery<ContentClaimsListResponse>({
    queryKey: [...CONTENT_CLAIMS_BASE_KEY],
    queryFn: ({ signal }) => fetchJson<ContentClaimsListResponse>('/content-claims', { signal }),
    refetchInterval: POLL_INTERVALS.CONTENT_CLAIMS,
    pollCategory: 'standard',
  });
}

/** Find one artifact's claimable entry, or undefined when it's already published at lineage-latest. */
export function findClaimableArtifact(
  data: ContentClaimsListResponse | undefined,
  artifactKind: ContentClaimArtifactKind,
  artifactId: string,
): ClaimableArtifact | undefined {
  return (data?.claimable ?? []).find((c) => c.artifact_kind === artifactKind && c.artifact_id === artifactId);
}

/** This daemon's own machine id — the identity a claim's `claimed_by` is compared against to
 *  decide whether the active-claim actions (Release) apply to the current user. */
export function useMyMachineId(): string | undefined {
  const { data } = useDaemon();
  return data?.context.request.machine_id;
}

/* ---------- Mutations ---------- */

export interface CreateContentClaimInput {
  artifact_kind: ContentClaimArtifactKind;
  artifact_id: string;
}

/** POST /api/content-claims — constraint-based claim; 409 `already_claimed` carries the holder. */
export function useCreateContentClaim() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(CONTENT_CLAIMS_BASE_KEY);
  return useMutation({
    mutationFn: (input: CreateContentClaimInput) =>
      postJson<CreateContentClaimResponse>('/content-claims', input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });
}

/** POST /api/content-claims/:id/release — voluntary release (holder-only, cooperative in v1). */
export function useReleaseContentClaim() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(CONTENT_CLAIMS_BASE_KEY);
  return useMutation({
    mutationFn: (claimId: string) =>
      postJson<ReleaseContentClaimResponse>(`/content-claims/${encodeURIComponent(claimId)}/release`, {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });
}

/** POST /api/content-claims/:id/published — holder marks published after committing
 *  (spec §3/§4 step 6); the response's claim is terminal (`published`) and the
 *  inventory invalidation this triggers is what drops the artifact out of the
 *  claimable list and clears its Unpublished badge. */
export function useMarkContentClaimPublished() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(CONTENT_CLAIMS_BASE_KEY);
  return useMutation({
    mutationFn: (claimId: string) =>
      postJson<MarkContentClaimPublishedResponse>(`/content-claims/${encodeURIComponent(claimId)}/published`, {}),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });
}

export interface MaterializeContentClaimInput {
  claimId: string;
  projectRoot: string;
}

/** POST /api/content-claims/:id/materialize — member-side disk write, localhost-only. */
export function useMaterializeContentClaim() {
  const qc = useQueryClient();
  const queryKey = useProjectScopedQueryKey(CONTENT_CLAIMS_BASE_KEY);
  return useMutation({
    mutationFn: ({ claimId, projectRoot }: MaterializeContentClaimInput) =>
      postJson<MaterializeContentClaimResponse>(
        `/content-claims/${encodeURIComponent(claimId)}/materialize`,
        { project_root: projectRoot },
      ),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey });
    },
  });
}

/* ---------- Publish (claim + materialize) — one user action, two calls ---------- */

export interface ClaimAndMaterializeInput {
  artifactKind: ContentClaimArtifactKind;
  artifactId: string;
  projectRoot: string;
}

export type ClaimAndMaterializePhase =
  | { status: 'idle' }
  | { status: 'claiming' }
  | { status: 'claim-failed'; message: string; holder: ContentClaimView | null }
  | { status: 'materializing'; claimId: string }
  | { status: 'materialize-failed'; claimId: string; message: string }
  | { status: 'success'; claimId: string; path: string };

function messageFor(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

/**
 * "Publish" is ONE user action internally sequenced as two calls (spec §4):
 * POST the claim, then POST materialize for the claim just obtained. The two
 * steps can fail independently, and a materialize failure leaves the claim
 * ACTIVE and held — the phase result surfaces that as `materialize-failed`
 * (never silently drops back to `idle`) so the caller can offer "Retry
 * publish" without re-claiming, or release explicitly.
 */
export function useClaimAndMaterialize() {
  const createClaim = useCreateContentClaim();
  const materialize = useMaterializeContentClaim();
  const [phase, setPhase] = useState<ClaimAndMaterializePhase>({ status: 'idle' });

  const doMaterialize = useCallback(
    async (claimId: string, projectRoot: string) => {
      setPhase({ status: 'materializing', claimId });
      try {
        const result = await materialize.mutateAsync({ claimId, projectRoot });
        setPhase({ status: 'success', claimId, path: result.path });
      } catch (err) {
        setPhase({ status: 'materialize-failed', claimId, message: messageFor(err, 'Publishing failed') });
      }
    },
    [materialize],
  );

  const run = useCallback(
    async ({ artifactKind, artifactId, projectRoot }: ClaimAndMaterializeInput) => {
      setPhase({ status: 'claiming' });
      let claimId: string;
      try {
        const created = await createClaim.mutateAsync({ artifact_kind: artifactKind, artifact_id: artifactId });
        claimId = created.claim.id;
      } catch (err) {
        const holder =
          err instanceof ApiError && err.status === 409
            ? ((err.body as { holder?: ContentClaimView | null } | undefined)?.holder ?? null)
            : null;
        // `message` is rendered verbatim — outcome vocabulary, not claim jargon.
        setPhase({
          status: 'claim-failed',
          message: holder ? `Already being published by ${holder.claimed_by}` : messageFor(err, 'Publishing failed'),
          holder,
        });
        return;
      }
      await doMaterialize(claimId, projectRoot);
    },
    [createClaim, doMaterialize],
  );

  const retryMaterialize = useCallback(
    (claimId: string, projectRoot: string) => doMaterialize(claimId, projectRoot),
    [doMaterialize],
  );

  const reset = useCallback(() => setPhase({ status: 'idle' }), []);

  return { phase, run, retryMaterialize, reset };
}
