import { LayoutGrid } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Panel } from '../ui/panel';
import { Row } from '../ui/row';
import { Badge } from '../ui/badge';
import { formatTimeAgo } from '../../lib/format';
import { useProjectsActivity } from '../../hooks/use-maintenance-summary';

interface Props {
  groveSlug: string;
}

export function GroveProjectsPanel({ groveSlug }: Props) {
  const { data, isLoading } = useProjectsActivity();
  const rows = (data?.projects ?? []).filter((p) => p.grove_slug === groveSlug);

  return (
    <Panel
      tone="sage"
      eyebrow="Projects"
      title="In this Grove"
      actions={
        <span className="font-mono text-xs text-on-surface-variant">
          {rows.length}
        </span>
      }
      padded={false}
    >
      {isLoading && rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-on-surface-variant">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-5 py-4 text-sm text-on-surface-variant">No projects yet.</p>
      ) : (
        <ul className="m-0 p-0 list-none">
          {rows.map((p) => (
            <li key={p.project_id}>
              <Row accent="sage">
                <div className="flex items-center gap-3">
                  <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
                  <div className="min-w-0 flex-1">
                    <Link
                      to={`/g/${groveSlug}/p/${p.project_id}`}
                      className="block truncate text-sm text-on-surface hover:text-sage"
                    >
                      {p.project_name}
                    </Link>
                    <div className="flex gap-x-3 text-xs text-on-surface-variant">
                      <span>
                        {p.scheduled_runs_last_24h} run
                        {p.scheduled_runs_last_24h === 1 ? '' : 's'} / 24h
                      </span>
                      <span>·</span>
                      <span>
                        last activity{' '}
                        {p.last_activity_at ? formatTimeAgo(p.last_activity_at) : 'never'}
                      </span>
                    </div>
                  </div>
                  <Badge variant={p.is_active ? 'default' : 'outline'}>
                    {p.is_active ? 'active' : 'cold'}
                  </Badge>
                </div>
              </Row>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
