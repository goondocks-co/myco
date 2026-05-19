import { GitBranch } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { Row } from '../ui/row';
import { Badge } from '../ui/badge';
import { StatusDot } from '../ui/status-dot';
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
  const navigate = useNavigate();
  const { data, isLoading } = useSessions({ status: 'active', limit: 10 });
  const sessions: SessionSummary[] = data?.sessions ?? [];

  return (
    <Panel
      tone="sage"
      eyebrow="Active now"
      title={`${sessions.length} ${sessions.length === 1 ? 'live session' : 'live sessions'}`}
      padded={false}
    >
      {isLoading && sessions.length === 0 ? (
        <p className="px-5 py-4 text-sm text-on-surface-variant">Loading…</p>
      ) : sessions.length === 0 ? (
        <div className="px-5 py-4 text-sm text-on-surface-variant">
          <p className="font-medium m-0">Nothing active</p>
          <p className="text-xs m-0">
            No symbiont sessions are running right now in this Grove.
          </p>
        </div>
      ) : (
        <ul className="m-0 p-0 list-none">
          {sessions.map((s) => (
            <li key={s.id}>
              <Row accent="sage" onClick={() => navigate(`/sessions/${s.id}`)}>
                <div className="flex items-center gap-2">
                  <StatusDot tone="sage" pulse />
                  <span className="truncate text-sm text-on-surface flex-1 min-w-0">
                    {s.title || 'Untitled session'}
                  </span>
                  <Badge variant="outline">{s.agent}</Badge>
                  <span className="font-mono text-[10px] text-on-surface-variant whitespace-nowrap">
                    {formatEpochAgo(s.started_at)}
                  </span>
                </div>
                {s.branch && (
                  <div className="mt-1 ml-5 flex items-center gap-1 font-mono text-[10px] italic text-on-surface-variant">
                    <GitBranch className="h-2.5 w-2.5" />
                    {s.branch}
                  </div>
                )}
              </Row>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
