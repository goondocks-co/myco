import { LayoutGrid } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Surface } from '../ui/surface';
import { SectionHeader } from '../ui/section-header';
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
    <Surface level="low" className="rounded-lg p-5 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <LayoutGrid className="h-4 w-4 text-primary" />
          <SectionHeader>Projects</SectionHeader>
        </div>
        <span className="text-xs text-on-surface-variant">
          {rows.length} in this Grove
        </span>
      </div>
      {isLoading && rows.length === 0 ? (
        <p className="text-sm text-on-surface-variant">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-on-surface-variant">No projects yet.</p>
      ) : (
        <ul className="divide-y divide-outline-variant/10">
          {rows.map((p) => (
            <li key={p.project_id} className="flex items-center gap-3 py-2.5">
              <LayoutGrid className="h-3.5 w-3.5 shrink-0 text-on-surface-variant" />
              <div className="min-w-0 flex-1">
                <Link
                  to={`/g/${groveSlug}/p/${p.project_id}`}
                  className="block truncate text-sm text-on-surface hover:text-primary"
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
            </li>
          ))}
        </ul>
      )}
    </Surface>
  );
}
