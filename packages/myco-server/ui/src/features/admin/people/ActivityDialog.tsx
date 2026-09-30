import { Dialog, DialogContent, EmptyState, ErrorState, Link, LoadingState, ShowMore } from '../../../design';
import { usePaged } from '../../../hooks/use-paged';
import { useProjects } from '../../../hooks/use-projects';
import { projectPath } from '../../../routes/nav';
import { ago } from '../../today/words';
import type { ActivityRow } from '../wire';
import { kindWords } from './words';

export interface ActivityTarget {
  /** The machine's name, for the title. */
  name: string;
  /** The credential whose writes are listed: the machine's newest. */
  credentialId: string;
  /** What that credential wrote in all, in bytes. */
  bytesWritten: number;
}

/** What a machine wrote, newest first, across every project: when, where, what, and the session it went to. */
export function ActivityDialog({ target, onClose }: { target: ActivityTarget | null; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target !== null && (
        <DialogContent title={`What ${target.name} wrote`} description={`${(target.bytesWritten / 1_048_576).toFixed(1)} MB in all, newest first.`}>
          <ActivityList key={target.credentialId} credentialId={target.credentialId} />
        </DialogContent>
      )}
    </Dialog>
  );
}

function ActivityList({ credentialId }: { credentialId: string }) {
  const activity = usePaged<ActivityRow>(['credential-activity', credentialId], `/api/credentials/${encodeURIComponent(credentialId)}/activity?limit=50`);
  const projects = useProjects();
  const projectName = (id: string) => projects.data?.projects.find((p) => p.projectId === id)?.name ?? 'A project';
  const now = Date.now();
  if (activity.isPending) return <LoadingState label="Reading what it wrote" count={3} />;
  if (activity.error !== null && activity.rows.length === 0) return <ErrorState error={activity.error} onRetry={activity.retry} />;
  if (activity.rows.length === 0) return <EmptyState title="Nothing written yet." />;
  return (
    <div className="flex flex-col">
      <ul aria-label="What it wrote" className="flex flex-col divide-y divide-line">
        {activity.rows.map((row) => (
          <li key={row.eventId} className="flex flex-wrap items-baseline justify-between gap-x-s3 gap-y-s1 py-s2" data-activity-row="">
            <span className="flex min-w-0 flex-col">
              <span className="t-small text-ink">{kindWords(row.kind)}</span>
              <span className="t-meta text-muted">{projectName(row.projectId)} · {ago(row.createdAt, now)}</span>
            </span>
            <Link className="t-small" to={`${projectPath(row.projectId, '/sessions')}/${encodeURIComponent(row.sessionId)}`}>Open session</Link>
          </li>
        ))}
      </ul>
      <ShowMore shown={activity.rows.length} noun="entries" hasMore={activity.hasMore} pending={activity.isFetchingMore} onMore={activity.more} />
    </div>
  );
}
