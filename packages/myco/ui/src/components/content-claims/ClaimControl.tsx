import { Badge } from '../ui/badge';
import { Button } from '../ui/button';
import { Surface } from '../ui/surface';
import { formatEpochAgo } from '../../lib/format';
import { useActiveProjectSelection } from '../../hooks/use-project-selection';
import {
  useContentClaims,
  useReleaseContentClaim,
  useMarkContentClaimPublished,
  useClaimAndMaterialize,
  useMyMachineId,
  findClaimableArtifact,
  type ContentClaimArtifactKind,
} from '../../hooks/use-content-claims';

/**
 * The full claim affordance for one artifact (spec §7): the unpublished
 * badge, "Publish" (one user action — POST claim then POST materialize,
 * `use-content-claims.ts`'s `useClaimAndMaterialize`), "Release" for the
 * holder, "Mark published" once the holder has committed the materialized
 * file (spec §3/§4 step 6 — closes the publish loop by upserting
 * `content_publications` and retiring the claim), and a holder+age display
 * when someone else holds it. Renders nothing when the artifact is already
 * published at lineage-latest (not present in the claimable inventory).
 *
 * Copy doctrine: every rendered string uses outcome vocabulary ("Publish",
 * "Being published by…"), never mechanism vocabulary (claim, materialize,
 * lock) — users publish content; the claim system is how the sausage is
 * made. Internal names (hooks, phase states, test ids) keep the mechanism
 * terms because they mirror the API surface.
 */
export function ClaimControl({
  artifactKind,
  artifactId,
}: {
  artifactKind: ContentClaimArtifactKind;
  artifactId: string;
}) {
  const { data } = useContentClaims();
  const claimable = findClaimableArtifact(data, artifactKind, artifactId);
  const myMachineId = useMyMachineId();
  const selection = useActiveProjectSelection();
  const projectRoot = selection?.project.root;
  const release = useReleaseContentClaim();
  const markPublished = useMarkContentClaimPublished();
  const { phase, run, retryMaterialize } = useClaimAndMaterialize();

  if (!claimable) return null;

  const activeClaim = claimable.active_claim;
  const heldByMe = !!activeClaim && !!myMachineId && activeClaim.claimed_by === myMachineId;
  const materializing = phase.status === 'materializing' && phase.claimId === activeClaim?.id;
  const materializeFailed = phase.status === 'materialize-failed' && phase.claimId === activeClaim?.id;
  const justMaterialized = phase.status === 'success' && phase.claimId === activeClaim?.id;

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

      {activeClaim && (
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
            onClick={() => projectRoot && retryMaterialize(phase.claimId, projectRoot)}
          >
            Retry publish
          </Button>
        </div>
      )}

      {justMaterialized && activeClaim && heldByMe && (
        <div className="flex flex-wrap items-center gap-2">
          <p className="font-sans text-xs text-primary m-0" data-testid="materialize-success">
            Published to {phase.path} — review and commit it
          </p>
          <Button
            size="sm"
            disabled={markPublished.isPending}
            onClick={() => markPublished.mutate(activeClaim.id)}
            data-testid="mark-published"
          >
            {markPublished.isPending ? 'Marking…' : 'Mark published'}
          </Button>
        </div>
      )}

      {!activeClaim && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={phase.status === 'claiming' || !projectRoot}
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
