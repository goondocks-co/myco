import { useState } from 'react';
import { Link } from 'react-router-dom';
import { ConfirmDialog } from '../components/ui/confirm-dialog';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { refusalText } from '../hooks/use-access';
import { useProjectActions, useProjects } from '../hooks/use-projects';
import { isArchived, type ProjectSummary } from '../lib/api';
import { formatCount, formatRelative } from '../lib/format';
import { rememberProject } from '../lib/project-memory';

const button = 'rounded-md border border-outline-variant/30 px-2.5 py-1 font-sans text-xs text-on-surface transition-colors hover:bg-surface-container-high';

export function Projects() {
  const projects = useProjects();
  const actions = useProjectActions();
  const [showArchived, setShowArchived] = useState(false);
  const [archiving, setArchiving] = useState<ProjectSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const all = projects.data?.projects ?? [];
  const live = all.filter((p) => !isArchived(p));
  const archived = all.filter(isArchived);

  return (
    <PageContainer>
      <PageHeader
        title="Projects"
        subtitle="Every project this server holds memory for."
        actions={archived.length > 0 ? (
          <button type="button" className={button} aria-pressed={showArchived} onClick={() => setShowArchived((v) => !v)}>
            {showArchived ? 'Hide archived' : `Archived (${archived.length})`}
          </button>
        ) : undefined}
      />
      {error !== null && <p className="mb-3 font-sans text-xs text-tertiary">{error}</p>}
      {live.length === 0 && archived.length === 0 ? (
        <Panel padded title="No projects yet">
          <p className="font-sans text-sm text-on-surface-variant">
            Connect a repository from your machine and its sessions will appear here:
          </p>
          <pre className="mt-3 rounded-md bg-surface-container px-3 py-2 font-mono text-xs text-on-surface">myco setup</pre>
        </Panel>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Projects">
          {live.map((p) => (
            <ProjectCard key={p.projectId} project={p} action={<button type="button" className={button} onClick={() => { setError(null); setArchiving(p); }}>Archive</button>} />
          ))}
        </ul>
      )}
      {showArchived && archived.length > 0 && (
        <section className="mt-6" aria-label="Archived projects">
          <h2 className="mb-2 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">Archived</h2>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {archived.map((p) => (
              <ProjectCard
                key={p.projectId}
                project={p}
                note={`Archived ${formatRelative(p.archivedAt)}${p.archivedBy ? ` by ${p.archivedBy}` : ''}`}
                action={<button type="button" className={button} disabled={actions.unarchive.isPending} onClick={() => { setError(null); actions.unarchive.mutate(p.projectId, { onError: (err) => setError(refusalText(err)) }); }}>Unarchive</button>}
              />
            ))}
          </ul>
        </section>
      )}
      <ConfirmDialog
        open={archiving !== null}
        onOpenChange={(open) => { if (!open) { setArchiving(null); actions.archive.reset(); } }}
        title={`Archive ${archiving?.name ?? ''}?`}
        description="Capture from every runtime stops until you unarchive. Everything already captured stays."
        confirmLabel="Archive"
        variant="destructive"
        isPending={actions.archive.isPending}
        errorMessage={actions.archive.error ? refusalText(actions.archive.error) : null}
        onConfirm={() => { if (archiving) actions.archive.mutate(archiving.projectId, { onSuccess: () => setArchiving(null) }); }}
      />
    </PageContainer>
  );
}

function ProjectCard({ project, note, action }: { project: ProjectSummary; note?: string; action: React.ReactNode }) {
  return (
    <li className="flex flex-col rounded-xl border border-outline-variant/20 bg-surface-container-low p-4 transition-colors hover:border-outline-variant/40">
      <Link to={`/p/${encodeURIComponent(project.projectId)}`} onClick={() => rememberProject(project.projectId)} className="block">
        <div className="font-serif text-lg text-on-surface">{project.name}</div>
        <div className="mt-1 font-mono text-[11px] text-on-surface-variant">{project.projectId}</div>
      </Link>
      <div className="mt-3 flex items-center justify-between gap-2 font-sans text-xs text-on-surface-variant">
        {note !== undefined ? <span>{note}</span> : <span className="flex gap-2"><span>{formatCount(project.sessionCount, 'session')}</span><span>Last activity {formatRelative(project.lastActivityAt)}</span></span>}
        {action}
      </div>
    </li>
  );
}
