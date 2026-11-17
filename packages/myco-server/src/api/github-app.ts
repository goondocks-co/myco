import type { OwnerContext } from '../context.js';
import type { ServerEnv } from '../core/adapters.js';
import { GitHubAccessRefused, githubAppProjects, githubAppStatus, MAX_REPOSITORY_PAGE } from '../core/github-app.js';
import { badRequest, ok, readJsonObject } from './scope.js';

const NO_STORE = { 'cache-control': 'no-store' };

/** A refusal from GitHub access, in the reader's words; anything else propagates. */
export function githubRefusal(error: unknown): Response {
  if (!(error instanceof GitHubAccessRefused)) throw error;
  const status = error.failure === 'github_unavailable' || error.failure === 'rate_limited' ? 503 : 409;
  return Response.json({ error: 'github_access', failure: error.failure, reason: error.message }, { status, headers: NO_STORE });
}

const positiveId = (raw: unknown): number | null => {
  const value = typeof raw === 'string' && /^[1-9][0-9]{0,15}$/.test(raw) ? Number(raw) : raw;
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : null;
};

export async function handleGitHubApp(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  return Response.json(await githubAppStatus(env, ctx.now), { headers: NO_STORE });
}

/** Every installation of the App and which accounts this server approved: asked of GitHub on an admin's refresh. */
export async function handleGitHubAppInstallations(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  try { return Response.json(await githubAppProjects(env, () => ctx.now).installations(), { headers: NO_STORE }); }
  catch (error) { return githubRefusal(error); }
}

/** One page of an approved installation's repositories. */
export async function handleGitHubAppRepositories(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const installationId = positiveId(ctx.params.installationId);
  const page = positiveId(new URL(ctx.request.url).searchParams.get('page') ?? '1');
  if (installationId === null) return badRequest('installationId is GitHub’s numeric installation id.');
  if (page === null || page > MAX_REPOSITORY_PAGE) return badRequest(`page is a whole number from 1 to ${MAX_REPOSITORY_PAGE}.`);
  try { return Response.json(await githubAppProjects(env, () => ctx.now).repositories(installationId, page), { headers: NO_STORE }); }
  catch (error) { return githubRefusal(error); }
}

/** Approves the GitHub account that holds an installation; GitHub names the account, never the request. */
export async function handleApproveGitHubAccount(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const body = await readJsonObject(ctx.request);
  const installationId = positiveId(body?.installationId);
  if (installationId === null) return badRequest('Nothing was approved: send { installationId } with GitHub’s numeric installation id.');
  try { return ok({ account: await githubAppProjects(env, () => ctx.now).approve(installationId, ctx.member.id, ctx.now) }); }
  catch (error) { return githubRefusal(error); }
}

/** Withdraws an account's approval; its installations are no longer offered, saved or minted for. */
export async function handleWithdrawGitHubAccount(env: ServerEnv, ctx: OwnerContext): Promise<Response> {
  const accountId = positiveId(ctx.params.accountId);
  if (accountId === null) return badRequest('accountId is GitHub’s numeric account id.');
  return ok({ withdrawn: await githubAppProjects(env).withdraw(accountId) });
}
