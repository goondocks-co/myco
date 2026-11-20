/**
 * Setting up a Deployment's GitHub App for repository access: the App's expected name, its pages on GitHub, the
 * operator's exact commands, and the checklist the dashboard shows. The dashboard and `myco server github-app` read
 * the same words and links from here.
 */
import { GitHubAppError, githubApi, type FetchImpl } from './github-api.js';
import { gitHubAppPermissionIssues, ownerOf, type GitHubAppIdentity, type GitHubAppOwner, type GitHubAppStatus } from './github-app.js';

/** GitHub's limit on an App's name. */
export const APP_NAME_MAX = 34;
const GITHUB = 'https://github.com';
const LOOKUP_TIMEOUT_MS = 10_000;
/** Where an admin finds the App when its owner is not known: their own Apps, and the organizations whose Apps they can open. */
export const GITHUB_APPS_LISTS = { personal: `${GITHUB}/settings/apps`, organizations: `${GITHUB}/settings/organizations` } as const;
/** The dashboard section that carries the whole setup. */
export const GITHUB_APP_SETUP_PATH = '/settings/access#github-app';

/** The operator command's names for a Deployment's targets. */
export type OperatorTarget = 'local' | 'cloudflare';

const isLoopbackHost = (host: string): boolean =>
  host === '[::1]' || host === '::1' || host === 'localhost' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);

async function shortHash(text: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
  return [...digest.slice(0, 2)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The name registration gives a new App, derived from the Deployment's address: it fits GitHub's limit, and a loopback
 * address is told apart by the operator's machine name and port. Null for a loopback address when that machine's name
 * is not known.
 */
export async function defaultAppName(url: string, machineHostname: string | null): Promise<string | null> {
  const address = new URL(url);
  const loopback = isLoopbackHost(address.hostname);
  const port = address.port || (address.protocol === 'https:' ? '443' : '80');
  if (loopback && machineHostname === null) return null;
  const host = loopback ? `${machineHostname}:${port}` : address.host;
  const full = `Myco (${host})`;
  if (!loopback && full.length <= APP_NAME_MAX) return full;
  const hash = await shortHash(host);
  if (loopback) {
    const available = APP_NAME_MAX - `Myco (-${hash}:${port})`.length;
    return `Myco (${machineHostname!.slice(0, available)}-${hash}:${port})`;
  }
  const label = host.split('.')[0]!;
  const available = APP_NAME_MAX - 'Myco ()'.length - '-'.length - hash.length;
  return `Myco (${label.slice(0, available)}-${hash})`;
}

/** The slug GitHub gives an App name: lower case, each run of other characters one hyphen. */
export const appSlugOf = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/** The App's own pages on GitHub. Its settings live under its owner, so they are known only once the owner is. */
export function githubAppPages(slug: string, owner: GitHubAppOwner | null) {
  const settings = owner === null ? null
    : owner.type === 'Organization' ? `${GITHUB}/organizations/${encodeURIComponent(owner.login)}/settings/apps/${slug}` : `${GITHUB}/settings/apps/${slug}`;
  return { app: `${GITHUB}/apps/${slug}`, install: `${GITHUB}/apps/${slug}/installations/new`, settings, permissions: settings === null ? null : `${settings}/permissions` };
}

/** Where an account changes which repositories its installation of the App includes. */
export const installationPage = (installationId: number, account: GitHubAppOwner): string => account.type === 'Organization'
  ? `${GITHUB}/organizations/${encodeURIComponent(account.login)}/settings/installations/${installationId}`
  : `${GITHUB}/settings/installations/${installationId}`;

export const ownerWords = (owner: GitHubAppOwner): string => `${owner.login} (${owner.type === 'Organization' ? 'an organization' : 'a personal account'})`;

/** The operator's command that imports a downloaded key into this Deployment. */
export const keyImportCommand = (target: OperatorTarget, origin: string): string =>
  `myco server github-app --target ${target} --url ${origin} --private-key-file <downloaded.pem>`;

/** The import with what it needs around it: a native server is stopped while its secrets change, then started. */
export const keyImportCommands = (target: OperatorTarget, origin: string): string[] => target === 'local'
  ? ['myco server uninstall --target local', keyImportCommand(target, origin), 'myco server install --target local'] : [keyImportCommand(target, origin)];

/** Guidance that holds wherever GitHub moves its settings pages: what to look for, never one fixed path. */
export const SETUP_WORDS = {
  confirmAccess: 'GitHub may ask you to confirm access (your password, passkey or two-factor code) before it opens an App’s settings. Confirm, and the page opens.',
  permissions: 'On the App’s permissions page, set repository Contents, Pull requests and Metadata to Read-only and save. Leave account permissions and the callback URL as they are.',
  permissionsAccepted: 'GitHub then asks each account the App is installed on to accept the change. An App installed nowhere yet has nothing to accept.',
  key: 'On the App’s settings page, generate a private key. Look for the App’s private keys: today under Credentials → Key pairs → New key. GitHub downloads a .pem file.',
  keyCommand: 'Then run this on the machine that created this server:',
  install: 'Install the App on each account that owns repositories code tasks should read, choosing Only select repositories. An organization owner may need to approve it.',
  approve: 'The App is public, so anyone can install it. Only installations by accounts approved here are used.',
  connect: 'Open a Project’s Settings → Repository and choose a repository, or let Myco propose the repositories named like your Projects.',
  find: (name: string | null, clientId: string | null) =>
    `${name === null ? 'This server’s App' : `This server’s App is probably named “${name}”`}. Find it among your Apps or your organizations’ Apps${clientId === null ? '' : ` and match its Client ID, ${clientId}`}.`,
} as const;

/** The App as the Deployment knows it now: from GitHub's answer to its key, or GitHub's public page matched by Client ID. */
export interface KnownApp { slug: string; name: string; owner: GitHubAppOwner | null; permissions: Record<string, string>; source: 'key' | 'public' }
/** An installation as the checklist counts it. */
export interface SetupInstallation { installationId: number; account: GitHubAppOwner; approved: boolean; suspended: boolean }

/** `GET /api/github-app`: every live fact the setup checklist is derived from. Nothing here is a stored “done” flag. */
export interface GitHubAppSetup {
  target: OperatorTarget;
  /** The address the operator declared for this Deployment, when it declared one. */
  origin: string | null;
  /** The sign-in Client ID; null when sign-in is not configured. */
  clientId: string | null;
  app: KnownApp | null;
  /** The name registration would have given the App, when the App itself is not identified. */
  expectedName: string | null;
  /** Why GitHub's public App page could not be read, when it was asked and did not answer. */
  lookupError: string | null;
  key: GitHubAppStatus;
  /** The App's installations; null until the key can list them. */
  installations: { list: SetupInstallation[]; more: boolean } | { error: string } | null;
  connectedProjects: number;
  /** A Project whose repository GitHub just let the App read, or the first refusal met; null with no Project connected. */
  repository: { project: string; fullName: string } | { project: string; error: string } | null;
}

/** `GET /api/github-app/suggestions`: a repository proposed for a Project with none, the one whose name equals the Project's. */
export interface RepositorySuggestion { projectId: string; project: string; installationId: number; repositoryId: number; fullName: string; defaultBranch: string }
/** `complete` is false when some approved account holds more repositories than were searched. */
export interface RepositorySuggestions { suggestions: RepositorySuggestion[]; complete: boolean }

/**
 * The App GitHub's public page names at the slug the Deployment's address implies, kept only when its Client ID is this
 * Deployment's. Null when GitHub has no App there or it is another App. https://docs.github.com/en/rest/apps/apps#get-an-app
 */
export async function findAppBySlug(fetchImpl: FetchImpl, slug: string, clientId: string): Promise<KnownApp | null> {
  const response = await githubApi(fetchImpl, `/apps/${encodeURIComponent(slug)}`, { signal: AbortSignal.timeout(LOOKUP_TIMEOUT_MS), next: 'Check again later.' });
  if (response.status === 404) return null;
  if (response.status !== 200) throw new GitHubAppError(`GitHub did not show the App’s public page (HTTP ${response.status}).`, response.status);
  const body: unknown = await response.json().catch(() => null);
  if (body === null || typeof body !== 'object') throw new GitHubAppError('GitHub answered the App’s public page with something unreadable.');
  const app = body as Record<string, unknown>;
  if (app.client_id !== clientId || typeof app.slug !== 'string' || typeof app.name !== 'string') return null;
  const permissions = app.permissions !== null && typeof app.permissions === 'object' ? app.permissions as Record<string, string> : {};
  return { slug: app.slug, name: app.name, owner: ownerOf(app.owner), permissions, source: 'public' };
}

export const knownFromKey = (identity: GitHubAppIdentity): KnownApp =>
  ({ slug: identity.slug, name: identity.name, owner: identity.owner, permissions: identity.permissions, source: 'key' });

export type StepState = 'done' | 'todo' | 'failed' | 'waiting';
export type StepId = 'sign-in' | 'permissions' | 'key' | 'installed' | 'approved' | 'connected';
export interface SetupLink { label: string; href: string }
export interface SetupStep { id: StepId; state: StepState; title: string; detail: string[]; links: SetupLink[]; commands: string[] }

const accounts = (list: SetupInstallation[]): string => list.map((installation) => ownerWords(installation.account)).join(', ');

/** The checklist, each step derived from the live facts in `setup`. `origin` is where the dashboard is open, used when the operator declared none. */
export function githubAppChecklist(setup: GitHubAppSetup, origin: string): SetupStep[] {
  const pages = setup.app === null ? null : githubAppPages(setup.app.slug, setup.app.owner);
  const find: SetupLink[] = [{ label: 'Your GitHub Apps', href: GITHUB_APPS_LISTS.personal }, { label: 'Your organizations', href: GITHUB_APPS_LISTS.organizations }];
  const settingsLinks = pages?.settings ? [{ label: 'Open the App’s settings', href: pages.settings }] : find;
  const keyWorks = setup.key.state === 'ready' || setup.key.state === 'permissions_missing';
  const missing = setup.key.state === 'ready' || setup.key.state === 'permissions_missing' ? setup.key.missing
    : setup.app === null ? null : gitHubAppPermissionIssues(setup.app);
  const installations = setup.installations !== null && 'list' in setup.installations ? setup.installations.list : null;
  const installed = installations?.filter((installation) => !installation.suspended) ?? [];
  const usable = installed.filter((installation) => installation.approved);
  const install: SetupLink[] = pages === null ? find : [{ label: 'Install the App in GitHub', href: pages.install }];

  const signIn: SetupStep = setup.clientId === null
    ? { id: 'sign-in', state: 'todo', title: 'Sign-in is not set up.', detail: ['On the machine that created this server, run myco setup.'], links: [], commands: [] }
    : { id: 'sign-in', state: 'done', title: 'Sign-in works through this App.', detail: [], links: [], commands: [] };
  const permissionLinks = pages?.permissions ? [{ label: 'Open the App’s permissions', href: pages.permissions }] : settingsLinks;
  const permissions: SetupStep = missing !== null && missing.length === 0
    ? { id: 'permissions', state: 'done', title: 'Repository permissions are read-only: Contents, Pull requests and Metadata.', detail: [], links: [], commands: [] }
    : { id: 'permissions', state: 'todo', title: missing === null ? 'Set the App’s repository permissions.' : `Repository permissions need changes: ${missing.join('; ')}.`,
      detail: [SETUP_WORDS.permissions, SETUP_WORDS.permissionsAccepted], links: permissionLinks, commands: [] };
  const commands = keyImportCommands(setup.target, setup.origin ?? origin);
  const key: SetupStep = keyWorks
    ? { id: 'key', state: 'done', title: 'The private key is imported and GitHub accepts it.', detail: [], links: [], commands: [] }
    : { id: 'key', state: setup.key.state === 'unavailable' ? 'failed' : 'todo',
      title: setup.key.state === 'unavailable' ? `GitHub did not accept the imported key: ${setup.key.reason}` : 'Import the App’s private key.',
      detail: [SETUP_WORDS.key, SETUP_WORDS.keyCommand], links: settingsLinks, commands };
  const installedStep: SetupStep = installations === null
    ? setup.installations !== null && 'error' in setup.installations
      ? { id: 'installed', state: 'failed', title: `GitHub did not list the App’s installations: ${setup.installations.error}`, detail: [], links: install, commands: [] }
      : { id: 'installed', state: 'waiting', title: 'Install the App on the accounts that own your repositories.', detail: [SETUP_WORDS.install, 'Checked once the private key is imported.'], links: install, commands: [] }
    : installed.length === 0
      ? { id: 'installed', state: 'todo', title: 'Install the App on the accounts that own your repositories.', detail: [SETUP_WORDS.install, 'Then press Check again.'], links: install, commands: [] }
      : { id: 'installed', state: 'done', title: `Installed on ${accounts(installed)}.`, detail: [], links: pages === null ? [] : [{ label: 'Install on another account', href: pages.install }], commands: [] };
  const approved: SetupStep = installed.length === 0
    ? { id: 'approved', state: 'waiting', title: 'Approve an account that installed the App.', detail: ['Possible once the App is installed on an account.'], links: [], commands: [] }
    : usable.length === 0
      ? { id: 'approved', state: 'todo', title: 'Approve an account that installed the App.', detail: [SETUP_WORDS.approve], links: [], commands: [] }
      : { id: 'approved', state: 'done', title: `Approved here: ${accounts(usable)}.`, detail: [], links: [], commands: [] };
  const repository = setup.repository;
  const connected: SetupStep = repository !== null && 'fullName' in repository
    ? { id: 'connected', state: 'done', title: `${repository.project} reads ${repository.fullName}.`, detail: [], links: [], commands: [] }
    : repository !== null
      ? { id: 'connected', state: 'failed', title: `${repository.project}’s repository can’t be read: ${repository.error}`, detail: [], links: [], commands: [] }
      : usable.length === 0
        ? { id: 'connected', state: 'waiting', title: 'Connect a repository to a Project.', detail: ['Possible once an account is approved here.'], links: [], commands: [] }
        : { id: 'connected', state: 'todo', title: 'Connect a repository to a Project.', detail: [SETUP_WORDS.connect], links: [], commands: [] };
  return [signIn, permissions, key, installedStep, approved, connected];
}

/** The section's one-line answer: set up only when a Project could read a repository; otherwise what remains and what is next. */
export function githubAppHeadline(steps: SetupStep[]): string {
  const remaining = steps.filter((step) => step.state !== 'done');
  const connected = steps.find((step) => step.id === 'connected')!;
  if (remaining.length === 0) return `Repository access is set up: ${connected.title}`;
  return `Repository access is not set up yet: ${remaining.length} of ${steps.length} steps remain. Next: ${remaining[0]!.title}`;
}
