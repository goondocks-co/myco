import { useEffect } from 'react';
import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { formatEpochAgo } from '../../lib/format';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import {
  useContentClaims,
  useContentFileStatus,
  useInvalidateContentClaims,
  useReleaseContentClaim,
  useMarkContentClaimPublished,
  useClaimAndMaterialize,
  useMyMachineId,
  findClaimableArtifact,
  findPublishedArtifact,
  type ContentClaimArtifactKind,
  type ContentFileStatusRequestArtifact,
} from '../../hooks/use-content-claims';

/**
 * The full claim affordance for one artifact (spec §7): the unpublished
 * badge, "Publish" (one user action — POST claim then POST materialize,
 * `use-content-claims.ts`'s `useClaimAndMaterialize`), "Release" for the
 * holder, "Mark published" once the holder has committed the materialized
 * file (spec §3/§4 step 6 — closes the publish loop by upserting
 * `content_publications` and retiring the claim), and a holder+age display
 * when someone else holds it. Also re-offers "Publish" for an artifact
 * that's already published at lineage-latest but whose file is missing from
 * this checkout (design §2(c) — e.g. `git rm`'d or an unpulled branch);
 * that merged-state flow reuses the same claim/materialize plumbing, but a
 * same-generation republish auto-closes server-side (Task 1.4), so no
 * "Mark published" step is needed there. Renders nothing when the artifact
 * is neither claimable nor published-but-missing.
 *
 * Copy doctrine: every rendered string uses outcome vocabulary ("Publish",
 * "Being published by…"), never mechanism vocabulary (claim, materialize,
 * lock) — users publish content; the claim system is how the sausage is
 * made. Internal names (hooks, phase states, test ids) keep the mechanism
 * terms because they mirror the API surface.
 *
 * Also surfaces a stale-claim hint beside "Mark published" (a lineage-latest
 * that moved on since the claim was taken), a load failure for the
 * inventory fetch itself, and a "Mark published" mutation failure — none of
 * these silently dropped the user on the floor before.
 */
export function ClaimControl({
  artifactKind,
  artifactId,
  name,
}: {
  artifactKind: ContentClaimArtifactKind;
  artifactId: string;
  /** The artifact's path-derivation key (skills: `skill_records.name`) —
   *  optional. Only needed to answer "is the materialized file already on
   *  disk" for the CLAIMABLE branch's Mark-published affordance (item 5);
   *  omit it and that affordance simply never re-offers after a reload,
   *  same as before this fix. */
  name?: string;
}) {
  const { data, isError: claimsError } = useContentClaims();
  const claimable = findClaimableArtifact(data, artifactKind, artifactId);
  const publishedEntry = findPublishedArtifact(data, artifactKind, artifactId);
  const myMachineId = useMyMachineId();
  const selection = useActiveProjectSelection();
  const projectRoot = selection?.project.root;
  const release = useReleaseContentClaim();
  const markPublished = useMarkContentClaimPublished();
  const { phase, run, retryMaterialize, reset } = useClaimAndMaterialize();
  const fileStatus = useContentFileStatus(projectRoot, data?.published ?? []);
  const invalidateContentClaims = useInvalidateContentClaims();

  // Item 5 (reload loses Mark published): this session's local `phase` resets
  // on reload, so `phase.status === 'success'` can no longer prove a
  // materialize happened here. The file-status batch (PR #669) independently
  // confirms the expected file is already on disk — scoped to a single
  // artifact, and only queried once there's something worth checking (a
  // `name` was supplied AND this machine currently holds the claim; nobody
  // else's reload should trigger a check on our behalf).
  const claimableActiveClaim = claimable?.active_claim ?? null;
  const claimableHeldByMe =
    !!claimableActiveClaim && !!myMachineId && claimableActiveClaim.claimed_by === myMachineId;
  const claimableFileStatusArtifacts: ContentFileStatusRequestArtifact[] =
    name && claimableActiveClaim && claimableHeldByMe
      ? [{ artifact_kind: artifactKind, artifact_id: artifactId, name }]
      : [];
  const claimableFileStatus = useContentFileStatus(projectRoot, claimableFileStatusArtifacts);

  // Same-generation republish auto-closes server-side (Task 1.4): once that
  // lands, this session's own repair is done — invalidate both queries so
  // the entry drops the Publish affordance immediately, and reset the phase
  // so a healthy re-render (no active claim, file present) can return null
  // instead of leaving a stale "success" message pinned forever. A materialize
  // originating from the CLAIMABLE branch below can never set `autoPublished`
  // true (that branch only runs when published/lineage generations already
  // differ, which structurally fails Task 1.4's same-generation check), so
  // this effect only ever fires for the merged-state flow.
  useEffect(() => {
    if (phase.status === 'success' && phase.autoPublished) {
      invalidateContentClaims();
      reset();
    }
  }, [phase, invalidateContentClaims, reset]);

  if (!claimable) {
    if (!publishedEntry) {
      // Fetch-error paper cut (item 4): a persistent /content-claims failure
      // previously left this control returning null with no explanation —
      // the whole publish affordance just silently vanished. Only surfaces
      // when there's nothing else to render (a successful earlier fetch that
      // later degrades keeps showing its last-known-good state, unaffected).
      if (claimsError) {
        return (
          <Surface
            level="low"
            className="flex flex-col gap-2 p-4"
            data-testid={`claim-control-${artifactKind}-${artifactId}`}
          >
            <p className="font-sans text-xs text-tertiary m-0" data-testid="claims-fetch-error">
              Couldn't check publish status — try again shortly
            </p>
          </Surface>
        );
      }
      return null;
    }

    const activeClaim = publishedEntry.active_claim;
    const heldByMe = !!activeClaim && !!myMachineId && activeClaim.claimed_by === myMachineId;
    const inFlight = phase.status === 'claiming' || phase.status === 'materializing';
    const materializing = phase.status === 'materializing';
    const materializeFailed = phase.status === 'materialize-failed';
    const justPublished = phase.status === 'success';

    // Degrade (design §2, pinned): a non-200 file-status response or a
    // per-artifact `file_present: null` both mean "no affordance" — exactly
    // today's behavior. `fileStatus.isError` covers the whole-batch failure;
    // a missing per-artifact entry (route degrades a bad batch entry rather
    // than dropping it, but match-by-identity still guards against drift)
    // falls through the same `?? null`.
    const fileStatusEntry = fileStatus.isError
      ? undefined
      : fileStatus.data?.statuses.find(
          (s) => s.artifact_kind === publishedEntry.artifact_kind && s.artifact_id === publishedEntry.artifact_id,
        );
    const filePresent = fileStatusEntry?.file_present ?? null;

    const nothingToRepair =
      !activeClaim && !inFlight && !materializeFailed && !justPublished && filePresent !== false;
    if (nothingToRepair) return null;

    // The bottom Publish button stays visible+disabled through the entire
    // in-flight window (claiming → materializing) regardless of whether
    // `activeClaim` has caught up via refetch yet — keying visibility off
    // the phase machine, not the merged flags, is what keeps the control
    // from vanishing mid-flow (design §2(c)).
    const showPublishButton = inFlight || (!activeClaim && !materializeFailed && !justPublished);

    return (
      <Surface
        level="low"
        className="flex flex-col gap-2 p-4"
        data-testid={`claim-control-${artifactKind}-${artifactId}`}
      >
        {filePresent === false && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant="warning">Missing</Badge>
            <span className="font-mono text-[10px] text-on-surface-variant">
              gen {publishedEntry.published_generation}
            </span>
          </div>
        )}
        {filePresent === false && (
          <p className="font-sans text-xs text-on-surface-variant m-0">
            Published file missing from your checkout
          </p>
        )}

        {activeClaim && !inFlight && (
          <div
            className="flex flex-wrap items-center gap-2"
            data-testid={heldByMe ? 'claim-held-by-me' : 'claim-held-by-other'}
          >
            <span className="font-sans text-xs text-on-surface-variant">
              Being published by <span className="font-mono">{activeClaim.claimed_by}</span>
              {' · '}
              {formatEpochAgo(activeClaim.claimed_at)}
            </span>
            {heldByMe && <Badge variant="outline">this machine</Badge>}
            {heldByMe && (
              <Button
                size="sm"
                variant="ghost"
                disabled={release.isPending}
                onClick={() => release.mutate(activeClaim.id)}
                data-testid="release-claim"
              >
                {release.isPending ? 'Releasing…' : 'Release'}
              </Button>
            )}
          </div>
        )}

        {materializing && (
          <p className="font-sans text-xs text-on-surface-variant" data-testid="materializing">
            Publishing…
          </p>
        )}

        {materializeFailed && (
          <div className="flex flex-wrap items-center gap-2" data-testid="materialize-failed">
            <p className="font-sans text-xs text-tertiary m-0">
              Couldn't finish publishing — writing the file failed: {phase.message}
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={!projectRoot}
              onClick={() => projectRoot && retryMaterialize(phase.claimId, projectRoot)}
            >
              Retry publish
            </Button>
          </div>
        )}

        {justPublished && (
          <p className="font-sans text-xs text-primary m-0" data-testid="materialize-success">
            Published to {phase.path}
          </p>
        )}

        {showPublishButton && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={inFlight || !projectRoot}
              onClick={() => projectRoot && run({ artifactKind, artifactId, projectRoot })}
              data-testid="claim-and-materialize"
            >
              {phase.status === 'claiming' ? 'Publishing…' : 'Publish'}
            </Button>
            {phase.status === 'claim-failed' && (
              <span className="font-sans text-xs text-tertiary" data-testid="claim-failed">
                {phase.message}
              </span>
            )}
          </div>
        )}
      </Surface>
    );
  }

  const activeClaim = claimable.active_claim;
  const heldByMe = !!activeClaim && !!myMachineId && activeClaim.claimed_by === myMachineId;
  const materializing = phase.status === 'materializing' && phase.claimId === activeClaim?.id;
  const materializeFailed = phase.status === 'materialize-failed' && phase.claimId === activeClaim?.id;
  const justMaterialized = phase.status === 'success' && phase.claimId === activeClaim?.id;
  // Item 1 — the Publish button's own in-flight window spans claiming ->
  // materializing for THIS session's own `run()`, independent of whether
  // `activeClaim` has caught up via refetch yet (mirrors the merged-state
  // branch's `inFlight`/`showPublishButton` pattern above). The button used
  // to gate on `!activeClaim` alone and disable only during 'claiming' — a
  // second click during the materializing window, while `activeClaim` was
  // still stale-null from before the claim POST resolved, re-fired `run()`
  // and re-claimed mid-flight.
  const publishInFlight = phase.status === 'claiming' || phase.status === 'materializing';
  const showPublishButton = publishInFlight || !activeClaim;

  // Item 5 — offer Mark published to the holder when the claim is active AND
  // the file-status batch confirms the materialized file already matches
  // (reload case), in addition to the existing THIS-session justMaterialized
  // case.
  const claimableFileStatusEntry = claimableFileStatus.isError
    ? undefined
    : claimableFileStatus.data?.statuses.find(
        (s) => s.artifact_kind === artifactKind && s.artifact_id === artifactId,
      );
  const materializedFileMatches = claimableFileStatusEntry?.file_present === true;
  const canMarkPublished =
    !!activeClaim && heldByMe && !materializing && (justMaterialized || materializedFileMatches);

  return (
    <Surface
      level="low"
      className="flex flex-col gap-2 p-4"
      data-testid={`claim-control-${artifactKind}-${artifactId}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="warning">Unpublished</Badge>
        <span className="font-mono text-[10px] text-on-surface-variant">
          gen {claimable.lineage_generation}
          {claimable.published_generation !== null && ` · last published gen ${claimable.published_generation}`}
        </span>
      </div>

      {activeClaim && !publishInFlight && (
        <div
          className="flex flex-wrap items-center gap-2"
          data-testid={heldByMe ? 'claim-held-by-me' : 'claim-held-by-other'}
        >
          <span className="font-sans text-xs text-on-surface-variant">
            Being published by <span className="font-mono">{activeClaim.claimed_by}</span>
            {' · '}
            {formatEpochAgo(activeClaim.claimed_at)}
          </span>
          {heldByMe && <Badge variant="outline">this machine</Badge>}
          {heldByMe && !materializing && (
            <Button
              size="sm"
              variant="ghost"
              disabled={release.isPending}
              onClick={() => release.mutate(activeClaim.id)}
              data-testid="release-claim"
            >
              {release.isPending ? 'Releasing…' : 'Release'}
            </Button>
          )}
        </div>
      )}

      {materializing && (
        <p className="font-sans text-xs text-on-surface-variant" data-testid="materializing">
          Publishing…
        </p>
      )}

      {materializeFailed && (
        <div className="flex flex-wrap items-center gap-2" data-testid="materialize-failed">
          <p className="font-sans text-xs text-tertiary m-0">
            Couldn't finish publishing — writing the file failed: {phase.message}
          </p>
          <Button
            size="sm"
            variant="outline"
            disabled={!projectRoot}
            onClick={() => projectRoot && retryMaterialize(phase.claimId, projectRoot)}
          >
            Retry publish
          </Button>
        </div>
      )}

      {canMarkPublished && activeClaim && (
        <div className="flex flex-wrap items-center gap-2">
          <p
            className="font-sans text-xs text-primary m-0"
            data-testid={justMaterialized ? 'materialize-success' : 'materialized-file-present'}
          >
            {justMaterialized
              ? `Published to ${phase.path} — review and commit it`
              : 'The published file is already in your checkout — review and commit it'}
          </p>
          {activeClaim.stale && (
            <span className="font-sans text-xs text-tertiary" data-testid="claim-stale-hint">
              This has moved on since you started — make sure it's still current before marking published
            </span>
          )}
          <Button
            size="sm"
            disabled={markPublished.isPending}
            onClick={() => markPublished.mutate(activeClaim.id)}
            data-testid="mark-published"
          >
            {markPublished.isPending ? 'Marking…' : 'Mark published'}
          </Button>
          {markPublished.isError && (
            <span className="font-sans text-xs text-tertiary" data-testid="mark-published-error">
              {markPublished.error instanceof Error
                ? markPublished.error.message
                : "Couldn't mark this published — try again"}
            </span>
          )}
        </div>
      )}

      {showPublishButton && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={publishInFlight || !projectRoot}
            onClick={() => projectRoot && run({ artifactKind, artifactId, projectRoot })}
            data-testid="claim-and-materialize"
          >
            {publishInFlight ? 'Publishing…' : 'Publish'}
          </Button>
          {phase.status === 'claim-failed' && (
            <span className="font-sans text-xs text-tertiary" data-testid="claim-failed">
              {phase.message}
            </span>
          )}
        </div>
      )}
    </Surface>
  );
}
