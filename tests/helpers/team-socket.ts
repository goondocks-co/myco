/**
 * Test transport for the Team Host listener, which binds a loopback TCP port.
 *
 * `fetch` cannot address the listener by port alone with a stable `Host`
 * header, and the MCP client transport insists on a URL plus a fetch, so both
 * shapes live here: {@link teamFetch} for a single request, {@link portFetch}
 * for a client that wants a `fetch`.
 *
 * NO HELPER HANDS OUT A PORT. A test learns the listener's port the same way
 * production does — from `server.teamPort` after `start()`, the number the
 * kernel actually gave the daemon. Reserving one up front (bind :0, read,
 * close, pass it in) leaves a window in which a parallel test process takes it;
 * the daemon then falls back to an ephemeral port and the test talks to
 * whatever now holds the stale number. `tests/meta/team-port-readback.test.ts`
 * keeps that shape out.
 */
import http from 'node:http';

/**
 * The port the team listener actually bound, refusing the alternative.
 *
 * `server.teamPort` is null until `start()` has bound the listener and stays
 * null when host serving is off. A null reaching {@link teamFetch} would dial a
 * nonsense address several assertions later; this names the setup mistake at
 * the point it is made.
 */
export function boundTeamPort(server: { teamPort: number | null }): number {
  const port = server.teamPort;
  if (port === null) {
    throw new Error('team listener is not bound: start() a server configured with hostServe first');
  }
  return port;
}

export interface TeamResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Issue one HTTP request to the team listener. */
export function teamFetch(
  port: number,
  requestPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TeamResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method: init.method ?? 'GET',
        // The listener has no Host allowlist, but node still sends one; keep it
        // stable so a test never depends on an incidental value.
        headers: { host: 'myco-team.local', ...(init.headers ?? {}) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf-8');
          resolve({
            status: res.statusCode ?? 0,
            headers: {
              get(name: string) {
                const v = res.headers[name.toLowerCase()];
                return v === undefined ? null : (Array.isArray(v) ? v[0]! : String(v));
              },
            },
            text: async () => raw,
            json: async () => JSON.parse(raw),
          });
        });
      },
    );
    req.once('error', reject);
    if (init.body !== undefined) req.write(init.body);
    req.end();
  });
}

/**
 * A `fetch`-compatible function bound to the team listener, for clients that
 * insist on taking a URL and a fetch (the MCP `StreamableHTTPClientTransport`).
 * The URL's host is ignored — only its path and query reach the listener.
 */
export function portFetch(port: number): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .forEach((value, key) => { headers[key] = value; });
    const body = init?.body === undefined || init.body === null
      ? undefined
      : typeof init.body === 'string' ? init.body : String(init.body);
    const res = await teamFetch(port, `${url.pathname}${url.search}`, {
      method: init?.method ?? (input instanceof Request ? input.method : 'GET'),
      headers,
      body,
    });
    const text = await res.text();
    const outHeaders = new Headers();
    for (const name of ['content-type', 'mcp-session-id']) {
      const v = res.headers.get(name);
      if (v !== null) outHeaders.set(name, v);
    }
    return new Response(text, { status: res.status, headers: outHeaders });
  }) as typeof fetch;
}
