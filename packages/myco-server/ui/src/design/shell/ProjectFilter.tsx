import { Link as RouterLink } from 'react-router-dom';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing } from '../lib/classes';
import { HealthDot, type HealthTone } from '../primitives/HealthDot';

/** How many projects the filter lists before the rest move behind "N more". */
export const PROJECT_FILTER_LIMIT = 8;

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

export interface ProjectFilterItem {
  projectId: string;
  name: string;
  sessionCount: number;
  /** Epoch milliseconds of the project's last captured activity, or null for none. */
  lastActivityAt: number | null;
  /** Where picking this project leads: the same page, narrowed to it. */
  href: string;
  /** The project every page is narrowed to now; picking it again clears the filter, where the page allows. */
  active: boolean;
}

export interface ProjectFilterProps {
  /** The projects to list, most recent first; the filter shows the first eight and keeps the active one among them. */
  items: readonly ProjectFilterItem[];
  /** Where clearing the filter leads, or null on a page with no all-projects form, where the filter cannot be cleared. */
  clearHref: string | null;
  /** Every project, listed with more detail. */
  allHref: string;
  onNavigate?: () => void;
  now?: number;
}

/** Recency in one dot: active within the hour, today, or quiet. */
export function recencyOf(lastActivityAt: number | null, now: number): { tone: HealthTone; label: string } {
  if (lastActivityAt === null) return { tone: 'faint', label: 'No sessions yet' };
  const age = now - lastActivityAt;
  if (age < HOUR_MS) return { tone: 'ok', label: 'Active in the last hour' };
  if (age < DAY_MS) return { tone: 'ok', label: 'Active today' };
  return { tone: 'faint', label: 'No activity today' };
}

/** The first `limit` items, keeping the active one among them when it would fall past the end. */
export function shownProjects<T extends { active: boolean }>(items: readonly T[], limit = PROJECT_FILTER_LIMIT): T[] {
  const head = items.slice(0, limit);
  const active = items.find((item) => item.active);
  if (active === undefined || head.includes(active)) return head;
  return [...head.slice(0, limit - 1), active];
}

/**
 * The nav's project list. Each project reads as a filter: picking one narrows
 * every page to it, and on a page with an all-projects form picking it again
 * shows every project. The eight most recent are listed with their session
 * counts; the rest are one link away.
 */
export function ProjectFilter({ items, clearHref, allHref, onNavigate, now = Date.now() }: ProjectFilterProps) {
  const shown = shownProjects(items);
  const hidden = items.length - shown.length;
  return (
    <nav aria-label="Projects" className="flex min-h-0 flex-1 flex-col gap-[1px]">
      <div className="flex shrink-0 items-center justify-between px-s3 pb-s2 t-kicker text-faint">
        <span>Projects</span>
        <span aria-hidden>Sessions</span>
      </div>
      {items.length === 0 && <p className="px-s3 t-small text-muted">No projects yet.</p>}
      <ul className="-m-[3px] flex min-h-0 flex-col gap-[1px] overflow-y-auto p-[3px]">
        {shown.map((item) => {
          const recency = recencyOf(item.lastActivityAt, now);
          const clears = item.active && clearHref !== null;
          return (
            <li key={item.projectId}>
              <RouterLink
                to={clears ? clearHref : item.href}
                onClick={onNavigate}
                aria-current={item.active ? 'true' : undefined}
                title={clears ? 'Show every project' : item.active ? `Showing only ${item.name}` : `Show only ${item.name}`}
                data-project-filter-item=""
                className={cn(
                  'group flex h-s8 items-center gap-s3 rounded-control px-s3 t-control transition-colors duration-120',
                  item.active ? 'bg-primary-bg font-medium text-ink' : 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                  focusRing,
                )}
              >
                <HealthDot tone={recency.tone} label={recency.label} />
                <span className="min-w-0 flex-1 truncate">{item.name}</span>
                {clears
                  ? <><X aria-hidden data-clear-filter="" className="size-s4 shrink-0 text-muted group-hover:text-ink" /><span className="sr-only">Clear the filter</span></>
                  : (
                    <span className="shrink-0 t-meta tabular-nums text-faint">
                      <span aria-hidden>{item.sessionCount.toLocaleString()}</span>
                      <span className="sr-only">{`${item.sessionCount.toLocaleString()} ${item.sessionCount === 1 ? 'session' : 'sessions'}`}</span>
                    </span>
                  )}
              </RouterLink>
            </li>
          );
        })}
      </ul>
      {items.length > 0 && (
        <RouterLink
          to={allHref}
          onClick={onNavigate}
          className={cn('flex h-s8 shrink-0 items-center rounded-control px-s3 t-small text-muted transition-colors duration-120 hover:bg-surface-2 hover:text-ink', focusRing)}
        >
          {hidden > 0 ? `${hidden} more` : 'All projects'}
        </RouterLink>
      )}
    </nav>
  );
}
