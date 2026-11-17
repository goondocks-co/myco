import { changing, retiring, type SchemaStep } from './schema-step.js';
import { NEXT_GITHUB_APP_PROJECTS } from './schema-vNEXT-github-app-projects.js';
import { PROJECT_ID_GRAMMAR } from './project-id.js';

/**
 * Project repository access moves to the Deployment's GitHub App: token slots and their references go, a connection
 * names its App installation and repository by GitHub's numeric ids, and the accounts whose installations may be used
 * are the Deployment's own list.
 *
 * The previous release does not tolerate these drops: until the new Worker serves, its repository and release routes
 * and code-task dispatch answer 503, member capture and claims are refused with 503 and kept on the members, its
 * release reconciliation and scheduled source decision throw, and sign-in keeps working. Nothing is corrupted, so the
 * update is a controlled window: scheduled work is turned off before it and the Worker is activated to end it.
 */
export const GITHUB_APP_PROJECT_STEPS: readonly SchemaStep[] = [
  {
    version: NEXT_GITHUB_APP_PROJECTS,
    // The previous release can still write one of these names until the new Worker serves; the new release's
    // `invite-expiry` job removes any it finds on its own schedule.
    statements: ["DELETE FROM deployment_secrets WHERE name='github' OR substr(name,1,11)='repository:' OR substr(name,1,19)='release-provenance:'"],
    reaches: changing(['deployment_secrets'], 'Repository and release tokens and the retired global GitHub slot are no longer read by anything.'),
  },
  {
    version: NEXT_GITHUB_APP_PROJECTS + 1,
    // The previous release's repository reads and writes fail on the new columns and store nothing.
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
    // The previous release's release settings and reconciliation fail on the missing columns and store nothing.
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
    // A new table the previous release never reads.
    statements: [`CREATE TABLE IF NOT EXISTS github_app_accounts (
      account_id INTEGER PRIMARY KEY CHECK (account_id > 0),
      login TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK (account_type IN ('User', 'Organization')),
      approved_by TEXT NOT NULL,
      approved_at INTEGER NOT NULL)`],
  },
];
