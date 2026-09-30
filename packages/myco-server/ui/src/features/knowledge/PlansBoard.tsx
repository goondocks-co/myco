import { Link as RouterLink } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { EmptyState, ErrorState, FilterBar, focusRing, Progress, ShowMore, Skeleton, useFilterParams, useQueryDraft } from '../../design';
import { planPagePath, usePlanColumn, usePlanSearch } from '../../hooks/use-knowledge';
import { SEARCH_MIN_CHARS } from '../../hooks/use-search';
import { useNow } from '../../hooks/use-today';
import { cn } from '../../lib/cn';
import { projectPath } from '../../routes/nav';
import type { PlanBoardRow } from './wire';
import { ago, PLAN_COLUMNS, planStatusWord, planTitle, progressParts, progressWords, type PlanStatus } from './words';

const FILTER_DEBOUNCE_MS = 250;

export interface PlansBoardProps {
  /** The project the board is narrowed to, or null for every project. */
  projectId: string | null;
  projectName: (projectId: string) => string | null;
}

/**
 * The plans your agents wrote, as a board by status: in progress, open, done
 * and abandoned, each column newest edit first with "Show more". Searching
 * keeps the board: each column then holds the plans of its status whose words
 * match. Every plan opens its own page and links to the session that wrote it.
 */
export function PlansBoard({ projectId, projectName }: PlansBoardProps) {
  const filterParams = useFilterParams([]);
  const draft = useQueryDraft(filterParams.query, filterParams.setQuery, FILTER_DEBOUNCE_MS);
  const q = filterParams.query.trim();
  const searching = q.length >= SEARCH_MIN_CHARS;
  const now = useNow();
  return (
    <div className="flex flex-col gap-s5" data-plans-board="">
      <FilterBar
        searchLabel="Search plans"
        placeholder="Search plans by title or what they say"
        query={draft.text}
        onQueryChange={draft.setText}
        onClear={() => { draft.reset(); filterParams.clear(); }}
      />
      {q.length > 0 && !searching && <p className="t-small text-muted">Type at least two characters to search.</p>}
      <div className="grid items-start gap-s4 md:grid-cols-2 xl:grid-cols-4">
        {PLAN_COLUMNS.map((status) => (
          <Column key={status} status={status} projectId={projectId} projectName={projectName} q={searching ? q : null} now={now} />
        ))}
      </div>
    </div>
  );
}

interface ColumnProps {
  status: PlanStatus;
  projectId: string | null;
  projectName: (projectId: string) => string | null;
  /** The search, or null to list the column's plans. */
  q: string | null;
  now: number;
}

function Column({ status, projectId, projectName, q, now }: ColumnProps) {
  const heading = planStatusWord(status);
  const id = `plans-${status}`;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-s3 rounded-card border border-line bg-surface-1 p-s4" data-plan-column={status}>
      <h2 id={id} className="flex items-center gap-s2 t-control font-semibold text-ink">
        <span aria-hidden className={cn('size-s2 rounded-pill', status === 'in_progress' ? 'bg-ok' : status === 'active' ? 'bg-primary' : 'bg-line-strong')} />
        {heading}
      </h2>
      {q === null
        ? <ListedPlans status={status} projectId={projectId} projectName={projectName} now={now} />
        : <MatchedPlans status={status} projectId={projectId} projectName={projectName} q={q} />}
    </section>
  );
}

function ListedPlans({ status, projectId, projectName, now }: Omit<ColumnProps, 'q'>) {
  const column = usePlanColumn(projectId, status, true);
  if (column.isPending) return <ColumnLoading />;
  if (column.error) return <ErrorState error={column.error} onRetry={column.retry} className="p-s4" />;
  if (column.rows.length === 0) return <EmptyState title={`No ${planStatusWord(status).toLowerCase()} plans.`} className="py-s2 t-small" />;
  return (
    <>
      <ul className="flex flex-col gap-s2">
        {column.rows.map((plan) => (
          <PlanCard
            key={`${plan.projectId}/${plan.planKey}`}
            projectId={plan.projectId}
            planKey={plan.planKey}
            sessionId={plan.sessionId}
            title={planTitle(plan)}
            meta={[projectId === null ? projectName(plan.projectId) ?? 'A project' : null, `updated ${ago(plan.updatedAt, now)}`]}
            progress={plan.progress}
          />
        ))}
      </ul>
      {column.hasMore && (
        <ShowMore shown={column.rows.length} noun={column.rows.length === 1 ? 'plan' : 'plans'} onMore={column.more} pending={column.isFetchingMore} hasMore />
      )}
    </>
  );
}

function MatchedPlans({ status, projectId, projectName, q }: Omit<ColumnProps, 'now'> & { q: string }) {
  const search = usePlanSearch(projectId, status, q, true);
  if (search.isPending) return <ColumnLoading />;
  if (search.error) return <ErrorState error={search.error} onRetry={() => void search.refetch()} className="p-s4" />;
  const hits = search.data.results.filter((hit) => hit.type === 'plan');
  if (hits.length === 0) return <EmptyState title="None match." className="py-s2 t-small" />;
  return (
    <ul className="flex flex-col gap-s2">
      {hits.map((hit) => (
        <PlanCard
          key={`${hit.projectId}/${hit.id}`}
          projectId={hit.projectId}
          planKey={hit.id}
          sessionId={hit.session_id ?? null}
          title={hit.title.trim() === '' || hit.title === 'Plan' ? 'Untitled plan' : hit.title}
          detail={hit.preview}
          meta={[projectId === null ? projectName(hit.projectId) ?? 'A project' : null]}
        />
      ))}
    </ul>
  );
}

function ColumnLoading() {
  return (
    <div role="status" aria-label="Loading plans" className="flex flex-col gap-s2">
      <Skeleton className="h-s12 w-full rounded-control" />
      <Skeleton className="h-s12 w-full rounded-control" />
    </div>
  );
}

interface PlanCardProps {
  projectId: string;
  planKey: string;
  sessionId: string | null;
  title: string;
  /** What the plan says, when a search found it by that. */
  detail?: string;
  /** The project across projects, and when it was last edited. */
  meta: ReadonlyArray<string | null>;
  progress?: PlanBoardRow['progress'];
}

/** One plan on the board: its title opens its page, the line beneath says where and when, and the session that wrote it is one link away. */
function PlanCard({ projectId, planKey, sessionId, title, detail, meta, progress }: PlanCardProps) {
  const parts = progress === undefined ? null : progressParts(progress);
  const words = progress === undefined ? null : progressWords(progress);
  const facts = meta.filter((part): part is string => part !== null);
  return (
    <li className="relative flex flex-col gap-s2 rounded-control border border-line bg-surface-2 px-s3 py-s3 transition-colors duration-120 hover:border-line-strong" data-plan="">
      <RouterLink
        to={planPagePath(projectId, { planKey, sessionId })}
        className={cn('line-clamp-2 rounded-chip t-small font-medium text-ink after:absolute after:inset-0 after:rounded-control', focusRing)}
      >
        {title}
      </RouterLink>
      {detail !== undefined && detail.trim() !== '' && <p className="line-clamp-2 t-meta text-muted">{detail}</p>}
      {parts !== null && words !== null && (
        <div className="flex flex-col gap-s1">
          <Progress done={parts.checked} total={parts.total} label="Plan items done" />
          <span className="t-meta text-muted">{words}</span>
        </div>
      )}
      <div className="flex items-baseline justify-between gap-s2 t-meta text-muted">
        <span className="min-w-0">{facts.join(' · ')}</span>
        {sessionId !== null && (
          <RouterLink
            to={projectPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`)}
            className={cn('relative z-10 inline-flex shrink-0 items-center gap-s1 rounded-chip font-medium text-primary hover:underline', focusRing)}
            aria-label={`The session that wrote “${title}”`}
          >
            Session
            <ArrowUpRight aria-hidden className="size-s3" />
          </RouterLink>
        )}
      </div>
    </li>
  );
}
