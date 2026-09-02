import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { isArchived, type ProjectSummary } from '../lib/api';
import { cn } from '../lib/cn';
import { formatRelative } from '../lib/format';
import { colorForProjectId, monogramFor } from '../lib/monogram';
import { rememberProject } from '../lib/project-memory';
import { Badge } from './ui/badge';

/** Shows the search box once the list is long enough to need one. */
const SEARCH_FROM = 6;

/** The page under a project the visitor is on — `/sessions`, `/runs` — so switching projects lands on the same page of the next one. */
export function projectRouteSuffix(pathname: string): string {
  const match = /^\/p\/[^/]+(?:\/([^/]+))?/.exec(pathname);
  const section = match?.[1] ?? '';
  return section === '' ? '' : `/${section}`;
}

function ProjectAvatar({ project }: { project: Pick<ProjectSummary, 'projectId' | 'name'> }) {
  return (
    <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white" style={{ backgroundColor: colorForProjectId(project.projectId) }} aria-hidden="true">
      {monogramFor(project.name)}
    </span>
  );
}

export interface ProjectSwitcherProps {
  projects: ProjectSummary[];
  current?: ProjectSummary;
}

/** The sidebar's project picker: the current project's monogram and name, and a popover listing every live project by recent activity, searchable when long. Focus returns to the picker when the popover closes. */
export function ProjectSwitcher({ projects, current }: ProjectSwitcherProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const menu = useRef<HTMLDivElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);

  const live = useMemo(() => projects.filter((p) => !isArchived(p) || p.projectId === current?.projectId), [projects, current?.projectId]);
  const listed = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return live
      .filter((p) => needle === '' || p.name.toLowerCase().includes(needle))
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }, [live, query]);

  const close = () => {
    setOpen(false);
    setQuery('');
    trigger.current?.focus();
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => { if (!menu.current?.contains(event.target as Node)) close(); };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const choose = (project: ProjectSummary) => {
    rememberProject(project.projectId);
    navigate(`/p/${encodeURIComponent(project.projectId)}${projectRouteSuffix(location.pathname)}`);
    close();
  };

  if (current === undefined) {
    return (
      <button type="button" onClick={() => navigate('/projects')} className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left font-sans text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-xs font-semibold text-primary" aria-hidden="true">M</span>
        <span className="truncate">Choose a project</span>
      </button>
    );
  }

  return (
    <div ref={menu} className="relative" onKeyDown={(e) => { if (e.key === 'Escape' && open) { e.stopPropagation(); close(); } }}>
      <button
        ref={trigger}
        type="button"
        aria-label="Project"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => (open ? close() : setOpen(true))}
        className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left font-sans text-sm transition-colors hover:bg-surface-container-high"
      >
        <ProjectAvatar project={current} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-on-surface">{current.name}</span>
          <span className="block truncate text-[11px] text-on-surface-variant">{isArchived(current) ? 'Archived' : `${current.sessionCount.toLocaleString()} session${current.sessionCount === 1 ? '' : 's'}`}</span>
        </span>
        <ChevronDown className="h-4 w-4 shrink-0 text-on-surface-variant" />
      </button>

      {open && (
        <div role="dialog" aria-label="Choose a project" className="absolute left-0 top-full z-50 mt-1 w-72 rounded-md border border-outline-variant/30 bg-surface-container-high p-2 shadow-lg">
          {live.length >= SEARCH_FROM && (
            <label className="flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface px-2 py-1.5 text-sm">
              <Search className="h-4 w-4 text-on-surface-variant" />
              <input value={query} onChange={(e) => setQuery(e.target.value)} autoFocus placeholder="Find a project" aria-label="Find a project" className="min-w-0 flex-1 bg-transparent font-sans text-sm text-on-surface outline-none placeholder:text-on-surface-variant" />
            </label>
          )}
          <div role="listbox" aria-label="Projects" className="mt-1 max-h-80 overflow-auto">
            {listed.map((project) => {
              const active = project.projectId === current.projectId;
              return (
                <button
                  key={project.projectId}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => choose(project)}
                  className={cn('flex w-full items-center gap-2 rounded-md px-2 py-2 text-left font-sans text-sm transition-colors', active ? 'bg-primary/10 text-primary' : 'text-on-surface hover:bg-surface-container')}
                >
                  <ProjectAvatar project={project} />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  {isArchived(project) && <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-[10px]">Archived</Badge>}
                  {active ? <Check className="h-4 w-4 shrink-0" /> : project.lastActivityAt !== null ? <span className="shrink-0 text-[10px] text-on-surface-variant">{formatRelative(project.lastActivityAt)}</span> : null}
                </button>
              );
            })}
            {listed.length === 0 && <p className="m-0 px-2 py-2 font-sans text-xs text-on-surface-variant">No project matches.</p>}
          </div>
          <button type="button" onClick={() => { close(); navigate('/projects'); }} className="mt-1 w-full rounded-md px-2 py-1.5 text-left font-sans text-xs text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface">All projects…</button>
        </div>
      )}
    </div>
  );
}
