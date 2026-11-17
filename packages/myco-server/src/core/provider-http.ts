import type { OutboundFetch } from './adapters.js';

const EXPECTED_STATUS = 200;
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

interface ProviderRequest {
  url: string;
  credential: string | null;
  body: unknown;
  signal: AbortSignal;
}
type RefusalKind = 'redirect' | 'http';
type RefuseResponse = (response: Response, kind: RefusalKind) => Error | Promise<Error>;

/** JSON provider calls require HTTP 200 and keep credentials at their configured endpoint. */
export function providerHttp(outbound: OutboundFetch, refuse: RefuseResponse): (request: ProviderRequest) => Promise<Response> {
  return async ({ url, credential, body, signal }: ProviderRequest): Promise<Response> => {
    const headers = new Headers({ 'content-type': 'application/json' });
    if (credential !== null) headers.set('authorization', `Bearer ${credential}`);
    const response = await outbound(url, {
      // Workers supports manual/follow redirect modes; redirects require an explicit response check.
      // https://developers.cloudflare.com/workers/runtime-apis/request/#requestinit
      method: 'POST', redirect: 'manual', signal,
      headers,
      body: JSON.stringify(body),
    });
    if (response.status === EXPECTED_STATUS) return response;
    throw await refuse(response, REDIRECT_STATUSES.has(response.status) ? 'redirect' : 'http');
  };
}
