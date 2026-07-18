import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { DefRow } from '../ui/def-row';
import { Badge } from '../ui/badge';
import { healthBadgeVariant, humanizeHealthKind } from '../../lib/constants';
import { useHostServeStatus } from '../../hooks/use-host-serve-status';

interface Props {
  groveId: string;
  groveSlug: string;
}

/**
 * Grove Dashboard's conditional Team Host card (E-4 W1 Task T6,
 * decision-ef693c71 D2) — renders ONLY when this machine serves THIS Grove
 * to a team; every other Grove viewed on this machine sees nothing here.
 * `TeamHostServingCard` on the Machine Dashboard is the unconditional
 * counterpart: it always shows this machine's own serving state regardless
 * of which Grove is currently being viewed. Follows the shape of the
 * retired `TeamStatusCard` (E-2/E-3, `git show ed899d42~1:…TeamStatusCard.tsx`)
 * that used to occupy this same Row 1 slot: whole-card link to the Team
 * page, `ochre` tone, `Users` eyebrow icon.
 */
export function TeamHostServedCard({ groveId, groveSlug }: Props) {
  const { data } = useHostServeStatus();
  if (!data || data.serving !== true || data.served_grove_id !== groveId) return null;

  const { health, external_mcp: externalMcp } = data;

  return (
    <Link to={`/g/${groveSlug}/team`} className="block transition-opacity hover:opacity-90">
      <Panel
        tone="ochre"
        eyebrow={<IconEyebrow Icon={Users} tone="ochre">Team</IconEyebrow>}
        title="Served to your team by this machine"
      >
        <dl className="flex flex-col gap-1">
          <DefRow term="Backups">
            <Badge variant={healthBadgeVariant(health.backup)}>{humanizeHealthKind(health.backup)}</Badge>
          </DefRow>
          <DefRow term="Provider key">
            <Badge variant={healthBadgeVariant(health.key)}>{humanizeHealthKind(health.key)}</Badge>
          </DefRow>
          <DefRow term="External access">
            {externalMcp.enabled ? (
              <Badge variant={healthBadgeVariant(health.mcp_coherence)}>
                {humanizeHealthKind(health.mcp_coherence)}
              </Badge>
            ) : (
              <Badge variant="secondary">Off</Badge>
            )}
          </DefRow>
        </dl>
      </Panel>
    </Link>
  );
}
