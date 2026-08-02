import { Badge } from '../ui/badge';
import { useContentClaims, findClaimableArtifact, type ContentClaimArtifactKind } from '../../hooks/use-content-claims';

/**
 * The one-line "this generation hasn't been published" signal (spec §7):
 * renders only when the artifact's lineage-latest generation differs from
 * `content_publications.published_generation` (or it was never published).
 * Renders nothing once the artifact is caught up — no badge for the common
 * case keeps skill/page lists uncluttered.
 */
export function UnpublishedBadge({
  artifactKind,
  artifactId,
}: {
  artifactKind: ContentClaimArtifactKind;
  artifactId: string;
}) {
  const { data } = useContentClaims();
  const claimable = findClaimableArtifact(data, artifactKind, artifactId);
  if (!claimable) return null;

  return (
    <Badge
      variant="warning"
      title={`A new version (gen ${claimable.lineage_generation}) is ready to publish to your project${
        claimable.published_generation !== null ? ` (currently published: gen ${claimable.published_generation})` : ''
      }`}
    >
      Ready to publish
    </Badge>
  );
}
