import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { PageLoading } from '../components/ui/page-loading';
import { Panel } from '../components/ui/panel';
import { StatCard } from '../components/ui/stat-card';
import { useProjectActions, useProjects } from '../hooks/use-projects';
import { refusalText } from '../hooks/use-access';
import { isArchived } from '../lib/api';
import { useActivity, type FeedItem } from '../hooks/use-sessions';
import { formatCount, formatDateTime, formatRelative } from '../lib/format';
import { forgetProject, rememberProject } from '../lib/project-memory';
import { NotFound } from './NotFound';

const TYPE_LABEL: Record<FeedItem['type'], string> = { session: 'Session', run: 'Run', spore: 'Spore' };

export function ProjectHome() {
  const { projectId = '' } = useParams();
  const projects = useProjects();
  const project = projects.data?.projects.find((p) => p.projectId === projectId);

  useEffect(() => {
    if (project) rememberProject(project.projectId);
    else if (projects.data) forgetProject();
  }, [project, projects.data]);

  if (!project) return <NotFound />;

  return (
    <PageContainer>
      <PageHeader title={project.name} subtitle={project.projectId} />
      {isArchived(project) && <ArchivedBanner projectId={project.projectId} archivedAt={project.archivedAt} archivedBy={project.archivedBy} />}
      <Activity projectId={project.projectId} />
    </PageContainer>
  );
}

/** An archived project says so first: runtimes are refused until it is unarchived, and everything captured stays. */
function ArchivedBanner({ projectId, archivedAt, archivedBy }: { projectId: string; archivedAt: number | null; archivedBy: string | null }) {
  const actions = useProjectActions();
  const [error, setError] = useState<string | null>(null);
  return (
    <Panel tone="terra" eyebrow="Archived" title="Runtimes are refused until you unarchive" className="mb-4" data-testid="archived-banner" actions={
      <button type="button" className="rounded-md bg-primary px-3 py-1.5 font-sans text-sm text-on-primary transition-opacity hover:opacity-90" disabled={actions.unarchive.isPending} onClick={() => { setError(null); actions.unarchive.mutate(projectId, { onError: (err) => setError(refusalText(err)) }); }}>Unarchive</button>
    }>
      <p className="font-sans text-sm text-on-surface-variant">Archived {formatRelative(archivedAt)}{archivedBy ? ` by ${archivedBy}` : ''}. Everything captured before stays readable.</p>
      {error !== null && <p className="mt-2 font-sans text-xs text-tertiary">{error}</p>}
    </Panel>
  );
}

/** What the project holds and what happened last; rendered under the header so a failed read shows as its own error, not as a missing project. */
function Activity({ projectId }: { projectId: string }) {
  const activity = useActivity(projectId);
  const base = `/p/${encodeURIComponent(projectId)}`;
  const linkOf = (item: FeedItem): string | null =>
    item.type === 'session' ? `${base}/sessions/${encodeURIComponent(item.id)}` : item.type === 'run' ? `${base}/runs/${encodeURIComponent(item.id)}` : item.sessionId === null ? null : `${base}/sessions/${encodeURIComponent(item.sessionId)}`;
  return (
    <PageLoading isLoading={activity.isPending} error={activity.error}>
      {activity.data && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
            <StatCard label="Sessions" value={activity.data.stats.sessions.toLocaleString()} sublabel={`${activity.data.stats.openSessions.toLocaleString()} open`} accent="sage" href={`${base}/sessions`} />
            <StatCard label="Last 7 days" value={activity.data.stats.sessionsLast7d.toLocaleString()} sublabel="sessions" accent="sage" />
            <StatCard label="Prompts" value={activity.data.stats.prompts.toLocaleString()} accent="ochre" />
            <StatCard label="Tool calls" value={activity.data.stats.toolCalls.toLocaleString()} accent="ochre" />
            <StatCard label="Plans" value={activity.data.stats.plans.toLocaleString()} sublabel={formatCount(activity.data.stats.attachments, 'attachment')} accent="outline" />
            <StatCard label="Last activity" value={formatRelative(activity.data.stats.lastActivityAt)} sublabel={formatDateTime(activity.data.stats.lastActivityAt)} accent="outline" />
          </div>
          <Panel title="Activity" padded={activity.data.items.length === 0}>
            {activity.data.items.length === 0 ? (
              <p className="font-sans text-sm text-on-surface-variant">Nothing captured yet.</p>
            ) : (
              <ul className="divide-y divide-outline-variant/10" aria-label="Activity">
                {activity.data.items.map((item) => {
                  const to = linkOf(item);
                  return (
                    <li key={`${item.type}:${item.id}`} className="flex items-center gap-3 px-5 py-2 font-sans text-sm">
                      <span className="w-14 shrink-0 font-sans text-[10px] uppercase tracking-wide text-on-surface-variant">{TYPE_LABEL[item.type]}</span>
                      {to === null ? <span className="min-w-0 flex-1 truncate text-on-surface">{item.summary}</span> : <Link to={to} className="min-w-0 flex-1 truncate text-on-surface hover:underline">{item.summary}</Link>}
                      <span className="shrink-0 font-mono text-[11px] text-on-surface-variant" title={formatDateTime(item.at)}>{formatRelative(item.at)}</span>
                    </li>
                  );
                })}
              </ul>
            )}
          </Panel>
        </div>
      )}
    </PageLoading>
  );
}
