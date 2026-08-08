/**
 * Test transport for the Team Host listener, which binds a loopback TCP port.
 *
 * The listener bound an `AF_UNIX` socket before, which `fetch` cannot address —
 * hence this helper. It survives the move to a port because the shape it hides
 * is still worth hiding: tests name an endpoint BEFORE the server starts (they
 * pass it into the server config), so they need a port reserved up front rather
 * than read back after bind.
 */
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';

/**
 * Reserve a free loopback port.
 *
 * Binds :0, reads what the kernel picked, and releases it — so the number is
 * known before the daemon starts and can be passed into its config. There is a
 * window between release and the daemon's bind in which something else could
 * take it; that is acceptable in a test and is why production never does this
 * (the daemon binds :0 itself and reports what it got).
 */
export function teamTestPort(): number {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  const port = (probe.address() as AddressInfo).port;
  probe.close();
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
