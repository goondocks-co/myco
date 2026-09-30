import { useMemo } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Dialog, DialogContent, EmptyState, ErrorState, Link, LoadingState, ShowMore } from '../../../design';
import { fetchJson } from '../../../lib/api';
import { useProjects } from '../../../hooks/use-projects';
import { projectPath } from '../../../routes/nav';
import { ago } from '../../today/words';
import type { ActivityPage, ActivityRow } from '../wire';
import { kindWords } from './words';

export interface ActivityTarget {
  /** The machine's name, for the title. */
  name: string;
  /** Every credential the machine signed in with, so what is listed matches what it wrote in all. */
  credentialIds: readonly string[];
  /** What those credentials wrote in all, in bytes. */
  bytesWritten: number;
}

/** What a machine wrote, newest first, across every project: when, where, what, and the session it went to. */
export function ActivityDialog({ target, onClose }: { target: ActivityTarget | null; onClose: () => void }) {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      {target !== null && (
        <DialogContent title={`What ${target.name} wrote`} description={`${(target.bytesWritten / 1_048_576).toFixed(1)} MB in all, newest first.`}>
          <ActivityList key={target.credentialIds.join(',')} credentialIds={target.credentialIds} />
        </DialogContent>
      )}
    </Dialog>
  );
}

/** Where each credential's activity has been read to: its next cursor, or null once it is read to the end. */
type Cursors = Readonly<Record<string, string | null>>;

/**
 * The activity of every credential a machine signed in with, merged newest
 * first. Each page asks every credential with more to give for its next 50;
 * "Show more" asks again while any has more.
 */
export function useMachineActivity(credentialIds: readonly string[]) {
  const query = useInfiniteQuery({
    queryKey: ['machine-activity', ...credentialIds],
    initialPageParam: Object.fromEntries(credentialIds.map((id) => [id, ''])) as Cursors,
    queryFn: async ({ pageParam, signal }) => {
      const asked = Object.entries(pageParam).filter((entry): entry is [string, string] => entry[1] !== null);
      const pages = await Promise.all(asked.map(async ([id, cursor]) => {
        const path = `/api/credentials/${encodeURIComponent(id)}/activity?limit=50${cursor === '' ? '' : `&cursor=${encodeURIComponent(cursor)}`}`;
        return [id, await fetchJson<ActivityPage>(path, signal)] as const;
      }));
      return { rows: pages.flatMap(([, page]) => page.rows), cursors: Object.fromEntries(pages.map(([id, page]) => [id, page.cursor])) as Cursors };
    },
    getNextPageParam: (last) => (Object.values(last.cursors).some((cursor) => cursor !== null) ? last.cursors : undefined),
  });
  const rows = useMemo(() => {
    const byId = new Map<string, ActivityRow>();
    for (const page of query.data?.pages ?? []) for (const row of page.rows) byId.set(row.eventId, row);
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [query.data]);
  return {
    rows,
    isPending: query.isPending,
    error: query.error,
    hasMore: query.hasNextPage,
    isFetchingMore: query.isFetchingNextPage,
    more: () => { void query.fetchNextPage({ cancelRefetch: false }); },
    retry: () => { void query.refetch(); },
  };
}

function ActivityList({ credentialIds }: { credentialIds: readonly string[] }) {
  const activity = useMachineActivity(credentialIds);
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
