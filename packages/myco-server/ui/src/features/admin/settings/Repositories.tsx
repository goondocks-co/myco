import { useEffect, useMemo, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ActionLink, Button, ErrorState, LoadingState, StatusChip } from '../../../design';
import { useProjects } from '../../../hooks/use-projects';
import { useGitHubAppSetup } from '../../../hooks/use-settings';
import { fetchJson, isArchived } from '../../../lib/api';
import { live } from '../../../lib/live';
import { PROJECT_SETTINGS_ANCHORS, PROJECT_SETTINGS_SUFFIX, projectPath } from '../../../routes/nav';
import { AdminSection, RowCard } from '../AdminFrame';
import { GitHubReadRow, ProjectRepositories } from './GitHubApp';

/** Where the list of projects and their repositories sits, where an older link to each project's settings lands. */
export const PROJECTS_ANCHOR = 'projects';
/** How many projects show before "Show all". */
export const PROJECTS_SHOWN = 5;

/** `GET /api/repositories`: one page of live projects' connected repositories, and where the next page starts. */
export interface ProjectRepositoriesPage {
  repositories: Array<{ projectId: string; url: string; branch: string }>;
  cursor: string | null;
}

/** A GitHub repository's address as its owner and name, or the address whole when it is not GitHub's. */
export const repositoryWords = (url: string): string => /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? url;

/** Every live project's connected repository, by project id: each page read in turn until the last. */
function useProjectRepositories() {
  const query = useInfiniteQuery({
    queryKey: ['project-repositories'],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) => fetchJson<ProjectRepositoriesPage>(`/api/repositories${pageParam === null ? '' : `?cursor=${encodeURIComponent(pageParam)}`}`, signal),
    getNextPageParam: (last) => last.cursor ?? undefined,
    ...live('still'),
  });
  const { hasNextPage, isFetchingNextPage, isError, fetchNextPage } = query;
  // The list is ordered by activity, not by page, so every page is needed to say whether any shown project is connected.
  useEffect(() => { if (hasNextPage && !isFetchingNextPage && !isError) void fetchNextPage(); }, [hasNextPage, isFetchingNextPage, isError, fetchNextPage]);
  const byProject = useMemo(() => new Map((query.data?.pages ?? []).flatMap((page) => page.repositories).map((row) => [row.projectId, row])), [query.data]);
  return { query, byProject, complete: query.isSuccess && !hasNextPage };
}

/** "Projects and their repositories": every live project, most recently active first, with its repository or Connect. */
function ProjectList() {
  const projects = useProjects();
  const repositories = useProjectRepositories();
  const setup = useGitHubAppSetup();
  const [all, setAll] = useState(false);
  const rows = (projects.data?.projects ?? []).filter((project) => !isArchived(project))
    .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  const shown = all ? rows : rows.slice(0, PROJECTS_SHOWN);
  const ready = projects.isSuccess && repositories.complete;
  const unconnected = ready && rows.some((row) => !repositories.byProject.has(row.projectId));
  const keyWorks = setup.data?.key.state === 'ready' || setup.data?.key.state === 'permissions_missing';
  const failed = projects.isError ? projects.error : repositories.query.isError ? repositories.query.error : null;
  return (
    <AdminSection id={PROJECTS_ANCHOR} title="Projects and their repositories" description="Code maps and release tracking read the repository a project is connected to. Each project’s access keys, for agents that read it from outside, are in its settings.">
      {failed !== null && <ErrorState error={failed} onRetry={() => { void projects.refetch(); void repositories.query.refetch(); }} />}
      <RowCard label="Projects and their repositories">
        {failed === null && !ready && <LoadingState label="Reading the projects and their repositories" count={3} />}
        {ready && rows.length === 0 && <p className="px-s4 py-s4 t-small text-muted">No project accepts capture yet.</p>}
        {ready && shown.map((project) => {
          const repository = repositories.byProject.get(project.projectId);
          const settings = projectPath(project.projectId, PROJECT_SETTINGS_SUFFIX);
          return (
            <div key={project.projectId} className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-start sm:justify-between sm:gap-s6" data-project-repository={repository === undefined ? 'none' : 'connected'}>
              <div className="flex min-w-0 flex-col gap-s1">
                <span className="t-body font-medium text-ink break-words">{project.name}</span>
                <span className="t-small text-muted break-words">{repository === undefined ? 'No repository connected' : `${repositoryWords(repository.url)} · ${repository.branch}`}</span>
              </div>
              <div className="flex shrink-0 flex-wrap items-center gap-s2">
                {repository === undefined
                  ? <><StatusChip tone="warn">Not connected</StatusChip><ActionLink to={`${settings}#${PROJECT_SETTINGS_ANCHORS.repository}`}>Connect</ActionLink></>
                  : <StatusChip tone="ok">Connected</StatusChip>}
                <ActionLink to={`${settings}#${PROJECT_SETTINGS_ANCHORS.accessKeys}`}>Access keys</ActionLink>
              </div>
            </div>
          );
        })}
        {ready && rows.length > PROJECTS_SHOWN && (
          <div className="flex flex-col gap-s3 px-s4 py-s4 sm:flex-row sm:items-center sm:justify-between sm:gap-s6">
            <p className="t-small text-muted">{all ? `All ${rows.length} projects.` : `${rows.length - PROJECTS_SHOWN} more ${rows.length - PROJECTS_SHOWN === 1 ? 'project' : 'projects'}.`}</p>
            <Button className="shrink-0" onClick={() => setAll(!all)}>{all ? 'Show fewer' : 'Show all'}</Button>
          </div>
        )}
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
