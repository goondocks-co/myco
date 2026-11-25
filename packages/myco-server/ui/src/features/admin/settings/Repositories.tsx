import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ActionLink, Button, ErrorState, LoadingState, StatusChip } from '../../../design';
import { useProjects } from '../../../hooks/use-projects';
import { useGitHubAppSetup } from '../../../hooks/use-settings';
import { fetchJson } from '../../../lib/api';
import { live } from '../../../lib/live';
import { PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { GitHubReadRow, ProjectRepositories } from './GitHubApp';

/** Where the list of projects and their repositories sits, where an older link to each project's settings lands. */
export const PROJECTS_ANCHOR = 'projects';
/** How many projects show before "Show all". */
export const PROJECTS_SHOWN = 5;

/** `GET /api/repositories`: every live project by name, with the repository it reads or none. */
export interface ProjectRepositoriesAnswer {
  projects: Array<{ projectId: string; name: string; repository: { url: string; branch: string } | null }>;
  more: boolean;
}

/** A GitHub repository's address as its owner and name, or the address whole when it is not GitHub's. */
export const repositoryWords = (url: string): string => /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? url;

/** "Projects and their repositories": each live project, most recently active first, with its repository or Connect. */
function ProjectList() {
  const listing = useQuery({ queryKey: ['project-repositories'], queryFn: ({ signal }) => fetchJson<ProjectRepositoriesAnswer>('/api/repositories', signal), ...live('still') });
  const projects = useProjects();
  const setup = useGitHubAppSetup();
  const [all, setAll] = useState(false);
  const activity = new Map((projects.data?.projects ?? []).map((project) => [project.projectId, project.lastActivityAt ?? 0]));
  const rows = [...(listing.data?.projects ?? [])].sort((a, b) => (activity.get(b.projectId) ?? 0) - (activity.get(a.projectId) ?? 0));
  const shown = all ? rows : rows.slice(0, PROJECTS_SHOWN);
  const unconnected = rows.some((row) => row.repository === null);
  const keyWorks = setup.data?.key.state === 'ready' || setup.data?.key.state === 'permissions_missing';
  return (
    <AdminSection id={PROJECTS_ANCHOR} title="Projects and their repositories" description="Code maps and release tracking read the repository a project is connected to.">
      {listing.isError && <ErrorState error={listing.error} onRetry={() => void listing.refetch()} />}
      <RowCard label="Projects and their repositories">
        {listing.isPending && <LoadingState label="Reading the projects" count={3} />}
        {listing.isSuccess && rows.length === 0 && <p className="px-s4 py-s4 t-small text-muted">No project accepts capture yet.</p>}
        {shown.map((project) => (
          <div key={project.projectId} className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-project-repository={project.repository === null ? 'none' : 'connected'}>
            <div className="flex min-w-0 flex-col gap-s1">
              <span className="t-body font-medium text-ink break-words">{project.name}</span>
              <span className="t-small text-muted break-words">{project.repository === null ? 'No repository connected' : `${repositoryWords(project.repository.url)} · ${project.repository.branch}`}</span>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-s2">
              {project.repository === null
                ? <><StatusChip tone="warn">Not connected</StatusChip><ActionLink to={`${projectPath(project.projectId, PROJECT_SETTINGS_SUFFIX)}#${PROJECT_SETTINGS_ANCHORS.repository}`}>Connect</ActionLink></>
                : <StatusChip tone="ok">Connected</StatusChip>}
            </div>
          </div>
        ))}
        {rows.length > PROJECTS_SHOWN && (
          <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
            <p className="t-small text-muted">{all ? `All ${rows.length} projects.` : `${rows.length - PROJECTS_SHOWN} more ${rows.length - PROJECTS_SHOWN === 1 ? 'project' : 'projects'}.`}</p>
            <Button className="shrink-0" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'Show all'}</Button>
          </div>
        )}
        {listing.data?.more === true && all && <p className="px-s4 py-s4 t-small text-muted">More projects exist than one page lists; each is in Projects.</p>}
      </RowCard>
      {unconnected && keyWorks && <ProjectRepositories />}
    </AdminSection>
  );
}

/** Repositories: which GitHub App reads your repositories and whether it works, then every project with its repository. */
export function Repositories() {
  return (
    <>
      <AdminSection id="what-myco-reads" title="What can Myco read?">
        <RowCard label="What can Myco read?"><GitHubReadRow /></RowCard>
      </AdminSection>
      <ProjectList />
    </>
  );
}
