import type { OutboundFetch } from '@myco-server-worker/core/adapters.js';
import type { RegisteredApp } from '@myco/server/github-app.js';

export const SETUP_APP: RegisteredApp = {
  clientId: 'setup-fixture-client', clientSecret: 'setup-fixture-secret',
  slug: 'setup-fixture', htmlUrl: 'https://github.com/apps/setup-fixture',
  name: 'Myco (setup.invalid)', ownerLogin: 'setup-owner',
};
export const SETUP_IDENTITIES = {
  owner: { id: 583231, login: 'setup-owner' },
  teammate: { id: 770001, login: 'setup-teammate' },
} as const;

/** GitHub's conversion and OAuth endpoints, with no network fallback. */
export function fakeGitHub() {
  const calls: ReturnType<Request['clone']>[] = [];
  const fetchImpl: OutboundFetch = async (input, init) => {
    const request = new Request(input, init);
    calls.push(request.clone());
    if (request.url === 'https://api.github.com/app-manifests/setup-conversion/conversions' && request.method === 'POST') {
      return Response.json({
        client_id: SETUP_APP.clientId, client_secret: SETUP_APP.clientSecret,
        slug: SETUP_APP.slug, html_url: SETUP_APP.htmlUrl, name: SETUP_APP.name,
        owner: { login: SETUP_APP.ownerLogin },
      }, { status: 201 });
    }
    if (request.url === 'https://github.com/login/oauth/access_token' && request.method === 'POST') {
      const body = await request.json() as { code: string; client_id: string; client_secret: string };
      if (body.client_id !== SETUP_APP.clientId || body.client_secret !== SETUP_APP.clientSecret) {
        throw new Error('fake GitHub: wrong app credentials');
      }
      if (body.code === 'owner' || body.code === 'teammate') return Response.json({ access_token: `fixture-${body.code}` });
    }
    if (request.url === 'https://api.github.com/user' && request.method === 'GET') {
      const identity = request.headers.get('authorization')?.replace('Bearer fixture-', '');
      if (identity === 'owner' || identity === 'teammate') return Response.json(SETUP_IDENTITIES[identity]);
    }
    throw new Error(`fake GitHub: unexpected request ${request.method} ${request.url}`);
  };
  // Registration's fetch type also carries Bun's preconnect helper.
  const registrationFetch: typeof fetch = Object.assign(fetchImpl, { preconnect: () => {} });
  return { fetchImpl, registrationFetch, calls };
}
