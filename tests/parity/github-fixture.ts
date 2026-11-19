/**
 * GitHub, as both parity targets reach it through their own outbound `fetch`: the Deployment's App, one installation by
 * the operator's account and one by a stranger, and the repositories the operator selected. Repository reads answer from
 * the modelled release history. It runs unchanged in Bun and in workerd, so it holds no Node or Bun import.
 *
 * Shapes follow GitHub's documentation:
 * https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app
 * https://docs.github.com/en/rest/apps/apps#list-installations-for-the-authenticated-app
 * https://docs.github.com/en/rest/apps/apps#get-an-installation-for-the-authenticated-app
 * https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app
 * https://docs.github.com/en/rest/apps/installations#list-repositories-accessible-to-the-app-installation
 * https://docs.github.com/en/rest/apps/installations#revoke-an-installation-access-token
 */
import { fakeGithub, REPO } from '../myco-server/helpers/github-fake.ts';

/** The sign-in client id both targets hold, which the App answers to. */
export const PARITY_CLIENT_ID = 'parity-client';
export const PARITY_OPERATOR = { installationId: 41, account: { id: 9001, login: 'operator-org', type: 'Organization' } } as const;
export const PARITY_STRANGER = { installationId: 666, account: { id: 6660, login: 'operat0r-org', type: 'Organization' } } as const;
/** The repositories the operator's installation selected, by `owner/name`. */
export const PARITY_REPOSITORIES = ['example/source', 'example/map', 'example/repo'].map((fullName, index) => ({
  id: 1296269 + index, full_name: fullName, default_branch: 'main', private: true,
}));
const PERMISSIONS = { contents: 'read', pull_requests: 'read', metadata: 'read' };

/** A fresh App key, base64 PKCS#8, generated for this run only. */
export async function parityAppKey(): Promise<string> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']) as CryptoKeyPair;
  return btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))));
}

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** `next` with GitHub's API answered here; every other request goes to `next` unchanged. Like Workers, it refuses a request that would follow a redirect. */
export function parityGitHub(next: Fetch): Fetch {
  const reads = fakeGithub(REPO);
  let issued = 0;
  const installation = (entry: typeof PARITY_OPERATOR | typeof PARITY_STRANGER) => ({ id: entry.installationId, account: entry.account, repository_selection: 'selected', permissions: PERMISSIONS, suspended_at: null });
  const held = (installationId: number) => (installationId === PARITY_OPERATOR.installationId ? PARITY_REPOSITORIES : []);
  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== 'https://api.github.com') return next(input, init);
    if (init?.redirect !== 'manual') throw new TypeError('GitHub requests leave redirects to the caller');
    if (!request.headers.get('authorization')?.startsWith('Bearer ')) return Response.json({ message: 'Requires authentication' }, { status: 401 });
    const path = url.pathname;
    if (request.method === 'GET' && path === '/app') return Response.json({ id: 12345, slug: 'parity-app', client_id: PARITY_CLIENT_ID, permissions: PERMISSIONS });
    if (request.method === 'GET' && path === '/app/installations') return Response.json(url.searchParams.get('page') === '1' || !url.searchParams.has('page') ? [installation(PARITY_OPERATOR), installation(PARITY_STRANGER)] : []);
    let match = /^\/app\/installations\/(\d+)$/.exec(path);
    if (request.method === 'GET' && match) {
      const found = [PARITY_OPERATOR, PARITY_STRANGER].find(entry => entry.installationId === Number(match![1]));
      return found === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json(installation(found));
    }
    match = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(path);
    if (request.method === 'POST' && match) {
      const installationId = Number(match[1]);
      const body = await request.json() as { permissions: Record<string, string>; repository_ids?: number[] };
      const repositories = held(installationId);
      if (body.repository_ids?.some(id => !repositories.some(repository => repository.id === id))) return Response.json({ message: 'Validation Failed' }, { status: 422 });
      issued += 1;
      return Response.json({ token: `ghs_parity_${installationId}_${issued}_${'x'.repeat(40)}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: body.permissions, repository_selection: 'selected',
        repositories: body.repository_ids === undefined ? repositories : repositories.filter(repository => body.repository_ids!.includes(repository.id)) }, { status: 201 });
    }
    const installationOfToken = Number(/^Bearer ghs_parity_(\d+)_/.exec(request.headers.get('authorization')!)?.[1] ?? 0);
    if (request.method === 'DELETE' && path === '/installation/token') return new Response(null, { status: installationOfToken === 0 ? 401 : 204 });
    if (request.method === 'GET' && path === '/installation/repositories') {
      const repositories = held(installationOfToken);
      return Response.json({ total_count: repositories.length, repositories });
    }
    match = /^\/repositories\/(\d+)$/.exec(path);
    if (request.method === 'GET' && match) {
      const repository = held(installationOfToken).find(entry => entry.id === Number(match![1]));
      return repository === undefined ? Response.json({ message: 'Not Found' }, { status: 404 }) : Response.json(repository);
    }
    if (/^\/repositories\/\d+\//.test(path)) return reads(input, init);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  };
}

/** Puts the fixture in front of this runtime's `fetch`, once. */
export function installParityGitHub(): void {
  const scope = globalThis as typeof globalThis & { __parityGitHub?: true };
  if (scope.__parityGitHub) return;
  scope.__parityGitHub = true;
  globalThis.fetch = Object.assign(parityGitHub(globalThis.fetch.bind(globalThis)), { preconnect: () => {} }) as typeof fetch;
}
