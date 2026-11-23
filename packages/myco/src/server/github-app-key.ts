import { createPrivateKey } from 'node:crypto';
import { GITHUB_APP_KEY_MAX_BYTES, githubAppAccess, gitHubAppPermissionIssues, type GitHubAppIdentity } from '@goondocks/myco-shared/github-app';
import { GitHubAppError } from '@goondocks/myco-shared/github-api';
import {
  appSettingsLocation, GITHUB_APP_SETUP_PATH, GITHUB_APPS_LISTS, githubAppPages, keyImportCommands, ownerWords, SETUP_WORDS, type KnownApp, type OperatorTarget,
} from '@goondocks/myco-shared/github-app-setup';

/** Normalize GitHub's PKCS#1 download to the single-line PKCS#8 infrastructure secret. `next` is the exact import command. */
export function normalizeAppKey(pem: string, next: string): string {
  let encoded: string;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('RSA required');
    encoded = key.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  } catch { throw new Error(`App key was not installed: a valid RSA private key PEM is required. Next: ${next}`); }
  if (encoded.length > GITHUB_APP_KEY_MAX_BYTES) throw new Error(`App key was not installed: encoded key is ${encoded.length} bytes; limit ${GITHUB_APP_KEY_MAX_BYTES}. Generate a smaller RSA key. Next: ${next}`);
  return encoded;
}

export async function proveAppKey(clientId: string, privateKey: string, fetchImpl: typeof fetch, next: string): Promise<GitHubAppIdentity> {
  let app: GitHubAppIdentity;
  try { app = await githubAppAccess({ clientId, privateKey, fetchImpl }).identity(); } catch (error) {
    if (error instanceof GitHubAppError) throw new Error(`App key was not installed: ${error.message} Next: ${next}`);
    throw error;
  }
  const missing = gitHubAppPermissionIssues(app);
  if (missing.length > 0) throw new Error(`App key was not installed: ${missing.join(', ')}. Set the required repository permissions to Read-only in GitHub and approve the change. Next: ${next}`);
  return app;
}

/** What the operator knows of the App: identified by GitHub, or only its expected name and why GitHub did not say more. */
export type AppFinding = { app: KnownApp } | { app: null; expectedName: string; clientId: string; lookupError: string | null };

/**
 * The steps that remain for repository access, with the App's own pages and this Deployment's exact command: the
 * dashboard's checklist, as the operator's terminal prints it. With the key installed, only installing and connecting remain.
 */
export function repositoryAccessSteps(log: (line: string) => void, options: { target: OperatorTarget; origin: string; finding: AppFinding; keyInstalled: boolean }): void {
  const { finding } = options;
  const pages = finding.app === null ? null : githubAppPages(finding.app.slug, finding.app.owner);
  const settings = pages?.settings ?? null;
  if (finding.app === null) {
    log(SETUP_WORDS.find(finding.expectedName, finding.clientId));
    log(`  Your Apps: ${GITHUB_APPS_LISTS.personal}  Your organizations: ${GITHUB_APPS_LISTS.organizations}`);
    if (finding.lookupError !== null) log(`  GitHub’s public page for the App did not answer: ${finding.lookupError}`);
  } else {
    log(`This server’s App is ${finding.app.name}${finding.app.owner === null ? '' : `, owned by ${ownerWords(finding.app.owner)}`}: ${settings ?? pages!.app}`);
    if (finding.app.owner !== null) log(appSettingsLocation(finding.app.owner));
  }
  const steps: Array<[string, string | null, string[]]> = [];
  if (!options.keyInstalled) {
    log(SETUP_WORDS.confirmAccess);
    steps.push(['Permissions', pages?.permissions ?? null, [SETUP_WORDS.permissions, SETUP_WORDS.permissionsAccepted]]);
    steps.push(['Private key', settings, [SETUP_WORDS.key, 'Import it (or pipe the PEM to --private-key-stdin):', ...keyImportCommands(options.target, options.origin).map((line) => `  ${line}`)]]);
  }
  steps.push(['Install', pages?.install ?? null, [SETUP_WORDS.install]]);
  steps.push(['Connect', `${options.origin}${GITHUB_APP_SETUP_PATH}`, ['The dashboard shows what remains, approves the accounts that installed the App and connects Projects to repositories.']]);
  log(options.keyInstalled ? 'Remaining:' : 'Steps:');
  steps.forEach(([title, link, lines], index) => {
    log(`${index + 1}. ${title}${link === null ? '' : `: ${link}`}`);
    for (const line of lines) log(`   ${line}`);
  });
}
