import { changing, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_GITHUB_APP_PROJECTS } from './schema-vNEXT-github-app-projects.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Project repository access moves to the Deployment's GitHub App: token slots and their references go, a connection
 * names its App installation and repository by GitHub's numeric ids, and the accounts whose installations may be used
 * are the Deployment's own list.
 */
export const GITHUB_APP_PROJECT_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_GITHUB_APP_PROJECTS,
    statements: ["DELETE FROM deployment_secrets WHERE name='github' OR substr(name,1,11)='repository:' OR substr(name,1,19)='release-provenance:'"],
    reaches: changing(['deployment_secrets'], 'Repository and release tokens and the retired global GitHub slot are no longer read by anything.'),
  },
  {
    version: NEXT_GITHUB_APP_PROJECTS + 1,
    statements: [
      'DROP TABLE IF EXISTS project_repositories',
      `CREATE TABLE IF NOT EXISTS project_repositories (
        project_id TEXT PRIMARY KEY CHECK (${PROJECT_ID_GRAMMAR}) REFERENCES projects(project_id),
        revision TEXT NOT NULL,
        url TEXT NOT NULL,
        branch TEXT NOT NULL,
        github_repository_id INTEGER NOT NULL CHECK (github_repository_id > 0),
        github_installation_id INTEGER NOT NULL CHECK (github_installation_id > 0),
        updated_at INTEGER NOT NULL,
        updated_by TEXT NOT NULL)`,
    ],
    retires: [
      { kind: 'table', name: 'project_repositories', reason: 'A connection is an App installation and repository an admin chooses again; token-era rows are not carried.' },
      ...retiring('column', ['project_repositories.username', 'project_repositories.secret_slot'], 'Repository access is the Deployment’s GitHub App; no Project holds a token.'),
    ],
  },
  {
    version: NEXT_GITHUB_APP_PROJECTS + 2,
    statements: [
      'ALTER TABLE project_release_provenance DROP COLUMN secret_slot',
      'ALTER TABLE project_release_provenance DROP COLUMN github_repo',
    ],
    retires: [
      { kind: 'column', name: 'project_release_provenance.secret_slot', reason: 'Release reads use the Project connection through the Deployment’s GitHub App.' },
      { kind: 'column', name: 'project_release_provenance.github_repo', reason: 'Release tracking reads the Project’s one connected repository.' },
    ],
    reaches: changing(['project_release_provenance'], 'Release tracking keeps its refs, rules and history and loses its own repository and token.'),
  },
  {
    version: NEXT_GITHUB_APP_PROJECTS + 3,
    statements: [`CREATE TABLE IF NOT EXISTS github_app_accounts (
      account_id INTEGER PRIMARY KEY CHECK (account_id > 0),
      login TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
      approved_by TEXT NOT NULL,
      approved_at INTEGER NOT NULL)`],
  },
];
