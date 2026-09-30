import { Card, Link, Markdown, Skeleton } from '../../design';
import { useCanopyMap, type CanopyMapRow } from '../../hooks/use-canopy-map';
import { MEMORY_TASKS } from '../../hooks/use-intelligence';
import { projectPath } from '../../routes/nav';
import { ago } from './words';

/** How much of a commit id the map names. */
const SHORT_COMMIT_CHARS = 8;
const MAP_TASK_LABEL = MEMORY_TASKS.find((task) => task.id === 'canopy-map')?.label ?? 'Update the code map';

/** A project's code map: where things live, read from one commit. */
export function CodeMap({ projectId }: { projectId: string }) {
  const map = useCanopyMap(projectId);
  return <CodeMapPanel base={projectPath(projectId)} map={map.data?.map ?? null} pending={map.isPending} error={map.error} />;
}

/** The map itself, or what stands in its place: loading, a failed read, or how a first map appears. */
export function CodeMapPanel({ base, map, pending, error, now = Date.now() }: { base: string; map: CanopyMapRow | null; pending: boolean; error: Error | null; now?: number }) {
  return (
    <Card className="flex max-w-[960px] flex-col gap-s4" data-testid="repository-map">
      {pending ? (
        <div role="status" aria-label="Loading the code map" className="flex flex-col gap-s3">
          <Skeleton className="h-s5 w-2/5" />
          <Skeleton className="h-s4 w-full" />
          <Skeleton className="h-s4 w-4/5" />
        </div>
      ) : error ? (
        <p role="alert" className="t-body text-ink-2">Could not load the code map.</p>
      ) : map === null ? (
        <div className="flex flex-col gap-s2">
          <h2 className="t-h2 text-ink">No map yet</h2>
          <p className="max-w-measure t-body text-ink-2">
            A map appears here once the project connects its repository and a map run reads it. Start one from Agent runs with “{MAP_TASK_LABEL}”.
          </p>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-baseline justify-between gap-x-s4 gap-y-s1">
            <h2 className="t-h2 text-ink">Where things live</h2>
            <p className="t-small text-muted">
              <span title={map.repository.commit}>{map.repository.branch} @ {map.repository.commit.slice(0, SHORT_COMMIT_CHARS)}</span>
              {' · '}{ago(map.generatedAt, now)}{' · '}
              <Link to={`${base}/runs/${encodeURIComponent(map.sourceRunId)}`}>The run that wrote it →</Link>
            </p>
          </div>
          <Markdown content={map.content} skipHtml className="max-w-measure" />
        </>
      )}
    </Card>
  );
}
