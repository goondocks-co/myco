import { Link as RouterLink } from 'react-router-dom';
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check, ChevronDown, FolderOpen } from 'lucide-react';
import { cn } from '../../lib/cn';
import { focusRing, overlaySurface } from '../lib/classes';
import { Button } from '../primitives/Button';
import { HealthDot, type HealthTone } from '../primitives/HealthDot';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

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

/** "All projects" in the list: where it leads and whether it is the scope now, or why this page has no such scope. */
export type ScopeAll = { href: string; active: boolean } | { reason: string };

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

const row = 'flex min-h-tap cursor-default select-none items-center gap-s3 rounded-chip px-s3 py-s2 t-control text-ink-2 outline-none data-[highlighted]:bg-surface-3 data-[highlighted]:text-ink';

/**
 * Which projects a page shows, said in plain words on its trigger, and the one
 * place to change it: "All projects" first, where the page has that form, then
 * every project with its session count, most recent first. Picking one keeps
 * the page and swaps its scope.
 */
export function ScopeSwitcher({ label, current, projects, all, onPick, more, now = Date.now(), className }: ScopeSwitcherProps) {
  const scope = all !== null && 'href' in all && all.active ? 'all' : projects.some((project) => project.active) ? 'project' : 'none';
  return (
    <Menu.Root>
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
          aria-label={label}
          className={cn(overlaySurface, 'z-50 flex max-h-[min(480px,var(--radix-dropdown-menu-content-available-height,70vh))] w-[min(320px,calc(100vw-var(--s-8)))] flex-col overflow-hidden p-s1')}
          data-scope-list=""
        >
          {all !== null && ('href' in all ? (
            <Menu.Item asChild>
              <RouterLink to={all.href} aria-current={all.active ? 'true' : undefined} className={cn(row, all.active && 'font-medium text-ink')} data-scope-option="all">
                <span className="min-w-0 flex-1 truncate">All projects</span>
                {all.active && <Check aria-hidden className="size-s4 shrink-0 text-primary" />}
              </RouterLink>
            </Menu.Item>
          ) : (
            <p className="px-s3 py-s2 t-small text-muted" data-scope-all-reason="">{all.reason}</p>
          ))}
          {all !== null && <Menu.Separator className="my-s1 h-px bg-line" />}
          <div className="flex items-center justify-between px-s3 pb-s1 t-kicker text-faint" aria-hidden>
            <span>Projects</span>
            <span>Sessions</span>
          </div>
          {projects.length === 0 && <p className="px-s3 py-s2 t-small text-muted">No projects yet.</p>}
          {/* A long list scrolls inside the menu; the region takes focus so a keyboard can scroll it too. */}
          <div role="group" aria-label="Projects" tabIndex={0} className={cn('-m-[3px] flex min-h-0 flex-col overflow-y-auto rounded-chip p-[3px]', focusRing)} data-scope-projects="">
            {projects.map((project) => {
              const recency = recencyOf(project.lastActivityAt, now);
              const sessions = `${project.sessionCount.toLocaleString()} ${project.sessionCount === 1 ? 'session' : 'sessions'}`;
              const body = (
                <>
                  <span aria-hidden className="inline-flex" title={recency.label}><HealthDot tone={recency.tone} label={recency.label} /></span>
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {project.active
                    ? <Check aria-hidden className="size-s4 shrink-0 text-primary" />
                    : <span aria-hidden className="shrink-0 t-meta tabular-nums text-faint">{project.sessionCount.toLocaleString()}</span>}
                  <span className="sr-only" data-scope-recency="">{`, ${sessions}, ${recency.label.toLowerCase()}`}</span>
                </>
              );
              const shared = { 'aria-current': project.active ? 'true' as const : undefined, 'data-scope-option': 'project', 'data-tone': recency.tone, className: cn(row, project.active && 'font-medium text-ink') };
              return project.href !== undefined ? (
                <Menu.Item key={project.projectId} asChild>
                  <RouterLink to={project.href} {...shared}>{body}</RouterLink>
                </Menu.Item>
              ) : (
                <Menu.Item key={project.projectId} onSelect={() => onPick?.(project.projectId)} {...shared}>{body}</Menu.Item>
              );
            })}
          </div>
          {more !== undefined && (
            <>
              <Menu.Separator className="my-s1 h-px bg-line" />
              <Menu.Item asChild>
                <RouterLink to={more.href} className={cn(row, 't-small text-muted')}>{more.label}</RouterLink>
              </Menu.Item>
            </>
          )}
        </Menu.Content>
      </Menu.Portal>
    </Menu.Root>
  );
}
