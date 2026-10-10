import { useState, type ReactNode } from 'react';
import { Link as RouterLink, useNavigate } from 'react-router-dom';
import {
  Button, CommandBlock, ConfirmDialog, EmptyState, ErrorState, focusRing, HealthDot, LoadingState, MoreMenu, type MoreMenuItem, recencyOf, StatusChip,
} from '../design';
import { AdminPage, RowCard } from '../features/admin/AdminFrame';
import { RenameProjectDialog } from '../features/admin/project/RenameProjectDialog';
import { useMemberNames } from '../features/admin/members';
import { refusalText } from '../hooks/use-access';
import { permissionOf, useMe } from '../hooks/use-me';
import { useProjectActions, useProjects } from '../hooks/use-projects';
import { isArchived, type ProjectSummary } from '../lib/api';
import { cn } from '../lib/cn';
import { formatCount, formatRelative } from '../lib/format';
import { rememberProject } from '../lib/project-memory';
import { PROJECT_SETTINGS_SUFFIX, projectPath } from '../routes/nav';

/** Most recent activity first; a project with none sorts last, then by name. */
function byRecency(a: ProjectSummary, b: ProjectSummary): number {
  return (b.lastActivityAt ?? -1) - (a.lastActivityAt ?? -1) || a.name.localeCompare(b.name);
}

/**
 * `/projects`: every project this server holds memory for, most recently
 * active first. An admin renames, archives and opens a project's settings from
 * its menu; archived projects wait behind one button.
 */
export function Projects() {
  const projects = useProjects();
  const actions = useProjectActions();
  const projectPermission = permissionOf(useMe().data, 'projects');
  const admin = projectPermission.allowed;
  const nameOf = useMemberNames();
  const navigate = useNavigate();
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<ProjectSummary | null>(null);
  const [renaming, setRenaming] = useState<ProjectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const all = projects.data?.projects ?? [];
  const live = all.filter((p) => !isArchived(p)).sort(byRecency);
  const archived = all.filter(isArchived).sort(byRecency);
  const now = Date.now();

  const menu = (p: ProjectSummary): MoreMenuItem[] => [
    { label: 'Rename', onSelect: () => { setError(null); setRenaming(p); } },
    { label: 'Project settings', onSelect: () => navigate(projectPath(p.projectId, PROJECT_SETTINGS_SUFFIX)) },
    { label: 'Archive', tone: 'danger', onSelect: () => { setError(null); setArchiving(p); } },
  ];

  return (
    <AdminPage
      name="projects"
      title="Projects"
      lede="Every project this server holds memory for, most recently active first."
      actions={archived.length > 0 ? (
        <Button size="sm" aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
          {showArchived ? 'Hide archived' : `Archived (${archived.length})`}
        </Button>
      ) : undefined}
    >
      {!admin && <p className="t-small text-muted">{projectPermission.reason ?? 'An admin can change project settings.'}</p>}
      {error !== null && <p role="alert" className="t-small text-bad">{error}</p>}
      {projects.isPending ? <LoadingState label="Loading projects" count={3} />
        : projects.isError ? <ErrorState error={projects.error} onRetry={() => void projects.refetch()} />
        : live.length === 0 && archived.length === 0 ? (
        <div className="flex flex-col gap-s3">
          <EmptyState title="No projects yet." className="py-0" />
          <CommandBlock caption="Sign this machine in, then start your coding agent in a repository to capture its sessions. You can also use People & machines → Add a machine:" command={`myco login ${window.location.origin}`} className="max-w-measure" />
        </div>
      ) : (
        <RowCard>
          <ul aria-label="Projects" className="flex flex-col divide-y divide-line">
            {live.map((p) => (
              <ProjectRow key={p.projectId} project={p} now={now} menu={admin ? menu(p) : undefined} />
            ))}
          </ul>
        </RowCard>
      )}
      {showArchived && archived.length > 0 && (
        <section aria-labelledby="archived-title" className="flex flex-col gap-s3">
          <h2 id="archived-title" className="t-h2 text-ink">Archived projects</h2>
          <p className="max-w-measure t-small text-muted">An archived project takes no new capture. Everything it holds stays readable.</p>
          <RowCard>
            <ul aria-label="Archived projects" className="flex flex-col divide-y divide-line">
              {archived.map((p) => {
                const by = nameOf(p.archivedBy);
                return (
                  <ProjectRow
                    key={p.projectId}
                    project={p}
                    now={now}
                    note={`Archived ${formatRelative(p.archivedAt, now)}${by === null ? '' : ` by ${by}`}`}
                    action={admin ? (
                      <Button size="sm" pending={actions.unarchive.isPending && actions.unarchive.variables === p.projectId}
                        onClick={() => { setError(null); actions.unarchive.mutate(p.projectId, { onError: (err) => setError(refusalText(err)) }); }}>
                        Unarchive
                      </Button>
                    ) : undefined}
                  />
                );
              })}
            </ul>
          </RowCard>
        </section>
      )}
      <RenameProjectDialog project={renaming} onClose={() => setRenaming(null)} />
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => { if (!open) { setArchiving(null); actions.archive.reset(); } }}
        title={`Archive ${archiving?.name ?? ''}?`}
        description="Capture from every agent stops until you unarchive. Everything already captured stays."
        confirmLabel="Archive"
        pending={actions.archive.isPending}
        error={actions.archive.error ? refusalText(actions.archive.error) : null}
        onConfirm={() => { if (archiving) actions.archive.mutate(archiving.projectId, { onSuccess: () => setArchiving(null) }); }}
      />
    </AdminPage>
  );
}

/** One project: its name leading to its day, how much it holds and when it last saw work, and the admin's menu. */
function ProjectRow({ project, now, note, menu, action }: {
  project: ProjectSummary;
  now: number;
  note?: string;
  menu?: MoreMenuItem[];
  action?: ReactNode;
}) {
  const recency = recencyOf(project.lastActivityAt, now);
  return (
    <li className="flex min-h-row items-center gap-s3 px-s4 py-s2" data-project-row="">
      <HealthDot tone={recency.tone} label={recency.label} />
      <RouterLink
        to={projectPath(project.projectId)}
        onClick={() => rememberProject(project.projectId)}
        className={cn('flex min-w-0 flex-1 flex-col justify-center self-stretch rounded-chip', focusRing)}
      >
        <span className="truncate t-body font-medium text-ink">{project.name}</span>
        <span className="flex flex-wrap gap-x-s2 t-small text-muted">
          {note !== undefined ? <span>{note}</span> : (
            <>
              <span className="whitespace-nowrap">{formatCount(project.sessionCount, 'session')}</span>
              <span aria-hidden>·</span>
              <span className="whitespace-nowrap">{project.lastActivityAt === null ? 'No activity yet' : `Last activity ${formatRelative(project.lastActivityAt, now)}`}</span>
            </>
          )}
        </span>
      </RouterLink>
      {isArchived(project) && note === undefined && <StatusChip>Archived</StatusChip>}
      {action}
      {menu !== undefined && <MoreMenu items={menu} label={`Actions for ${project.name}`} />}
    </li>
  );
}
