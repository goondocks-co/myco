import { createPrivateKey } from 'node:crypto';
import { GITHUB_APP_KEY_MAX_BYTES, GitHubAppError, githubAppAccess, gitHubAppPermissionIssues, type GitHubAppIdentity } from '@goondocks/myco-shared/github-app';

export const IMPORT_NEXT = 'myco server github-app --target <local|cloudflare> --url <deployment-url> --private-key-file <downloaded.pem>';

/** Normalize GitHub's PKCS#1 download to the single-line PKCS#8 infrastructure secret. */
export function normalizeAppKey(pem: string): string {
  let encoded: string;
  try {
    const key = createPrivateKey(pem);
    if (key.asymmetricKeyType !== 'rsa') throw new Error('RSA required');
    encoded = key.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  } catch { throw new Error(`App key was not installed: a valid RSA private key PEM is required. Next: ${IMPORT_NEXT}`); }
  if (encoded.length > GITHUB_APP_KEY_MAX_BYTES) throw new Error(`App key was not installed: encoded key is ${encoded.length} bytes; limit ${GITHUB_APP_KEY_MAX_BYTES}. Generate a smaller RSA key. Next: ${IMPORT_NEXT}`);
  return encoded;
}

export async function proveAppKey(clientId: string, privateKey: string, fetchImpl: typeof fetch): Promise<GitHubAppIdentity> {
  let app: GitHubAppIdentity;
  try { app = await githubAppAccess({ clientId, privateKey, fetchImpl }).identity(); } catch (error) {
    if (error instanceof GitHubAppError) throw new Error(`App key was not installed: ${error.message} Next: ${IMPORT_NEXT}`);
    throw error;
  }
  const missing = gitHubAppPermissionIssues(app);
  if (missing.length > 0) throw new Error(`App key was not installed: ${missing.join(', ')}. Set the required repository permissions to Read-only in GitHub and approve the change. Next: ${IMPORT_NEXT}`);
  return app;
}

export function appExtensionInstructions(log: (line: string) => void): void {
  log('Extend the existing sign-in App at https://github.com/settings/apps (or the owning organization’s Settings → Developer settings → GitHub Apps). Match its Client ID to this Deployment.');
  log('1. Open Permissions & events. Set repository Contents, Pull requests and Metadata to Read-only; save. Leave account permissions and the sign-in callback unchanged.');
  log('2. Approve the new permissions for existing installations in GitHub → Settings → Applications → Installed GitHub Apps → Configure.');
  log('3. Open the App’s General page → Private keys → Generate a private key. Import the downloaded PEM:');
  log(`   ${IMPORT_NEXT} (or pipe the PEM to --private-key-stdin).`);
  log('4. Check Settings → Sign-in and access → GitHub App in the dashboard, and sign in once to confirm. Remove the downloaded PEM after a successful import.');
}
