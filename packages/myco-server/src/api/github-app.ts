import type { OwnerContext } from '../context.js';
import type { ServerEnv } from '../core/adapters.js';
import { githubAppStatus } from '../core/github-app.js';

export async function handleGitHubApp(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return Response.json(await githubAppStatus(env, ctx.now), { headers: { 'cache-control': 'no-store' } });
}
