import { GitHubAppError } from '@goondocks/myco-shared/github-api';
import {
  appSlugOf, defaultAppName, findAppBySlug, knownFromKey, type GitHubAppSetup, type KnownApp, type RepositorySuggestions,
} from '@goondocks/myco-shared/github-app-setup';
import { connectedProjects, unconnectedProjects } from '../db/github-app/project-repositories.js';
import type { ServerEnv } from './adapters.js';
import { GitHubAccessRefused, githubAppProjects, githubAppStatus, type RepositoryChoice } from './github-app.js';

/** At most this many connected Projects are tried, in turn, for one whose repository the App can read now. */
const READ_PROBES = 3;
/** Pages of each approved installation's repositories read when proposing connections; GitHub answers 100 a page. */
export const SUGGESTION_PAGES = 5;
/** Projects without a repository considered for proposals in one request. */
const SUGGESTION_PROJECTS = 200;

/**
 * Every live fact the setup checklist is derived from, asked of GitHub on an admin's check: the App's identity (from its
 * key, or GitHub's public page at the slug this Deployment's address implies, kept only when the Client ID matches), its
 * installations, and whether a connected Project's repository can be read now. Nothing is stored.
 */
export async function githubAppSetup(env: ServerEnv, now: number): Promise<GitHubAppSetup> {
  const clientId = env.secrets.GITHUB_CLIENT_ID && env.secrets.GITHUB_CLIENT_SECRET ? env.secrets.GITHUB_CLIENT_ID : null;
  const key = await githubAppStatus(env, now);
  const keyWorks = key.state === 'ready' || key.state === 'permissions_missing';
  let app: KnownApp | null = keyWorks ? knownFromKey(key.app) : null;
  const expectedName = app === null && env.origin !== undefined ? await defaultAppName(env.origin, null) : null;
  let lookupError: string | null = null;
  if (expectedName !== null && clientId !== null) {
    try { app = await findAppBySlug(env.outbound, appSlugOf(expectedName), clientId); }
    catch (error) { if (!(error instanceof GitHubAppError)) throw error; lookupError = error.message; }
  }
  const projects = githubAppProjects(env, () => now);
  const refused = (error: unknown): string => { if (error instanceof GitHubAccessRefused) return error.message; throw error; };
  let installations: GitHubAppSetup['installations'] = key.state === 'rate_limited' ? { error: key.reason } : null;
  if (keyWorks) {
    try { const page = await projects.installations(1); installations = { list: page.installations, more: page.more }; }
    catch (error) { installations = { error: refused(error) }; }
  }
  const connected = await connectedProjects(env.db, READ_PROBES);
  let repository: GitHubAppSetup['repository'] = null;
  if (keyWorks && connected.projects.length > 0) {
    const failed: Array<{ project: string; error: string }> = [];
    for (const project of connected.projects) {
      try {
        repository = { project: project.name, fullName: (await projects.verify(project.installationId, project.repositoryId)).fullName };
        break;
      } catch (error) { failed.push({ project: project.name, error: refused(error) }); }
    }
    repository ??= { failed, unchecked: connected.total - failed.length };
  }
  return {
    target: env.platform.name === 'cloudflare' ? 'cloudflare' : 'local', origin: env.origin ?? null, clientId,
    app, expectedName: app === null ? expectedName : null, lookupError, key, installations, connectedProjects: connected.total, repository,
  };
}

/**
 * For each live Project with no repository, the one repository across approved installations whose name equals the
 * Project's, ignoring case, with its default branch. A Project with no such repository, or more than one, gets none.
 * Uniqueness is claimed only from a complete search: when an installation page or a repository page was left unread,
 * no Project gets a proposal and each with a same-named repository seen is withheld. Nothing is connected here; an
 * admin saves each proposal through the repository connection.
 */
export async function repositorySuggestions(env: ServerEnv, now: number): Promise<RepositorySuggestions> {
  const waiting = await unconnectedProjects(env.db, SUGGESTION_PROJECTS);
  if (waiting.length === 0) return { suggestions: [], complete: true, withheld: [] };
  const projects = githubAppProjects(env, () => now);
  const listed = await projects.installations(1);
  const byName = new Map<string, Array<{ installationId: number; repository: RepositoryChoice }>>();
  let complete = !listed.more;
  for (const installation of listed.installations.filter((entry) => entry.approved && !entry.suspended)) {
    for (let page = 1; page <= SUGGESTION_PAGES; page += 1) {
      const answer = await projects.repositories(installation.installationId, page);
      for (const repository of answer.repositories) {
        const name = repository.fullName.split('/')[1]!.toLowerCase();
        byName.set(name, [...byName.get(name) ?? [], { installationId: installation.installationId, repository }]);
      }
      if (!answer.more) break;
      if (page === SUGGESTION_PAGES) complete = false;
    }
  }
  const seen = waiting.map((project) => ({ project, matches: byName.get(project.name.toLowerCase()) ?? [] }));
  if (!complete) {
    return { complete, suggestions: [], withheld: seen.filter(({ matches }) => matches.length > 0).map(({ project }) => ({ projectId: project.projectId, project: project.name })) };
  }
  return {
    complete, withheld: [],
    suggestions: seen.flatMap(({ project, matches }) => {
      if (matches.length !== 1) return [];
      const [{ installationId, repository }] = matches as [typeof matches[number]];
      return [{ projectId: project.projectId, project: project.name, installationId, repositoryId: repository.id, fullName: repository.fullName, defaultBranch: repository.defaultBranch }];
    }),
  };
}
