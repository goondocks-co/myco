import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useGroves } from '../hooks/use-groves';
import { useProjectSelection } from '../hooks/use-project-selection';
import {
  colorForProjectId,
  monogramFor,
  projectPath,
  projectRouteSuffix,
  type GroveProjectSummary,
  type GroveSummary,
  type ProjectSelection,
} from '../lib/selection';
import { cn } from '../lib/cn';

export function ProjectSwitcher({ collapsed = false }: { collapsed?: boolean }) {
  const selection = useProjectSelection();
  const { data } = useGroves();
  const navigate = useNavigate();
  const location = useLocation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const menuRef = useRef<HTMLDivElement | null>(null);
  const groves = data?.groves ?? [];
  const projectCount = groves.reduce((total, grove) => total + grove.projects.length, 0);

  const filteredGroves = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groves;
    return groves
      .map((grove) => ({
        ...grove,
        projects: grove.projects.filter((project) =>
          `${grove.name} ${project.name}`.toLowerCase().includes(needle),
        ),
      }))
      .filter((grove) => grove.projects.length > 0);
  }, [groves, query]);

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
            {filteredGroves.map((grove) => (
              <div key={grove.id} className="py-1">
                <div className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-on-surface-variant">
                  {grove.name}
                </div>
                {grove.projects.map((project) => {
                  const active = selection.grove.id === grove.id
                    && selection.project.project_id === project.project_id;
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
                      {active && <Check className="h-4 w-4" />}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={() => {
              navigate('/groves');
              setOpen(false);
            }}
            className="mt-1 w-full rounded-md px-2 py-2 text-left text-xs text-on-surface-variant transition-colors hover:bg-surface-container hover:text-on-surface"
          >
            Manage Groves
          </button>
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
