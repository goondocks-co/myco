import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useGroves } from '../hooks/use-groves';
import { useProjectsActivity } from '../hooks/use-maintenance-summary';
import { useProjectSelection } from '../hooks/use-project-selection';
import {
  colorForProjectId,
  monogramFor,
  projectPath,
  projectRouteSuffix,
  selectionFromLast,
  type GroveProjectSummary,
  type GroveSummary,
  type ProjectSelection,
} from '../lib/selection';
import { formatTimeAgo } from '../lib/format';
import { cn } from '../lib/cn';

export function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const contextSelection = useProjectSelection();
  const { data } = useGroves();
  const { data: activity } = useProjectsActivity();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groves = data?.groves ?? [];
  const projectCount = groves.reduce((total, grove) => total + grove.projects.length, 0);
  const rememberedSelection = useMemo(
    () => (contextSelection ? null : selectionFromLast(groves)),
    [contextSelection, groves],
  );
  const selection = contextSelection ?? rememberedSelection;

  // Per-project last-activity (ISO string) — used to surface recently-worked
  // projects at the top so the list stays scannable as auto-registration
  // accumulates projects.
  const lastActivityById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of activity?.projects ?? []) m.set(p.project_id, p.last_activity_at);
    return m;
  }, [activity]);

  const activityMs = (projectId: string): number => {
    const iso = lastActivityById.get(projectId);
    return iso ? Date.parse(iso) : 0;
  };

  const displayGroves = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const byRecency = (a: GroveProjectSummary, b: GroveProjectSummary) =>
      activityMs(b.project_id) - activityMs(a.project_id);
    return groves
      .map((grove) => {
        const projects = needle
          ? grove.projects.filter((project) =>
              `${grove.name} ${project.name}`.toLowerCase().includes(needle))
          : grove.projects;
        return { ...grove, projects: [...projects].sort(byRecency) };
      })
      .filter((grove) => grove.projects.length > 0 || !needle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [groves, query, lastActivityById]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  if (!selection) {
    return (
      <button
        type="button"
        onClick={() => navigate('/groves')}
        className={cn(
          'flex w-full items-center rounded-md text-sm text-on-surface-variant transition-colors hover:bg-surface-container-high hover:text-on-surface',
          collapsed ? 'justify-center px-2 py-2' : 'gap-3 px-3 py-2',
        )}
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary/15 text-xs font-semibold text-primary">
          M
        </span>
        {!collapsed && <span className="truncate">Select project</span>}
      </button>
    );
  }

  const currentColor = colorForProjectId(selection.project.project_id);
  const canSwitch = projectCount > 1;

  const selectProject = (grove: GroveSummary, project: GroveProjectSummary) => {
    const next: ProjectSelection = { grove, project };
    const suffix = projectRouteSuffix(location.pathname);
    navigate(projectPath(next, suffix));
    setOpen(false);
    setQuery('');
  };

  return (
    <div ref={menuRef} className="relative px-2 pb-2">
      <button
        type="button"
        onClick={() => canSwitch && setOpen((value) => !value)}
        title={collapsed ? selection.project.name : undefined}
        className={cn(
          'flex w-full items-center rounded-md text-sm transition-colors',
          canSwitch ? 'hover:bg-surface-container-high' : 'cursor-default',
          collapsed ? 'justify-center px-0 py-1.5' : 'gap-2 px-2 py-2 text-left',
        )}
      >
        <ProjectAvatar project={selection.project} color={currentColor} />
        {!collapsed && (
          <>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-on-surface">{selection.project.name}</span>
              <span className="block truncate text-[11px] text-on-surface-variant">{selection.grove.name}</span>
            </span>
            {canSwitch && <ChevronDown className="h-4 w-4 text-on-surface-variant" />}
          </>
        )}
      </button>

      {open && (
        <div className="absolute left-2 top-full z-50 mt-1 w-72 rounded-md border border-outline-variant/30 bg-surface-container-high p-2 shadow-lg">
          <label className="flex items-center gap-2 rounded-md border border-outline-variant/30 bg-surface px-2 py-1.5 text-sm">
            <Search className="h-4 w-4 text-on-surface-variant" />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
              placeholder="Find project"
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-on-surface-variant"
            />
          </label>
          <div className="mt-2 max-h-80 overflow-auto">
            {displayGroves.map((grove) => (
              <div key={grove.id} className="py-1">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                  {grove.name}
                </div>
                {grove.projects.map((project) => {
                  const active = selection.grove.id === grove.id
                    && selection.project.project_id === project.project_id;
                  const lastActivity = lastActivityById.get(project.project_id);
                  return (
                    <button
                      key={project.project_id}
                      type="button"
                      onClick={() => selectProject(grove, project)}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-sm transition-colors',
                        active
                          ? 'bg-primary/10 text-primary'
                          : 'text-on-surface hover:bg-surface-container',
                      )}
                    >
                      <ProjectAvatar project={project} color={colorForProjectId(project.project_id)} />
                      <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      {active ? (
                        <Check className="h-4 w-4 shrink-0" />
                      ) : lastActivity ? (
                        <span className="shrink-0 text-[10px] text-on-surface-variant">{formatTimeAgo(lastActivity)}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ProjectAvatar({ project, color }: { project: GroveProjectSummary; color: string }) {
  return (
    <span
      className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
      style={{ backgroundColor: color }}
      aria-hidden="true"
    >
      {monogramFor(project.name)}
    </span>
  );
}
