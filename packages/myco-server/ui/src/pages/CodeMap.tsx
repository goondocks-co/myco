import { useParams } from 'react-router-dom';
import { Card, Link, Skeleton } from '../design';
import { MarkdownContent } from '../components/ui/markdown-content';
import { useCanopyMap, type CanopyMapRow } from '../hooks/use-canopy-map';
import { MEMORY_TASKS } from '../hooks/use-intelligence';
import { useProjects } from '../hooks/use-projects';
import { ago } from '../features/today/words';
import { projectPath } from '../routes/nav';
import { NotFound } from './NotFound';

/** How much of a commit id the map names. */
const SHORT_COMMIT_CHARS = 8;
const MAP_TASK_LABEL = MEMORY_TASKS.find((task) => task.id === 'canopy-map')?.label ?? 'Update the code map';

/**
 * A project's code map at `/p/:projectId/knowledge/map`: where things live, read from one commit. The map's markdown
 * renders through the shared renderer in `components/ui`, the one retired import this page holds in the ratchet baseline.
 */
export function CodeMap() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const map = useCanopyMap(projectId);
  if (projects.data !== undefined && !projects.data.projects.some((p) => p.projectId === projectId)) return <NotFound />;
  return (
    <div className="flex w-full flex-col gap-s5">
      <header className="flex flex-col gap-s2">
        <h1 className="t-display text-ink">Code map</h1>
        <p className="max-w-measure t-body text-muted">Where things live in this project’s code, and the files that carry each area.</p>
      </header>
      <CodeMapPanel base={projectPath(projectId)} map={map.data?.map ?? null} pending={map.isPending} error={map.error} />
    </div>
  );
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
          <MarkdownContent content={map.content} skipHtml className="max-w-measure" />
        </>
      )}
    </Card>
  );
}
