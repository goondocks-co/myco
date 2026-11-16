import { GitHubAppError, githubAppAccess, gitHubAppPermissionIssues, type GitHubAppStatus } from '@goondocks/myco-shared/github-app';
import type { ServerEnv } from './adapters.js';

/** Explicit admin refresh, with no persisted identity or token. */
export async function githubAppStatus(env: ServerEnv, now: number): Promise<GitHubAppStatus> {
  const privateKey = env.secrets.GITHUB_APP_PRIVATE_KEY;
  if (!privateKey) return { state: 'key_absent' };
  const clientId = env.secrets.GITHUB_CLIENT_ID;
  if (!clientId) return { state: 'unavailable', reason: 'GitHub sign-in is not configured. Run myco server github-app first.' };
  try {
    const app = await githubAppAccess({ privateKey, clientId, fetchImpl: env.outbound, now: () => now }).identity();
    const missing = gitHubAppPermissionIssues(app);
    return { state: missing.length === 0 ? 'ready' : 'permissions_missing', app, missing };
  } catch (error) {
    if (error instanceof GitHubAppError) return { state: 'unavailable', reason: error.message };
    throw error;
  }
}
