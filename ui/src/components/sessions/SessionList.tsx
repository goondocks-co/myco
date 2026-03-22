import { useNavigate } from 'react-router-dom';
import { AlertCircle, MessageSquare } from 'lucide-react';
import { Badge } from '../ui/badge';
import { useSessions, type SessionSummary } from '../../hooks/use-sessions';
import { cn } from '../../lib/cn';

/* ---------- Constants ---------- */

/** Default limit for the sessions list. */
const DEFAULT_SESSIONS_LIMIT = 100;

/* ---------- Helpers ---------- */

function statusVariant(status: string): 'default' | 'secondary' | 'outline' {
  if (status === 'active') return 'default';
  if (status === 'completed') return 'secondary';
  return 'outline';
}

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

/* ---------- Sub-components ---------- */

function SessionRow({ session, onClick }: { session: SessionSummary; onClick: () => void }) {
  return (
    <tr
      className="border-b border-border last:border-0 hover:bg-accent/50 cursor-pointer transition-colors"
      onClick={onClick}
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="text-sm font-medium text-foreground truncate max-w-xs">
            {session.title}
          </span>
        </div>
      </td>
      <td className="px-4 py-3">
        <Badge variant={statusVariant(session.status)} className="text-xs">
          {statusLabel(session.status)}
        </Badge>
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground font-mono text-xs">
        {session.date}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground font-mono text-xs">
        {session.id.slice(0, 8)}
      </td>
    </tr>
  );
}

function SkeletonRow() {
  return (
    <tr className="border-b border-border">
      {[1, 2, 3, 4].map((col) => (
        <td key={col} className="px-4 py-3">
          <div className={cn('h-4 animate-pulse rounded bg-muted', col === 1 ? 'w-48' : 'w-20')} />
        </td>
      ))}
    </tr>
  );
}

/* ---------- Component ---------- */

export function SessionList() {
  const navigate = useNavigate();
  const { data, isLoading, isError, error } = useSessions({ limit: DEFAULT_SESSIONS_LIMIT });

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <h1 className="text-2xl font-bold">Sessions</h1>
        <div className="rounded-lg border border-border">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">ID</th>
              </tr>
            </thead>
            <tbody>
              {[1, 2, 3, 4, 5].map((i) => <SkeletonRow key={i} />)}
            </tbody>
          </table>
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-2xl font-bold">Sessions</h1>
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-destructive">
          <AlertCircle className="h-5 w-5" />
          <span className="text-sm">Failed to load sessions</span>
          <span className="text-xs text-muted-foreground">{error instanceof Error ? error.message : 'Unknown error'}</span>
        </div>
      </div>
    );
  }

  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-4 p-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Sessions</h1>
        <span className="text-sm text-muted-foreground">
          {sessions.length} session{sessions.length !== 1 ? 's' : ''}
        </span>
      </div>

      {sessions.length === 0 ? (
        <div className="flex h-40 flex-col items-center justify-center gap-2 text-muted-foreground">
          <MessageSquare className="h-8 w-8 opacity-30" />
          <span className="text-sm">No sessions yet</span>
          <span className="text-xs">Sessions appear here as you work with your agent</span>
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Title</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Status</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">Date</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-muted-foreground uppercase tracking-wide">ID</th>
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  onClick={() => navigate(`/sessions/${session.id}`)}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
