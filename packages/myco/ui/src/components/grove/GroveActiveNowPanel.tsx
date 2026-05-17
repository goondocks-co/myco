import { Activity, GitBranch } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
import { Badge } from '../ui/badge';
import { formatEpochAgo } from '../../lib/format';
import { useSessions, type SessionSummary } from '../../hooks/use-sessions';

interface Props {
  /**
   * Grove slug for the panel header context. The session list itself is
   * scoped server-side via the `x-myco-grove-id` selection header injected
   * by the API client, so this slug is not used for filtering.
   */
  groveSlug: string;
}

export function GroveActiveNowPanel(_props: Props) {
  const { data, isLoading } = useSessions({ status: 'active', limit: 10 });
  const sessions: SessionSummary[] = data?.sessions ?? [];

  return (
    <Surface level="low" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          <SectionHeader>Active now</SectionHeader>
        </div>
        <span className="text-xs text-on-surface-variant">
          {sessions.length} live session{sessions.length === 1 ? '' : 's'}
        </span>
      </div>
      {isLoading && sessions.length === 0 ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="text-sm text-on-surface-variant">
          <p className="font-medium">Nothing active</p>
          <p className="text-xs">
            No symbiont sessions are running right now in this Grove.
          </p>
        </div>
      ) : (
        <ul className="divide-y divide-outline-variant/10">
          {sessions.map((s) => (
            <li key={s.id}>
              <Link
                to={`/sessions/${s.id}`}
                className="block py-2.5 transition-colors hover:bg-surface-container"
              >
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 animate-pulse rounded-full bg-primary" />
                  <span className="truncate text-sm text-on-surface">
                    {s.title}
                  </span>
                  <Badge variant="outline">{s.agent}</Badge>
                  <span className="ml-auto text-xs text-on-surface-variant">
                    {formatEpochAgo(s.started_at)}
                  </span>
                </div>
                {s.branch && (
                  <div className="mt-1 flex items-center gap-2 text-xs text-on-surface-variant">
                    <GitBranch className="h-3 w-3" />
                    <span className="font-mono">{s.branch}</span>
                  </div>
                )}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
