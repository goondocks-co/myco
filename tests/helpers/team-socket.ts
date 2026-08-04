/**
 * Test transport for the Team Host listener, which binds an `AF_UNIX` socket
 * rather than a loopback TCP port.
 *
 * `fetch` cannot address a unix socket, so these tests can no longer dial a
 * URL. {@link teamFetch} issues the request over the socket via `node:http` and
 * returns a `fetch`-shaped result, so a converted test keeps its original
 * assertions (`res.status`, `res.headers.get(...)`, `await res.json()`).
 *
 * Socket paths must stay short: macOS caps `sun_path` at 104 bytes, and a
 * path under a deep temp dir silently fails `bind()`. {@link teamSocketPath}
 * anchors in `/tmp` with a short random segment for that reason.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

/** A short, unique socket path safe for `bind()` on macOS. */
export function teamSocketPath(tag = 'test'): string {
  const uid = process.getuid?.() ?? 0;
  const rand = Math.random().toString(36).slice(2, 8);
  // Its OWN directory: the listener chmods the socket's parent to 0700, so the
  // parent has to be a directory the test owns, never a shared temp root.
  return path.join(os.tmpdir(), `myco-t-${uid}-${rand}`, `${tag}.sock`);
}

/** Remove a socket file, ignoring absence. */
export function removeSocket(socketPath: string): void {
  try { fs.rmSync(socketPath, { force: true }); } catch { /* already gone */ }
}

export interface TeamResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  json(): Promise<unknown>;
}

/** Issue one HTTP request over the team socket. */
export function teamFetch(
  socketPath: string,
  requestPath: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<TeamResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
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
 * A `fetch`-compatible function bound to a unix socket, for clients that insist
 * on taking a URL and a fetch (the MCP `StreamableHTTPClientTransport`). The URL's
 * host is ignored — only its path and query reach the socket.
 */
export function socketFetch(socketPath: string): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      .forEach((value, key) => { headers[key] = value; });
    const body = init?.body === undefined || init.body === null
      ? undefined
      : typeof init.body === 'string' ? init.body : String(init.body);
    const res = await teamFetch(socketPath, `${url.pathname}${url.search}`, {
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
