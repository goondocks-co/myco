/**
 * A stand-in for the Tailscale Funnel edge: a real HTTPS server that forwards
 * every request to a unix socket.
 *
 * This exists so member→host tests exercise the ACTUAL transport — `https.request`
 * against a real TLS endpoint, the real `host_url` parsing, the real pathname on
 * the wire — instead of an injected dialer that would pass whatever the test
 * hands it. The two things it cannot fake (a public tailnet name, Tailscale's
 * own routing) are precisely the parts no test can assert anyway.
 *
 * WHAT IT COPIES FROM THE REAL EDGE, deliberately:
 *   - MOUNT-PREFIX STRIPPING, read from {@link TEAM_FUNNEL_MOUNT}. Funnel strips
 *     a `--set-path` mount before proxying, so this does too; at the root mount
 *     that is the identity function and paths arrive byte-identical.
 *
 *     NOT a gate on the mount constant, and this file must not be read as one:
 *     a member's `host_url` cannot carry a path (`parseHostUrl` refuses it), so
 *     a member never sends a prefix for a non-root mount to strip — flipping the
 *     constant leaves these suites green. The mount is gated at the mechanism
 *     instead, in `tests/team-host/funnel.test.ts`, which asserts activation
 *     emits no `--set-path`.
 *   - `Host` is rewritten to the edge's own authority, exactly as Funnel does.
 *     That is why the host side cannot gate on a Host allowlist.
 *
 * TLS uses a throwaway self-signed cert generated per process via `openssl`, and
 * trust is installed by adding the cert to `https.globalAgent` — NOT by
 * disabling verification. Production `defaultDial` issues a plain
 * `https.request` with no agent override, so it uses that global agent: the
 * dial under test is the real one, unmodified.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';

import { TEAM_FUNNEL_MOUNT } from '@myco/constants.js';

export interface FunnelEdge {
  /** The `host_url` a member records for this host. */
  url: string;
  /** Requests this edge forwarded, in order — pathname exactly as received. */
  seenPaths: string[];
  /** The `Host` header each request ARRIVED with, before the edge rewrote it.
   *  The only place a member's claimed authority is observable, since the real
   *  edge replaces it before the origin ever sees it. */
  seenHosts: string[];
  close(): Promise<void>;
}

/** Where the edge forwards: a unix socket (the real team listener) or a
 *  loopback port (an HTTP fixture standing in for one). */
export type EdgeTarget = { socketPath: string } | { port: number };

interface SelfSignedCert {
  key: string;
  cert: string;
}

let cachedCert: SelfSignedCert | null = null;
let installedCa = false;

/** One cert per process — generation is the slow part, and every edge in a
 *  suite can share it (they all serve `localhost`). */
function selfSignedCert(): SelfSignedCert {
  if (cachedCert) return cachedCert;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-funnel-edge-cert-'));
  const keyPath = path.join(dir, 'key.pem');
  const certPath = path.join(dir, 'cert.pem');
  try {
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', certPath,
      '-days', '1', '-subj', '/CN=localhost',
      '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1',
    ], { stdio: 'ignore' });
  } catch (error) {
    // Fail with the actual cause. Without this, an absent or too-old `openssl`
    // surfaces as an opaque spawn error repeated across every suite that dials
    // a host, and looks like a transport regression rather than a toolchain
    // gap. (`-addext` needs OpenSSL ≥1.1.1 or LibreSSL ≥3.1; macOS's stock
    // LibreSSL 3.3.x supports it, verified including the SAN.)
    throw new Error(
      'The team-transport suites need `openssl` on PATH to mint a throwaway TLS cert for the '
      + `Funnel-edge fixture, and it could not be run: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  cachedCert = { key: fs.readFileSync(keyPath, 'utf-8'), cert: fs.readFileSync(certPath, 'utf-8') };
  fs.rmSync(dir, { recursive: true, force: true });
  return cachedCert;
}

/**
 * Reproduce Funnel's mount-prefix strip for whatever mount the team surface is
 * configured to use. At the root mount this is the identity function — which is
 * the entire reason the team surface mounts at root.
 */
function stripMount(requestPath: string): string {
  if (TEAM_FUNNEL_MOUNT === '/') return requestPath;
  const prefix = TEAM_FUNNEL_MOUNT.replace(/\/$/, '');
  if (requestPath === prefix) return '/';
  if (requestPath.startsWith(`${prefix}/`)) return requestPath.slice(prefix.length);
  return requestPath;
}

/**
 * Trust this process's edge cert on the DEFAULT agent — the one production
 * `https.request` calls use when given no agent of their own.
 *
 * ADDS to the trust store rather than replacing it. `options.ca` is `undefined`
 * by default, meaning "use the built-ins", so assigning `[cert]` would quietly
 * make this process trust ONLY the throwaway cert — after which any later test
 * asserting that a real self-signed cert is rejected would pass for the wrong
 * reason. Seeding from `tls.rootCertificates` keeps the default set intact.
 */
function trustEdgeCert(cert: string): void {
  if (installedCa) return;
  const existing = https.globalAgent.options.ca;
  const base = existing === undefined
    ? [...tls.rootCertificates]
    : Array.isArray(existing) ? [...existing] : [existing];
  https.globalAgent.options.ca = [...base, cert] as string[];
  installedCa = true;
}

/**
 * Publish a unix socket behind real HTTPS.
 *
 * Returns once the edge is listening. `seenPaths` accumulates every forwarded
 * request path, so a test can assert what actually crossed the wire rather than
 * what it intended to send.
 */
export async function startFunnelEdge(target: EdgeTarget | string): Promise<FunnelEdge> {
  const upstreamTarget: EdgeTarget = typeof target === 'string' ? { socketPath: target } : target;
  const { key, cert } = selfSignedCert();
  trustEdgeCert(cert);
  const seenPaths: string[] = [];
  const seenHosts: string[] = [];

  const server = https.createServer({ key, cert }, (req, res) => {
    const forwardedPath = stripMount(req.url ?? '/');
    seenPaths.push(forwardedPath);
    seenHosts.push(req.headers.host ?? '');
    const headers = { ...req.headers };
    // The edge terminates the client's connection and opens its own, so
    // hop-by-hop framing headers must not be copied forward.
    delete headers.connection;
    delete headers['content-length'];
    delete headers['transfer-encoding'];
    // Funnel presents its own authority to the origin. Reproducing that is the
    // point: a host that gated on the member's Host header would pass this test
    // only by accident.
    headers.host = 'funnel-edge.invalid';

    const upstream = http.request(
      {
        ...('socketPath' in upstreamTarget
          ? { socketPath: upstreamTarget.socketPath }
          : { host: '127.0.0.1', port: upstreamTarget.port }),
        method: req.method,
        path: forwardedPath,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on('error', () => {
      // What the real edge does when nothing is behind it — the signal the
      // host's own postcondition probe reads as "published but not serving".
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway' }));
    });
    // A client that hangs up mid-stream must tear the upstream leg down with
    // it, or the origin keeps writing into a connection nobody is reading —
    // which is exactly how a real edge behaves, and what a proxy's
    // disconnect-propagation test needs in order to observe anything.
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.on('aborted', () => upstream.destroy());
    req.pipe(upstream);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as { port: number }).port;

  return {
    url: `https://localhost:${port}`,
    seenPaths,
    seenHosts,
    // `close()` alone waits for every open connection to end, which a test
    // that deliberately leaves a stream half-open never satisfies — the hook
    // hangs instead of failing. Force sockets shut first, the same discipline
    // the other fixture servers in these suites use.
    close: () => new Promise<void>((resolve) => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}
