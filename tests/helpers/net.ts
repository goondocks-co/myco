/**
 * Shared network helpers for daemon-discovery tests.
 *
 * Two recurring needs across hook/daemon tests, both addressing the same
 * failure class: a test that binds (or talks to) a *fixed* port can collide
 * with a live daemon, a sibling test, or — most insidiously — an orphaned
 * bun `--isolate` worker that survived a killed/interrupted run still holding
 * that port. A fixed-port bind then fails with EADDRINUSE; a fixed-port
 * connect can wait forever. Both surface as the recurring "test suite hang".
 *
 * Use these instead of hardcoding a port:
 *
 *   - `listenEphemeral(handler)` — bind an http server on an OS-assigned
 *     ephemeral port (`listen(0)`) and return both the server and the actual
 *     bound port. A fresh port every run means a leftover holder from a prior
 *     run can never collide. This is the right default for "I need a stub
 *     server and any free port will do".
 *
 *   - `findBindablePort()` / `withBindablePort(fn)` — when a test must use a
 *     *specific derived* port (e.g. the daemon's canonical port for a given
 *     MYCO_HOME), probe it first and only proceed once it is actually
 *     bindable, retrying with a fresh derivation otherwise. Mirrors the
 *     `canBindPort` retry loop in client-get-info-async.test.ts.
 *
 *   - `fetchWithTimeout(url, ms)` — bound every daemon connect/health probe
 *     with a short AbortSignal timeout so a collision fails FAST and VISIBLY
 *     instead of hanging. Defense in depth: the ephemeral/verified-bindable
 *     port is the primary fix (no collision); the timeout guarantees a future
 *     collision surfaces as a clear error, not a wedge.
 */
import http from 'node:http';

/** Default ceiling for daemon connect/health probes in tests. */
export const TEST_FETCH_TIMEOUT_MS = 2_000;

/**
 * Bind an http server on an OS-assigned ephemeral port. Returns the live
 * server plus the actual port it bound to. Always prefer this over a
 * hardcoded port: a fresh port each run is collision-proof against live
 * daemons, sibling tests, and orphaned bun workers from interrupted runs.
 */
export async function listenEphemeral(
  handler: http.RequestListener,
): Promise<{ server: http.Server; port: number }> {
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  return { server, port };
}

/** Close an http server, resolving once the listener has fully released. */
export async function closeServer(server: http.Server | null | undefined): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/**
 * Probe whether `port` is currently bindable on 127.0.0.1. Resolves false on
 * any bind error (EADDRINUSE etc.) — never throws, never hangs.
 */
export async function canBindPort(port: number): Promise<boolean> {
  const probe = http.createServer((_req, res) => res.end());
  return new Promise<boolean>((resolve) => {
    probe.once('error', () => resolve(false));
    probe.listen(port, '127.0.0.1', () => {
      probe.close(() => resolve(true));
    });
  });
}

/**
 * Derive candidate ports and return the first that is actually bindable.
 * `derive` produces a fresh candidate each attempt (e.g. the canonical port
 * for a freshly-minted temp MYCO_HOME). Throws after `attempts` exhausted so
 * a genuinely blocked environment fails loudly rather than hanging.
 */
export async function findBindablePort(
  derive: () => number,
  attempts = 100,
): Promise<number> {
  for (let i = 0; i < attempts; i += 1) {
    const candidate = derive();
    if (await canBindPort(candidate)) return candidate;
  }
  throw new Error('findBindablePort: no bindable port after ' + attempts + ' attempts');
}

/**
 * fetch with a bounded timeout. A daemon connect/health probe that targets a
 * dead or collided port must fail fast — never hang the suite.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = TEST_FETCH_TIMEOUT_MS,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}
