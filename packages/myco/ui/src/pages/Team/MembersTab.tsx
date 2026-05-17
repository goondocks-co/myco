import { useTeamMembers, type TeamMember } from '../../hooks/use-team-members';
import { useTeamStatus } from '../../hooks/use-team';
import { Surface } from '../../components/ui/surface';
import { SectionHeader } from '../../components/ui/section-header';
import { Badge } from '../../components/ui/badge';

function initials(name: string): string {
  return name.split(/\s+/).slice(0, 2).map((p) => p[0] ?? '').join('').toUpperCase() || '?';
}

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
    <li className="flex items-center gap-3 py-3 border-b border-outline-variant/10 last:border-b-0">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-medium text-primary">
        {initials(m.user)}
      </div>
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
    </li>
  );
}

export function MembersTab() {
  const { data, isLoading } = useTeamMembers();
  const { data: status } = useTeamStatus();
  const selfMachineId = status?.machine_id ?? null;

  return (
    <div className="space-y-4">
      <Surface level="low" ghostBorder className="p-5 space-y-3">
        <div className="flex items-center justify-between">
          <SectionHeader>Roster</SectionHeader>
          <span className="text-xs text-on-surface-variant">
            {data ? `${data.members.length} member${data.members.length === 1 ? '' : 's'}` : ' '}
          </span>
        </div>
        {isLoading ? (
          <p className="text-sm text-on-surface-variant">Loading…</p>
        ) : !data || data.members.length === 0 ? (
          <p className="text-sm text-on-surface-variant">
            No team members yet. Run <code className="font-mono">myco-team join</code> on a teammate's machine to add them.
          </p>
        ) : (
          <ul>
            {data.members.map((m) => (
              <MemberRow key={m.id} m={m} isSelf={m.machine_id === selfMachineId} />
            ))}
          </ul>
        )}
      </Surface>
      <p className="text-xs text-on-surface-variant">
        Members come from the local <code className="font-mono">team_members</code> table, synced from peers via the team Worker.
      </p>
    </div>
  );
}
