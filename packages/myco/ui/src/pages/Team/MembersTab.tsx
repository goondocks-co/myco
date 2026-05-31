import { useTeamMembers, type TeamMember } from '../../hooks/use-team-members';
import { useTeamStatus } from '../../hooks/use-team';
import { Panel } from '../../components/ui/panel';
import { Row } from '../../components/ui/row';
import { Badge } from '../../components/ui/badge';
import { MemberAvatar } from '../../components/ui/member-avatar';

function timeAgo(at: number | null): string {
  if (!at) return 'never';
  const ms = Date.now() - at * 1000;
  const m = Math.floor(ms / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function MemberRow({ m, isSelf }: { m: TeamMember; isSelf: boolean }) {
  return (
    <Row accent="ochre">
      <div className="flex items-center gap-3">
        <MemberAvatar name={m.user} size={36} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm text-on-surface">{m.user}</span>
            {isSelf && <Badge variant="outline">this machine</Badge>}
            {m.role && <Badge variant={m.role === 'owner' ? 'default' : 'outline'}>{m.role}</Badge>}
          </div>
          <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-on-surface-variant">
            <span className="font-mono">{m.machine_id}</span>
            {m.joined && <span>joined {m.joined}</span>}
            {!isSelf && <span>last received {timeAgo(m.synced_at)}</span>}
            {m.tags.map((t) => <span key={t} className="font-mono">#{t}</span>)}
          </div>
        </div>
      </div>
    </Row>
  );
}

export function MembersTab({ teamId }: { teamId?: string } = {}) {
  const { data, isLoading: membersLoading } = useTeamMembers(teamId);
  const { data: status, isLoading: statusLoading } = useTeamStatus(teamId);
  const selfMachineId = status?.machine_id ?? null;
  // Hold rendering until BOTH the members list AND the self machine_id
  // have resolved. Painting members before status would flicker rows
  // without the "this machine" badge and — when status arrives null
  // permanently — flatly mis-label peer rows as not-self.
  const isHydrating = membersLoading || statusLoading;
  const count = data?.members.length ?? 0;

  return (
    <div className="flex flex-col gap-4">
      <Panel
        tone="ochre"
        eyebrow="Members"
        title="Roster"
        actions={
          isHydrating ? null : (
            <span className="font-mono text-xs text-on-surface-variant">
              {count} {count === 1 ? 'member' : 'members'}
            </span>
          )
        }
        padded={false}
      >
        {isHydrating ? (
          <p className="px-5 py-4 text-sm text-on-surface-variant m-0">Loading…</p>
        ) : !data || data.members.length === 0 ? (
          <p className="px-5 py-4 text-sm text-on-surface-variant m-0">
            No team members yet. Run <code className="font-mono">myco-team join</code> on a teammate's machine to add them.
          </p>
        ) : (
          <ul className="m-0 p-0 list-none">
            {data.members.map((m) => (
              <li key={m.id}>
                <MemberRow m={m} isSelf={m.machine_id === selfMachineId} />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <p className="text-xs text-on-surface-variant m-0">
        Members come from the local <code className="font-mono">team_members</code> table, synced from peers via the team Worker.
      </p>
    </div>
  );
}
