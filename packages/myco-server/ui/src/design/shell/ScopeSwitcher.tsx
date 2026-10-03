import { useId, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/cn';
import { overlaySurface } from '../lib/classes';
import { Button } from '../primitives/Button';
import { HealthDot, type HealthTone } from '../primitives/HealthDot';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

/** How many projects the list shows at once; the rest are a page away, so the menu never needs to scroll. */
export const SCOPE_PAGE = 6;

/** Recency in one dot: active within the hour, today, or quiet. */
export function recencyOf(lastActivityAt: number | null, now: number): { tone: HealthTone; label: string } {
  if (lastActivityAt === null) return { tone: 'faint', label: 'No sessions yet' };
  const age = now - lastActivityAt;
  if (age < HOUR_MS) return { tone: 'ok', label: 'Active in the last hour' };
  if (age < DAY_MS) return { tone: 'ok', label: 'Active today' };
  return { tone: 'faint', label: 'No activity today' };
}

export interface ScopeProject {
  projectId: string;
  name: string;
  sessionCount: number;
  /** Epoch milliseconds of the project's last captured activity, or null for none. */
  lastActivityAt: number | null;
  /** Where picking it leads; absent when picking it calls `onPick` instead. */
  href?: string;
  /** The scope the control shows now. */
  active: boolean;
}

/**
 * "All projects" in the list: where it leads, whether it is the scope now, and,
 * from a record, that taking it leaves the record; or why this page has no such
 * scope.
 */
export type ScopeAll = { href: string; active: boolean; leaves?: string } | { reason: string };

export interface ScopeSwitcherProps {
  /** The control's accessible name. */
  label: string;
  /** The scope in words: "All projects", a project's name, or what to do while nothing is chosen. */
  current: string;
  projects: readonly ScopeProject[];
  /** The all-projects row, or null where the list offers only projects. */
  all: ScopeAll | null;
  /** Called with the project picked, for a row with no `href`. */
  onPick?: (projectId: string) => void;
  /** A last row leading to every project in detail. */
  more?: { href: string; label: string };
  now?: number;
  className?: string;
}

/** The pages of the list, the current project kept on the first so the scope is always one look away. */
export function scopePages<T extends { active: boolean }>(items: readonly T[], size = SCOPE_PAGE): T[][] {
  const active = items.find((item) => item.active);
  const head = items.slice(0, size);
  const ordered = active === undefined || head.includes(active) ? [...items] : [...head.slice(0, size - 1), active, ...items.filter((item) => item !== active && !head.slice(0, size - 1).includes(item))];
  const pages: T[][] = [];
  for (let at = 0; at < ordered.length; at += size) pages.push(ordered.slice(at, at + size));
  return pages.length === 0 ? [[]] : pages;
}

const row = 'flex min-h-tap cursor-default select-none items-center gap-s3 rounded-chip px-s3 py-s2 t-control text-ink-2 outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink';
const ALL = '\u0000all';

/**
 * Which projects a page shows, said in plain words on its trigger, and the one
 * place to change it: "All projects" first, where the page has that form, then
 * the projects with their session counts, most recent first, a page at a time.
 * Each is a radio choice; picking one keeps the page and swaps its scope.
 */
export function ScopeSwitcher({ label, current, projects, all, onPick, more, now = Date.now(), className }: ScopeSwitcherProps) {
  const navigate = useNavigate();
  const reasonId = useId();
  const [page, setPage] = useState(0);
  const pages = scopePages(projects);
  const shown = pages[Math.min(page, pages.length - 1)]!;
  const allActive = all !== null && 'href' in all && all.active;
  const scope = allActive ? 'all' : projects.some((project) => project.active) ? 'project' : 'none';
  const value = allActive ? ALL : projects.find((project) => project.active)?.projectId ?? '';
  const choose = (chosen: string) => {
    if (chosen === ALL) { if (all !== null && 'href' in all) navigate(all.href); return; }
    const project = projects.find((candidate) => candidate.projectId === chosen);
    if (project === undefined) return;
    if (project.href !== undefined) navigate(project.href);
    else onPick?.(project.projectId);
  };
  const reason = all !== null && 'reason' in all ? all.reason : null;
  return (
    <Menu.Root onOpenChange={(open) => { if (!open) setPage(0); }}>
      <Menu.Trigger asChild>
        <Button
          variant="secondary"
          size="sm"
          icon={<FolderOpen aria-hidden className="size-s4 text-muted" />}
          aria-label={`${label}: ${current}`}
          data-scope-switcher={scope}
          className={cn('max-w-full', className)}
        >
          <span className="min-w-0 truncate" data-scope-current="">{current}</span>
          <ChevronDown aria-hidden className="size-s4 shrink-0 text-muted" />
        </Button>
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Content
          align="start"
          sideOffset={4}
          aria-describedby={reason === null ? undefined : reasonId}
          className={cn(overlaySurface, 'z-50 flex w-[min(320px,calc(100vw-var(--s-8)))] flex-col p-s1')}
          data-scope-list=""
        >
          {reason !== null && <p id={reasonId} className="px-s3 py-s2 t-small text-muted" data-scope-all-reason="">{reason}</p>}
          <Menu.RadioGroup value={value} onValueChange={choose}>
            {all !== null && 'href' in all && (
              <>
                <Menu.RadioItem value={ALL} className={cn(row, all.active && 'font-medium text-ink')} data-scope-option="all">
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate">All projects</span>
                    {all.leaves !== undefined && <span className="t-meta text-muted" data-scope-leaves="">{all.leaves}</span>}
                  </span>
                  <Menu.ItemIndicator><Check aria-hidden className="size-s4 shrink-0 text-primary" /></Menu.ItemIndicator>
                </Menu.RadioItem>
                <Menu.Separator className="my-s1 h-px bg-line" />
              </>
            )}
            <Menu.Label className="flex items-center justify-between px-s3 pb-s1 t-kicker text-faint">
              <span>Projects</span>
              <span aria-hidden>Sessions</span>
            </Menu.Label>
            {projects.length === 0 && <p className="px-s3 py-s2 t-small text-muted">No projects yet.</p>}
            {shown.map((project) => {
              const recency = recencyOf(project.lastActivityAt, now);
              const sessions = `${project.sessionCount.toLocaleString()} ${project.sessionCount === 1 ? 'session' : 'sessions'}`;
              return (
                <Menu.RadioItem
                  key={project.projectId}
                  value={project.projectId}
                  className={cn(row, project.active && 'font-medium text-ink')}
                  data-scope-option="project"
                  data-tone={recency.tone}
                >
                  <span aria-hidden className="inline-flex" title={recency.label}><HealthDot tone={recency.tone} label={recency.label} /></span>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {project.active
                    ? <Check aria-hidden className="size-s4 shrink-0 text-primary" />
                    : <span aria-hidden className="shrink-0 t-meta tabular-nums text-faint">{project.sessionCount.toLocaleString()}</span>}
                  <span className="sr-only" data-scope-recency="">{`, ${sessions}, ${recency.label.toLowerCase()}`}</span>
                </Menu.RadioItem>
              );
            })}
          </Menu.RadioGroup>
          {pages.length > 1 && (
            <Menu.Item
              className={cn(row, 't-small text-muted')}
              onSelect={(event) => { event.preventDefault(); setPage((at) => (at + 1) % pages.length); }}
              data-scope-page=""
            >
              {page + 1 < pages.length
                ? `More projects (${(projects.length - (page + 1) * SCOPE_PAGE).toLocaleString()} more)`
                : 'Back to the most recent'}
            </Menu.Item>
          )}
          {more !== undefined && (
            <>
              <Menu.Separator className="my-s1 h-px bg-line" />
              <Menu.Item className={cn(row, 't-small text-muted')} onSelect={() => navigate(more.href)} data-scope-more="">{more.label}</Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
