/**
 * A Team Host's public address, and what a member can conclude when dialing it
 * fails.
 *
 * A host is reached at one absolute HTTPS URL — its Tailscale Funnel origin,
 * `https://<machine>.<tailnet>.ts.net:8443`. That URL is the host's identity as
 * far as a member is concerned: there is no overlay to join, no control plane
 * to resolve it against, and no second address to fall back to. Which means a
 * member holding a stale URL and a member whose network blocks the port look
 * identical from the outside — both just fail to connect — and telling a user
 * "host unreachable" for either is unactionable. {@link probeHostReachability}
 * exists to separate them.
 *
 * The URL is stored verbatim on the {@link HostRecord} as `host_url` and is the
 * ONLY dial input; `hostAuthority` and `defaultDial` (`daemon/host-proxy.ts`)
 * both derive from it so an origin that parses here is dialable everywhere.
 */
import dns from 'node:dns/promises';
import net from 'node:net';
import https from 'node:https';

import {
  EXTERNAL_MCP_FUNNEL_PORT,
  HOST_PROTOCOL_HEADER,
  HOST_PROXY_CONNECT_TIMEOUT_MS,
  HOST_PROXY_HEADERS_TIMEOUT_MS,
  TEAM_FUNNEL_PORT,
} from '../constants.js';

/** A validated host URL, split into the pieces the transport needs. */
export interface ParsedHostUrl {
  /** `https://host[:port]` — no trailing slash, no path, query, or fragment. */
  origin: string;
  /** `host[:port]` — the Host header / TLS SNI authority. */
  authority: string;
  hostname: string;
  port: number;
}

/**
 * Parse and validate a host URL, or throw.
 *
 * Deliberately strict about the path: the team Funnel is ROOT-mounted so every
 * member request's pathname reaches the host byte-identical, and a `host_url`
 * carrying a path prefix would silently reintroduce exactly the rewriting that
 * mounting at root avoids — every proxied pathname shifted, every route-stamp
 * lookup missing. A URL with a path is rejected at the point it is recorded,
 * not diagnosed later from a wall of 404s.
 */
export function parseHostUrl(hostUrl: string): ParsedHostUrl {
  let url: URL;
  try {
    url = new URL(hostUrl);
  } catch {
    throw new Error(`Host URL ${JSON.stringify(hostUrl)} is not a URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`Host URL ${JSON.stringify(hostUrl)} must be https (a host is reached over the public internet).`);
  }
  if (!url.hostname) {
    throw new Error(`Host URL ${JSON.stringify(hostUrl)} has no hostname.`);
  }
  if (url.username || url.password) {
    throw new Error(`Host URL ${JSON.stringify(hostUrl)} must not carry credentials — the bearer is stored separately.`);
  }
  if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
    throw new Error(
      `Host URL ${JSON.stringify(hostUrl)} must be an origin with no path, query, or fragment — `
      + 'the team Funnel is mounted at the root so member pathnames arrive unchanged.',
    );
  }
  const port = url.port ? Number(url.port) : 443;
  return {
    origin: `${url.protocol}//${url.host}`,
    authority: url.host,
    hostname: url.hostname,
    port,
  };
}

/** Whether a value is a well-formed host URL. Total — never throws. */
export function isValidHostUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    parseHostUrl(value);
    return true;
  } catch {
    return false;
  }
}

/** Normalize a host URL to its bare origin, or throw if it is not one. */
export function normalizeHostUrl(hostUrl: string): string {
  return parseHostUrl(hostUrl).origin;
}

/** Build a host URL from the tailnet authority a Funnel activation reports. */
export function hostUrlFromAuthority(authority: string): string {
  return normalizeHostUrl(`https://${authority}`);
}

// ---------------------------------------------------------------------------
// Reachability
// ---------------------------------------------------------------------------

/**
 * Why a host could not be reached. Each value names a DIFFERENT user action,
 * which is the entire reason the classification exists — a single
 * "unreachable" tells a user nothing about whether to fix their network,
 * re-join the host, or go wake the host machine.
 */
export type HostUnreachableReason =
  /** The name does not resolve. The host was renamed, or its tailnet was —
   *  the stored URL is dead and only a re-join can replace it. */
  | 'address_changed'
  /** The name resolves and the Tailscale edge is reachable on 443, but the
   *  team port is not — this network blocks outbound 8443. */
  | 'port_blocked'
  /** Nothing on this network reaches the edge at all. */
  | 'network_unreachable'
  /** The edge answered but nothing is serving behind it — the host daemon is
   *  down, or its Funnel points somewhere nothing listens. */
  | 'host_not_serving';

export type HostReachability =
  | { state: 'reachable'; protocolVersion: number | null; detail: string }
  | { state: 'unreachable'; reason: HostUnreachableReason; detail: string }
  /** No conclusion is possible — the record carries no usable URL. */
  | { state: 'unknown'; detail: string };

/** The unauthenticated route the probe hits. Chosen because it exists on every
 *  daemon and is cheap; the probe does not depend on it being PUBLIC. */
export const HOST_HEALTH_PROBE_PATH = '/health';

export interface HostProbeDeps {
  /** Issue the HTTPS probe request. Injectable so tests drive fixtures. */
  request?: (origin: string) => Promise<{ status: number; protocolVersion: number | null }>;
  /** TCP-connect check used to tell a blocked port from an unreachable edge. */
  canConnect?: (hostname: string, port: number) => Promise<boolean>;
  /** Does this name resolve at all? Separates a renamed host from a network
   *  problem. */
  resolves?: (hostname: string) => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Whether a name resolves, asked DIRECTLY rather than inferred from a failed
 * request's error code.
 *
 * Inferring was wrong: a machine behind a resolver that answers NXDOMAIN with
 * an address — a captive portal, some ISP resolvers, a search-domain suffix —
 * produces ECONNREFUSED for a name that does not exist, and the probe would
 * report a network problem for a host that had simply been renamed. Asking the
 * resolver is one cheap call and it answers the actual question.
 */
async function defaultResolves(hostname: string): Promise<boolean> {
  try {
    await dns.lookup(hostname);
    return true;
  } catch {
    return false;
  }
}

function defaultCanConnect(hostname: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host: hostname, port });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * Issue the probe request, and ALWAYS settle.
 *
 * The obvious shape — `setTimeout(() => req.destroy(err))` plus `once('error')`
 * — does not settle under Bun, which is the runtime Myco ships. Measured on the
 * pinned 1.3.13 and on 1.3.14, against a TLS server that accepts the connection
 * and never answers: the timeout callback fires, but `destroy(err)` emits no
 * `'error'`, so the promise is simply abandoned. Node rejects at ~400ms; Bun
 * waits forever.
 *
 * That failure mode is not hypothetical here — accept-then-never-answer is
 * exactly what a published-but-unserved Funnel does, so the shape handled the
 * 502 variant and hung on the silent one. A hung probe stalls whatever
 * awaits it: the boot publish, the Team page's health read (permanently
 * "checking", never re-probed, because the single-flight map holds the pending
 * promise), and `myco doctor`.
 *
 * So the settle does not depend on any one event: an explicit rejection inside
 * the timeout, plus `'close'` as the backstop for a socket that goes away
 * without ever emitting `'error'`.
 */
function defaultRequest(
  origin: string,
  timeoutMs: number,
): Promise<{ status: number; protocolVersion: number | null }> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const succeed = (value: { status: number; protocolVersion: number | null }): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: Error): void => {
      if (settled) return;
      settled = true;
      reject(error);
    };

    const req = https.request(
      `${origin}${HOST_HEALTH_PROBE_PATH}`,
      { method: 'GET' },
      (res) => {
        // The body is irrelevant — the STATUS is the whole signal. Resume the
        // stream so the socket can close rather than leaking a paused response.
        res.resume();
        const raw = res.headers[HOST_PROTOCOL_HEADER.toLowerCase()];
        const reported = Array.isArray(raw) ? raw[0] : raw;
        const parsed = reported === undefined ? Number.NaN : Number(reported);
        succeed({
          status: res.statusCode ?? 0,
          protocolVersion: Number.isSafeInteger(parsed) ? parsed : null,
        });
      },
    );
    const timer = setTimeout(() => {
      // Reject HERE rather than relying on `destroy(err)` surfacing as
      // `'error'` — that is the part Bun does not do.
      fail(new Error('host probe timed out'));
      req.destroy();
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    req.once('error', fail);
    // Backstop: a connection that goes away without an `'error'` still settles.
    req.once('close', () => fail(new Error('host probe closed without a response')));
    req.once('response', () => clearTimeout(timer));
    req.end();
  });
}

/**
 * Probe a host's public URL and classify the outcome.
 *
 * **An unauthenticated 401 is a SUCCESS.** It proves the host's daemon answered
 * — the Funnel edge routed to the listener and its token gate
 * refused an anonymous caller, which is precisely the behavior a healthy host
 * has. Anything that "fixes" the 401 into a 200 has widened the public surface.
 * A 502, by contrast, is the edge failing to reach the listener at all — the
 * daemon is down, or the Funnel handler points at a port nothing holds.
 *
 * When the connection itself fails, a control connect to the Tailscale edge on
 * {@link EXTERNAL_MCP_FUNNEL_PORT} separates a locally-blocked team port from a
 * genuinely unreachable network. Without that control probe both cases produce
 * the same ECONNREFUSED/ETIMEDOUT and the user is told to check the wrong
 * thing.
 */
export async function probeHostReachability(
  hostUrl: string | undefined | null,
  deps: HostProbeDeps = {},
): Promise<HostReachability> {
  if (!hostUrl) {
    return {
      state: 'unknown',
      detail: 'This host record has no address — it predates the current transport. Re-join the host to get its public URL.',
    };
  }
  let parsed: ParsedHostUrl;
  try {
    parsed = parseHostUrl(hostUrl);
  } catch (error) {
    return {
      state: 'unknown',
      detail: `This host record's address is not usable (${error instanceof Error ? error.message : String(error)}). Re-join the host.`,
    };
  }

  const timeoutMs = deps.timeoutMs ?? HOST_PROXY_HEADERS_TIMEOUT_MS;
  const request = deps.request ?? ((origin: string) => defaultRequest(origin, timeoutMs));
  const canConnect = deps.canConnect
    ?? ((hostname: string, port: number) => defaultCanConnect(hostname, port, HOST_PROXY_CONNECT_TIMEOUT_MS));
  const resolves = deps.resolves ?? defaultResolves;

  let status: number;
  let protocolVersion: number | null;
  try {
    ({ status, protocolVersion } = await request(parsed.origin));
  } catch (error) {
    if (!await resolves(parsed.hostname)) {
      return {
        state: 'unreachable',
        reason: 'address_changed',
        detail: `${parsed.hostname} no longer resolves. A host's address changes when the machine or its tailnet is renamed — re-join the host to pick up its new URL.`,
      };
    }
    // The name resolves but the connection did not complete. Ask the edge on
    // the port everything permits: if THAT connects, egress works and the team
    // port specifically is being filtered.
    const edgeReachable = parsed.port !== EXTERNAL_MCP_FUNNEL_PORT
      && await canConnect(parsed.hostname, EXTERNAL_MCP_FUNNEL_PORT);
    if (edgeReachable) {
      return {
        state: 'unreachable',
        reason: 'port_blocked',
        detail: `${parsed.hostname} is reachable, but port ${parsed.port} is not — this network blocks it. Team hosts serve on ${TEAM_FUNNEL_PORT}; a restrictive network that allows only 443 cannot reach one.`,
      };
    }
    return {
      state: 'unreachable',
      reason: 'network_unreachable',
      detail: `Could not open a connection to ${parsed.authority}: ${error instanceof Error ? error.message : String(error)}.`,
    };
  }

  // 401 is the healthy anonymous answer; 200 means the route is public. Both
  // prove the daemon answered, which is all reachability claims.
  if (status === 200 || status === 401) {
    return {
      state: 'reachable',
      protocolVersion,
      detail: `${parsed.authority} answered (HTTP ${status}).`,
    };
  }
  if (status === 502 || status === 503 || status === 504) {
    return {
      state: 'unreachable',
      reason: 'host_not_serving',
      detail: `${parsed.authority} is published but nothing is serving behind it (HTTP ${status}). The host's daemon is down, or its Tailscale cannot proxy to the team socket.`,
    };
  }
  return {
    state: 'unreachable',
    reason: 'host_not_serving',
    detail: `${parsed.authority} answered HTTP ${status}, which no healthy host returns to an anonymous request.`,
  };
}
