import { useEffect, useMemo, useState } from 'react';
import { Plus, Search } from 'lucide-react';
import { useNavigate, useSearchParams, NavLink } from 'react-router-dom';
import { useGroves } from '../hooks/use-groves';
import { useProjectsActivity } from '../hooks/use-maintenance-summary';
import { formatTimeAgo } from '../lib/format';
import {
  useArchiveProject,
  useSetDefaultGrove,
  useUnarchiveProject,
} from '../hooks/use-grove-mutations';
import {
  colorForProjectId,
  monogramFor,
  projectPath,
  type GroveSummary,
  type GroveProjectSummary,
} from '../lib/selection';
import { buildCapabilityBadges } from '../lib/capability-badges';
import type { CapabilityId } from '@myco/config/scope';
import { CapabilityChipVisual } from '../components/symbionts/CapabilityChip';
import { PageLoading } from '../components/ui/page-loading';
import { PageContainer } from '../components/ui/page-container';
import { Panel } from '../components/ui/panel';
import { Row } from '../components/ui/row';
import { Eyebrow } from '../components/ui/eyebrow';
import { Badge } from '../components/ui/badge';
import { Button } from '../components/ui/button';
import { GroveActionMenu } from '../components/groves/GroveActionMenu';
import { ProjectActionMenu } from '../components/groves/ProjectActionMenu';
import { NewGroveModal } from '../components/groves/NewGroveModal';
import { RenameGroveModal } from '../components/groves/RenameGroveModal';
import { DeleteGroveModal } from '../components/groves/DeleteGroveModal';
import { MoveProjectModal } from '../components/groves/MoveProjectModal';
import { DeleteProjectModal } from '../components/groves/DeleteProjectModal';
import { CapabilityPanel } from '../components/groves/CapabilityPanel';
import { showToast } from '../components/groves/toast';
import { useMachineConfig, useAddToMachineConfigList } from '../hooks/use-machine-config';

interface MoveTarget {
  grove: GroveSummary;
  project: GroveProjectSummary;
}

type CapabilityTarget = MoveTarget;

export default function Groves() {
  const navigate = useNavigate();
  const setDefaultGrove = useSetDefaultGrove();
  const archiveProject = useArchiveProject();
  const unarchiveProject = useUnarchiveProject();
  const machineConfig = useMachineConfig();
  const addToMachineConfigList = useAddToMachineConfigList();

  const [newOpen, setNewOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<GroveSummary | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<GroveSummary | null>(null);
  const [moveTarget, setMoveTarget] = useState<MoveTarget | null>(null);
  const [deleteProjectTarget, setDeleteProjectTarget] = useState<MoveTarget | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);
  const [search, setSearch] = useState('');
  const [capabilityTarget, setCapabilityTarget] = useState<CapabilityTarget | null>(null);

  const archiveAwareQuery = useGroves({ includeArchived });
  const groves = archiveAwareQuery.data?.groves ?? [];

  // Deep link from a section page's CapabilityIndicator:
  // /groves?capabilities=<project_id> opens the capability panel for that
  // project as soon as the groves list resolves. The param is consumed
  // (replaced away) so closing the panel doesn't reopen it.
  const [searchParams, setSearchParams] = useSearchParams();
  const capabilitiesParam = searchParams.get('capabilities');
  useEffect(() => {
    if (!capabilitiesParam || groves.length === 0) return;
    for (const grove of groves) {
      const project = grove.projects?.find((p) => p.project_id === capabilitiesParam);
      if (project) {
        setCapabilityTarget({ grove, project });
        break;
      }
    }
    setSearchParams((params) => {
      params.delete('capabilities');
      return params;
    }, { replace: true });
  }, [capabilitiesParam, groves, setSearchParams]);

  // Per-project last-activity, so the list sorts most-recently-worked first
  // and stays scannable as auto-registration accumulates projects.
  const { data: activity } = useProjectsActivity();
  const lastActivityById = useMemo(() => {
    const m = new Map<string, string | null>();
    for (const p of activity?.projects ?? []) m.set(p.project_id, p.last_activity_at);
    return m;
  }, [activity]);

  const activityMs = (projectId: string): number => {
    const iso = lastActivityById.get(projectId);
    return iso ? Date.parse(iso) : 0;
  };

  /** Search-filtered + recency-sorted projects for a grove. */
  const visibleProjects = (grove: GroveSummary): GroveProjectSummary[] => {
    const needle = search.trim().toLowerCase();
    const filtered = needle
      ? grove.projects.filter((p) => `${p.name} ${p.root ?? ''}`.toLowerCase().includes(needle))
      : grove.projects;
    return [...filtered].sort((a, b) => activityMs(b.project_id) - activityMs(a.project_id));
  };
  const searching = search.trim().length > 0;

  function handleArchive(grove: GroveSummary, project: GroveProjectSummary) {
    archiveProject.mutate(
      { groveId: grove.id, projectId: project.project_id },
      {
        onSuccess: () => showToast({ level: 'success', title: 'Project archived', detail: project.name }),
        onError: (err) => showToast({ level: 'error', title: 'Archive failed', detail: err.message }),
      },
    );
  }

  function handleUnarchive(grove: GroveSummary, project: GroveProjectSummary) {
    unarchiveProject.mutate(
      { groveId: grove.id, projectId: project.project_id },
      {
        onSuccess: () => showToast({ level: 'success', title: 'Project unarchived', detail: project.name }),
        onError: (err) => showToast({ level: 'error', title: 'Unarchive failed', detail: err.message }),
      },
    );
  }

  function handleSetDefault(grove: GroveSummary) {
    setDefaultGrove.mutate(
      { id: grove.id },
      {
        onSuccess: () => {
          showToast({ level: 'success', title: `${grove.name} is now the default Grove` });
        },
        onError: (err) => {
          showToast({ level: 'error', title: 'Failed to set default', detail: err.message });
        },
      },
    );
  }

  function handleIgnore(grove: GroveSummary, project: GroveProjectSummary) {
    // Ignore is menu-gated to non-attached rows (ProjectActionMenu is only
    // rendered for `!project.attached` below) since an attached project has
    // no local checkout path to ignore and its Grove state is host-owned. A
    // non-attached (local) project's `root` is never legitimately absent
    // (`RegisteredProject.root` is a required string) — this null-check is a
    // defensive backstop for the shared nullable type, not the gate itself.
    if (!project.root) return;
    const existing = machineConfig.data?.config.capture?.ignore?.paths ?? [];
    if (existing.includes(project.root)) { handleArchive(grove, project); return; }
    addToMachineConfigList.mutate(
      { path: 'capture.ignore.paths', value: project.root },
      {
        onSuccess: () => handleArchive(grove, project),
        onError: (err) => showToast({ level: 'error', title: 'Ignore failed', detail: err.message }),
      },
    );
  }

  return (
    <PageLoading isLoading={archiveAwareQuery.isLoading} error={archiveAwareQuery.error} loadingText="Loading Groves...">
      <PageContainer>
        <header className="flex items-end justify-between gap-4 flex-wrap">
          <div className="flex flex-col gap-1 min-w-0">
            <Eyebrow>Grove management</Eyebrow>
            <h1 className="myco-display-lg text-on-surface m-0">Groves</h1>
            <p className="font-sans text-sm text-on-surface-variant m-0">
              Registered local Grove projects for this daemon.
            </p>
          </div>
          <Button size="sm" onClick={() => setNewOpen(true)} className="gap-1.5">
            <Plus className="h-4 w-4" />
            New Grove
          </Button>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <label className="flex w-full max-w-xs items-center gap-2 rounded-md border border-outline-variant/30 bg-surface px-2 py-1.5 text-sm">
            <Search className="h-4 w-4 text-on-surface-variant" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search projects by name or path"
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-on-surface-variant"
            />
          </label>
          <label className="flex items-center gap-2 text-sm text-on-surface-variant">
            <input
              type="checkbox"
              checked={includeArchived}
              onChange={(event) => setIncludeArchived(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Show archived projects
          </label>
        </div>

        <div className="flex flex-col gap-4">
          {groves.map((grove) => {
            const projects = visibleProjects(grove);
            // When searching, hide Groves that have no matching projects.
            if (searching && projects.length === 0) return null;
            return (
            <Panel
              key={grove.id}
              tone="sage"
              eyebrow="Grove"
              title={grove.name}
              actions={
                <div className="flex items-center gap-2">
                  {grove.is_default && <Badge variant="outline">default</Badge>}
                  <span className="font-mono text-[11px] text-on-surface-variant">
                    {searching
                      ? `${projects.length} of ${grove.project_count}`
                      : `${grove.project_count} project${grove.project_count === 1 ? '' : 's'}`}
                  </span>
                  <GroveActionMenu
                    groveName={grove.name}
                    projectCount={grove.project_count}
                    isDefault={grove.is_default}
                    onRename={() => setRenameTarget(grove)}
                    onDelete={() => setDeleteTarget(grove)}
                    onSetDefault={() => handleSetDefault(grove)}
                  />
                </div>
              }
              padded={false}
            >
              {projects.length === 0 ? (
                <p className="px-5 py-4 text-sm text-on-surface-variant">
                  {searching ? 'No matching projects.' : 'No projects in this Grove.'}
                </p>
              ) : (
                <ul className="m-0 p-0 list-none">
                  {projects.map((project) => {
                    const lastActivity = lastActivityById.get(project.project_id);
                    return (
                    <li key={project.project_id}>
                      <Row accent="sage">
                        <div className="flex items-center gap-3">
                          <NavLink
                            to={projectPath({ grove, project })}
                            className="flex min-w-0 flex-1 items-center gap-3 hover:text-sage"
                          >
                            <span
                              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-xs font-semibold text-white"
                              style={{ backgroundColor: colorForProjectId(project.project_id) }}
                            >
                              {monogramFor(project.name)}
                            </span>
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm font-medium text-on-surface">{project.name}</span>
                              {project.root && (
                                <span className="block truncate text-xs text-on-surface-variant font-mono">{project.root}</span>
                              )}
                              <span className="block truncate text-[11px] text-on-surface-variant">
                                {lastActivity ? `last active ${formatTimeAgo(lastActivity)}` : 'no activity yet'}
                              </span>
                            </span>
                            {project.attached && (
                              <Badge variant="secondary" title="Served by a team host">Team</Badge>
                            )}
                            {project.manifest_state !== 'present' && (
                              <Badge variant="outline">{project.manifest_state}</Badge>
                            )}
                            {project.status === 'archived' && <Badge variant="outline">archived</Badge>}
                          </NavLink>
                          {project.capabilities && (
                            <button
                              type="button"
                              onClick={() => setCapabilityTarget({ grove, project })}
                              aria-label={`Configure ${project.name} capabilities`}
                              title="Configure capabilities"
                              data-testid="capability-badge-strip"
                              className="shrink-0 flex flex-wrap items-center gap-1 rounded-md p-1 hover:bg-surface-container-high transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-primary/40"
                            >
                              {buildCapabilityBadges(
                                project.capabilities as Record<CapabilityId, boolean>,
                              ).map((chip) => (
                                <CapabilityChipVisual key={chip.id} chip={chip} />
                              ))}
                            </button>
                          )}
                          {project.attached ? (
                            // Attached rows have no local Grove state: Move/Ignore/
                            // Archive/Delete are local-lifecycle ops on a project this
                            // machine doesn't own (Move is deferred to a later window).
                            // Only navigation is meaningful here.
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => navigate(projectPath({ grove, project }))}
                              aria-label={`Open ${project.name}`}
                            >
                              Open
                            </Button>
                          ) : (
                            <ProjectActionMenu
                              projectName={project.name}
                              archived={project.status === 'archived'}
                              onOpen={() => navigate(projectPath({ grove, project }))}
                              onMove={() => setMoveTarget({ grove, project })}
                              onIgnore={() => handleIgnore(grove, project)}
                              onArchive={() => handleArchive(grove, project)}
                              onUnarchive={() => handleUnarchive(grove, project)}
                              onDelete={() => setDeleteProjectTarget({ grove, project })}
                            />
                          )}
                        </div>
                      </Row>
                    </li>
                    );
                  })}
                </ul>
              )}
            </Panel>
            );
          })}
        </div>
      </PageContainer>

      <NewGroveModal open={newOpen} onOpenChange={setNewOpen} />

      {renameTarget && (
        <RenameGroveModal
          open={renameTarget !== null}
          onOpenChange={(open) => !open && setRenameTarget(null)}
          groveId={renameTarget.id}
          currentName={renameTarget.name}
        />
      )}

      {deleteTarget && (
        <DeleteGroveModal
          open={deleteTarget !== null}
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          groveId={deleteTarget.id}
          groveName={deleteTarget.name}
          projectCount={deleteTarget.project_count}
        />
      )}

      {moveTarget && (
        <MoveProjectModal
          open={moveTarget !== null}
          onOpenChange={(open) => !open && setMoveTarget(null)}
          sourceGroveId={moveTarget.grove.id}
          projectId={moveTarget.project.project_id}
          projectName={moveTarget.project.name}
          groves={groves}
        />
      )}

      {deleteProjectTarget && (
        <DeleteProjectModal
          open={deleteProjectTarget !== null}
          onOpenChange={(open) => !open && setDeleteProjectTarget(null)}
          groveId={deleteProjectTarget.grove.id}
          projectId={deleteProjectTarget.project.project_id}
          projectName={deleteProjectTarget.project.name}
        />
      )}

      {capabilityTarget && (
        <CapabilityPanel
          target={capabilityTarget}
          open
          onClose={() => setCapabilityTarget(null)}
        />
      )}
    </PageLoading>
  );
}
