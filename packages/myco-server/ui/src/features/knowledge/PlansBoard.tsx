import { Link as RouterLink } from 'react-router-dom';
import { ArrowUpRight } from 'lucide-react';
import { tapTarget, EmptyState, ErrorState, FilterBar, focusRing, Progress, ShowMore, Skeleton, useFilterParams, useQueryDraft } from '../../design';
import { planPagePath, usePlanColumn } from '../../hooks/use-knowledge';
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
 * and abandoned, each column newest edit first with "Show more" and its count.
 * Searching keeps the board: each column then holds the plans of its status
 * whose title or text match, counted the same way. Every plan opens its own
 * page and links to the session that wrote it.
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
      {/* One column under another on a phone, two by two on a tablet, and side by side on a wide screen: nothing scrolls sideways. */}
      <div className="grid items-start gap-s4 md:grid-cols-2 xl:grid-cols-4" data-board="">
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
  const column = usePlanColumn(projectId, status, q);
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-s3 rounded-card border border-line bg-surface-1 p-s4" data-plan-column={status}>
      <div className="flex items-center gap-s2">
        <h2 id={id} className="flex items-center gap-s2 t-control font-semibold text-ink">
          <span aria-hidden className={cn('size-s2 rounded-pill', status === 'in_progress' ? 'bg-ok' : status === 'active' ? 'bg-primary' : 'bg-line-strong')} />
          {heading}
        </h2>
        {column.total !== undefined && (
          <span className="relative ml-auto t-small tabular-nums text-muted" data-plan-total="">
            {column.total.toLocaleString()}<span className="sr-only"> {column.total === 1 ? 'plan' : 'plans'}</span>
          </span>
        )}
      </div>
      {column.isPending ? <ColumnLoading />
        : column.error ? <ErrorState error={column.error} onRetry={column.retry} className="p-s4" />
        : column.rows.length === 0 ? <EmptyState title={q === null ? `No ${heading.toLowerCase()} plans.` : 'None match.'} className="py-s2 t-small" />
        : (
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
              <ShowMore shown={column.rows.length} total={column.total} noun={column.rows.length === 1 ? 'plan' : 'plans'} onMore={column.more} pending={column.isFetchingMore} hasMore />
            )}
          </>
        )}
    </section>
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
  /** The project across projects, and when it was last edited. */
  meta: ReadonlyArray<string | null>;
  progress?: PlanBoardRow['progress'];
}

/** One plan on the board: its title opens its page, the line beneath says where and when, and the session that wrote it is one link away. */
function PlanCard({ projectId, planKey, sessionId, title, meta, progress }: PlanCardProps) {
  const parts = progress === undefined ? null : progressParts(progress);
  const words = progress === undefined ? null : progressWords(progress);
  const facts = meta.filter((part): part is string => part !== null);
  return (
    <li className="relative flex flex-col gap-s2 rounded-control border border-line bg-surface-2 px-s3 py-s3 transition-colors duration-120 hover:border-line-strong" data-plan="">
      <RouterLink
        to={planPagePath(projectId, { planKey })}
        className={cn('line-clamp-3 break-words rounded-chip t-small font-medium text-ink after:absolute after:inset-0 after:rounded-control', focusRing)}
      >
        {title}
      </RouterLink>
      {parts !== null && words !== null && (
        <div className="flex flex-col gap-s1">
          <Progress done={parts.checked} total={parts.total} label="Plan items done" />
          <span className="t-meta text-muted">{words}</span>
        </div>
      )}
      {facts.length > 0 && (
        <p className="flex flex-col t-meta text-muted">
          {facts.map((fact) => <span key={fact} className="truncate whitespace-nowrap">{fact}</span>)}
        </p>
      )}
      {sessionId !== null && (
        <RouterLink
          to={projectPath(projectId, `/sessions/${encodeURIComponent(sessionId)}`)}
          className={cn(tapTarget, 'relative z-10 w-fit gap-s1 rounded-chip t-meta font-medium text-primary hover:underline', focusRing)}
          aria-label={`The session that wrote “${title}”`}
        >
          Its session
          <ArrowUpRight aria-hidden className="size-s3" />
        </RouterLink>
      )}
    </li>
  );
}
