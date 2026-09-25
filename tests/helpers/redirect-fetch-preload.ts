/**
 * A `bun --preload` module for a spawned CLI: every `fetch` whose URL starts
 * with `MYCO_TEST_FETCH_FROM` is sent to the same path under
 * `MYCO_TEST_FETCH_TO` instead. A registry membership must name an `https:`
 * Deployment, so a test serving one on loopback `http:` routes the member's
 * requests to it here, with the command line and the registry left exactly as
 * a member's.
 */
const from = process.env.MYCO_TEST_FETCH_FROM;
const to = process.env.MYCO_TEST_FETCH_TO;

if (from && to) {
  const inner = globalThis.fetch;
  const redirected = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    if (!request.url.startsWith(from)) return inner(request);
    return inner(new Request(`${to}${request.url.slice(from.length)}`, request));
  };
  globalThis.fetch = Object.assign(redirected, { preconnect: inner.preconnect }) as typeof fetch;
}
