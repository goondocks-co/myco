import { Link } from 'react-router-dom';
import { PageContainer } from '../components/ui/page-container';
import { PageHeader } from '../components/ui/page-header';
import { Panel } from '../components/ui/panel';
import { useProjects } from '../hooks/use-projects';
import { formatCount, formatRelative } from '../lib/format';
import { rememberProject } from '../lib/project-memory';

export function Projects() {
  const projects = useProjects();
  const list = projects.data?.projects ?? [];

  return (
    <PageContainer>
      <PageHeader title="Projects" subtitle="Every project this server holds memory for." />
      {list.length === 0 ? (
        <Panel padded title="No projects yet">
          <p className="font-sans text-sm text-on-surface-variant">
            Connect a repository from your machine and its sessions will appear here:
          </p>
          <pre className="mt-3 rounded-md bg-surface-container px-3 py-2 font-mono text-xs text-on-surface">myco setup</pre>
        </Panel>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3" aria-label="Projects">
          {list.map((p) => (
            <li key={p.projectId}>
              <Link
                to={`/p/${encodeURIComponent(p.projectId)}`}
                onClick={() => rememberProject(p.projectId)}
                className="block rounded-xl border border-outline-variant/20 bg-surface-container-low p-4 transition-colors hover:border-outline-variant/40 hover:bg-surface-container"
              >
                <div className="font-serif text-lg text-on-surface">{p.name}</div>
                <div className="mt-1 font-mono text-[11px] text-on-surface-variant">{p.projectId}</div>
                <div className="mt-3 flex items-center justify-between font-sans text-xs text-on-surface-variant">
                  <span>{formatCount(p.sessionCount, 'session')}</span>
                  <span>Last activity {formatRelative(p.lastActivityAt)}</span>
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </PageContainer>
  );
}
