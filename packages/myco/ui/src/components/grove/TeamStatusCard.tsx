import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { Badge } from '../ui/badge';
import { useTeamStatus } from '../../hooks/use-team';
import { useTeamMembers } from '../../hooks/use-team-members';

interface Props {
  groveSlug: string;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2 text-xs">
      <dt className="text-on-surface-variant">{k}</dt>
      <dd className="text-on-surface">{children}</dd>
    </div>
  );
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
        eyebrow={
          <span className="inline-flex items-center gap-1.5">
            <Users className="h-3 w-3" />
            Team
          </span>
        }
        title={`${count} member${count === 1 ? '' : 's'}`}
      >
        <dl className="flex flex-col gap-1">
          <Row k="Status"><Badge variant={tone}>{label}</Badge></Row>
          <Row k="Pending sync"><span>{status?.pending_sync_count ?? 0}</span></Row>
        </dl>
      </Panel>
    </Link>
  );
}
