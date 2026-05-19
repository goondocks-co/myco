import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { IconEyebrow } from '../ui/icon-eyebrow';
import { DefRow } from '../ui/def-row';
import { Badge } from '../ui/badge';
import { useTeamStatus } from '../../hooks/use-team';
import { useTeamMembers } from '../../hooks/use-team-members';

interface Props {
  groveSlug: string;
}

export function TeamStatusCard({ groveSlug }: Props) {
  const { data: status } = useTeamStatus();
  const { data: members } = useTeamMembers();

  const connected = status?.enabled ?? false;
  const healthy = status?.healthy ?? false;
  const tone: 'default' | 'outline' | 'destructive' =
    !connected ? 'outline' : healthy ? 'default' : 'destructive';
  const label = !connected ? 'not connected' : healthy ? 'synced' : 'unhealthy';
  const count = members?.members.length ?? 0;

  return (
    <Link to={`/g/${groveSlug}/team`} className="block transition-opacity hover:opacity-90">
      <Panel
        tone="ochre"
        eyebrow={<IconEyebrow Icon={Users} tone="ochre">Team</IconEyebrow>}
        title={`${count} member${count === 1 ? '' : 's'}`}
      >
        <dl className="flex flex-col gap-1">
          <DefRow term="Status"><Badge variant={tone}>{label}</Badge></DefRow>
          <DefRow term="Pending sync"><span>{status?.pending_sync_count ?? 0}</span></DefRow>
        </dl>
      </Panel>
    </Link>
  );
}
