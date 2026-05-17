import { Users } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { Badge } from '../ui/badge';
import { useTeamStatus } from '../../hooks/use-team';
import { useTeamMembers } from '../../hooks/use-team-members';

interface Props {
  groveSlug: string;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-2">
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

  return (
    <Link to={`/g/${groveSlug}/team`} className="block">
      <Surface level="low" className="rounded-lg p-5 space-y-3 transition-colors hover:bg-surface-container">
        <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-primary">
          <Users className="h-3.5 w-3.5" />
          <span>Team</span>
        </div>
        <div className="text-lg font-medium text-on-surface">
          {members?.members.length ?? 0} members
        </div>
        <dl className="space-y-1 text-xs">
          <Row k="Status"><Badge variant={tone}>{label}</Badge></Row>
          <Row k="Pending sync">
            <span>{status?.pending_sync_count ?? 0}</span>
          </Row>
        </dl>
      </Surface>
    </Link>
  );
}
