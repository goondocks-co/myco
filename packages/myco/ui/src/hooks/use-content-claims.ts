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
 * the publication-lock surface over DB-resident skills. One inventory query
 * backs every claim affordance on the Skills dashboard; every mutation
 * invalidates it so a claim/release/materialize anywhere in the app is
 * immediately visible everywhere it's rendered.
 */

/* ---------- Types (mirrors daemon/api/content-claims.ts's wire shapes) ---------- */

export type ContentClaimArtifactKind = 'skill';
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

/** One artifact published at its current lineage-latest generation — the
 *  additive companion to `claimable` (design §2(a)). `name` is the
 *  path-derivation key (skills derive `.agents/skills/<name>/SKILL.md`);
 *  `label` is display-only. */
export interface PublishedArtifactView {
  artifact_kind: 'skill';
  artifact_id: string;
  name: string;
  label: string;
  published_generation: number;
  lineage_generation: number;
  active_claim: ContentClaimView | null;
}

export interface ContentClaimsListResponse {
  ok: boolean;
  claimable: ClaimableArtifact[];
  /** Absent from a response predating this field — every consumer
   *  (`findPublishedArtifact`, the file-status batch below) treats a
   *  missing `published` as `[]`, never as an error. */
  published?: PublishedArtifactView[];
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
  { ok: true; path: string; skill_name: string; generation: number; auto_published: boolean };

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

/** Find one artifact's published-at-latest entry, or undefined when it's
 *  unpublished/stale (in `claimable` instead) or the response predates the
 *  `published` field. Mirrors `findClaimableArtifact`. */
export function findPublishedArtifact(
  data: ContentClaimsListResponse | undefined,
  artifactKind: ContentClaimArtifactKind,
  artifactId: string,
): PublishedArtifactView | undefined {
  return (data?.published ?? []).find((p) => p.artifact_kind === artifactKind && p.artifact_id === artifactId);
}

/* ---------- File-status (member disk truth, Task 1.3) ---------- */

export interface ContentFileStatusRequestArtifact {
  artifact_kind: ContentClaimArtifactKind;
  artifact_id: string;
  name: string;
}

/** One status entry, index-aligned to the request's `artifacts` — the route
 *  echoes `artifact_kind`/`artifact_id` back unvalidated (a malformed batch
 *  entry degrades rather than throwing), so callers match by the SAME
 *  identity pair rather than trusting response order. */
export interface ContentFileStatusEntry {
  artifact_kind: ContentClaimArtifactKind | null;
  artifact_id: string | null;
  file_present: boolean | null;
}

export interface ContentFileStatusResponse {
  statuses: ContentFileStatusEntry[];
}

const CONTENT_FILE_STATUS_BASE_KEY = [...CONTENT_CLAIMS_BASE_KEY, 'file-status'] as const;

/** POST /api/content-claims/file-status — one batched disk-presence check
 *  for every published-at-latest artifact, against the active project's own
 *  working tree (design §2(b)). Skipped entirely (no request fires) when
 *  there's nothing to check or no project root to check it against — the
 *  route requires both. Rides the same 15s cadence as `useContentClaims`. */
export function useContentFileStatus(
  projectRoot: string | undefined,
  published: PublishedArtifactView[],
): UseQueryResult<ContentFileStatusResponse> {
  const artifacts: ContentFileStatusRequestArtifact[] = published.map((p) => ({
    artifact_kind: p.artifact_kind,
    artifact_id: p.artifact_id,
    name: p.name,
  }));
  return usePowerQuery<ContentFileStatusResponse>({
    queryKey: [...CONTENT_FILE_STATUS_BASE_KEY, projectRoot, artifacts],
    queryFn: ({ signal }) =>
      fetchJson<ContentFileStatusResponse>('/content-claims/file-status', {
        method: 'POST',
        body: JSON.stringify({ project_root: projectRoot, artifacts }),
        signal,
      }),
    enabled: artifacts.length > 0 && !!projectRoot,
    refetchInterval: POLL_INTERVALS.CONTENT_CLAIMS,
    pollCategory: 'standard',
  });
}

/**
 * Invalidate the inventory query AND the file-status query in one call. The
 * two live under different query-key shapes (the inventory's scoped key has
 * nothing after the project marker; file-status has request params after
 * it), so the inventory mutations' own `onSettled` invalidation — which
 * targets the inventory's exact scoped key — never reaches file-status.
 * Used by `ClaimControl`'s merged-state Publish flow: when a same-generation
 * republish auto-closes server-side (Task 1.4's `auto_published: true`), the
 * repaired entry should drop its Publish affordance immediately rather than
 * wait for the next poll.
 */
export function useInvalidateContentClaims(): () => void {
  const qc = useQueryClient();
  const inventoryKey = useProjectScopedQueryKey(CONTENT_CLAIMS_BASE_KEY);
  return useCallback(() => {
    void qc.invalidateQueries({ queryKey: inventoryKey });
    void qc.invalidateQueries({ queryKey: CONTENT_FILE_STATUS_BASE_KEY });
  }, [qc, inventoryKey]);
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
  | { status: 'success'; claimId: string; path: string; autoPublished: boolean };

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
        setPhase({ status: 'success', claimId, path: result.path, autoPublished: result.auto_published });
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
