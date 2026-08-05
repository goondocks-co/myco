/**
 * Team Host — the member→host proxy forwarder (`host-proxy.ts`).
 *
 * Every test drives the REAL forwarder through a real member HTTP server whose
 * request listener calls `handleAttachedRequest`, forwarding to a real fixture
 * "host" server on localhost. This exercises the actual byte-level relay,
 * unbuffered streaming, client-disconnect propagation, and the collector
 * contract — not a mock of them.
 *
 * Hermetic: `MYCO_HOME` (collector buffer tree) and `MYCO_TEAM_HOME` (attach
 * registry) are fresh tmpdirs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';
import { issueTestMemberToken } from '../helpers/member-token.js';
import { parseHostUrl } from '@myco/host/host-url.js';

import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  handleAttachedRequest,
  isCanopyMcpCall,
  mcpRequestIdFromBody,
  hostProtocolCompatible,
  __resetVersionMismatchLogForTests,
  type HostProxyDeps,
  type ProxyLogger,
  defaultDial,
} from '@myco/daemon/host-proxy';
import { __resetLogThrottleForTests, __setLogThrottleClockForTests } from '@myco/daemon/log-throttle';
import type { RemoteTarget, RouteClassification } from '@myco/host/routing';
import { shouldBufferFallback } from '@myco/hooks/send-event';
import { getMachineId } from '@myco/machine-id';
import { resolveProjectBufferDir } from '@myco/grove/paths';
import { listGroves } from '@myco/grove/registry';
import { readEventId } from '@myco/capture/event-id';
import { REQUEST_CONTEXT_HEADERS } from '@myco/grove/request-context';
import { HOST_MIN_COMPAT_VERSION, HOST_PROTOCOL_HEADER, HOST_PROTOCOL_VERSION, REFUSAL_LOG_THROTTLE_INTERVAL_MS } from '@myco/constants';

const HOST_BEARER = 'host-bearer-secret';

interface Recorded {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

type FixtureResponder = (req: http.IncomingMessage, res: http.ServerResponse, recorded: Recorded) => void;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

/** A fixture "host": records every request it receives and delegates the reply
 *  to the currently-installed responder (default: 200 `{ok:true}`). */
function createFixture() {
  const requests: Recorded[] = [];
  let responder: FixtureResponder = (_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, from: 'host' }));
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf-8'),
      };
      requests.push(recorded);
      responder(req, res, recorded);
    });
  });
  return {
    server,
    requests,
    setResponder(fn: FixtureResponder) { responder = fn; },
  };
}

/** A member daemon front: its request listener hands every request to the real
 *  forwarder with the test-configured target/classification/deps. */
function createMember(getConfig: () => { target: RemoteTarget; classification: RouteClassification; deps?: Partial<HostProxyDeps> }) {
  const server = http.createServer((req, res) => {
    const { target, classification, deps } = getConfig();
    void handleAttachedRequest(req, res, target, classification, deps);
  });
  return server;
}

/**
 * A target pointing at the fixture through a REAL HTTPS edge.
 *
 * The forwarder's job is to build one upstream request and relay its response,
 * and the dial it uses is `https.request` — so the fixture sits behind a TLS
 * edge here rather than being dialed as plain loopback HTTP. Everything these
 * tests assert (headers, timeouts, streaming, refusals) then rides the
 * transport that actually ships.
 */
function makeTarget(hostUrl: string, opts: { protocolVersion?: number } = {}): RemoteTarget {
  return {
    projectId: 'proj_0123456789abcdef0123456789abcdef' as RemoteTarget['projectId'],
    groveId: 'grove_0123456789abcdef0123456789abcdef',
    host: {
      host_id: 'host_0123456789abcdef0123456789abcdef',
      label: 'Mac Studio',
      host_url: hostUrl,
      protocol_version: opts.protocolVersion ?? HOST_PROTOCOL_VERSION,
    },
    bearer: memberToken,
  };
}

function capturingLogger(): { logger: ProxyLogger; warns: Array<[string, unknown]>; errors: Array<[string, unknown]> } {
  const warns: Array<[string, unknown]> = [];
  const errors: Array<[string, unknown]> = [];
  return {
    logger: {
      warn: (m, meta) => warns.push([m, meta]),
      error: (m, meta) => errors.push([m, meta]),
    },
    warns,
    errors,
  };
}

async function waitFor<T>(condition: () => T | undefined, description: string, timeoutMs = 1_000): Promise<T> {
  const started = Date.now();
  while (true) {
    const result = condition();
    if (result !== undefined) return result;
    if (Date.now() - started > timeoutMs) {
      throw new Error(`Timed out waiting for ${description} after ${timeoutMs}ms`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

let memberToken: string;

describe('host-proxy forwarder', () => {
  let tmpHome: string;
  let tmpTeamHome: string;
  let savedHome: string | undefined;
  let savedTeamHome: string | undefined;
  let fixture: ReturnType<typeof createFixture>;
  let fixturePort: number;
  let edge: FunnelEdge;
  let hostUrl: string;
  let member: http.Server;
  let memberPort: number;
  let config: { target: RemoteTarget; classification: RouteClassification; deps?: Partial<HostProxyDeps> };

  beforeEach(async () => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proxy-home-'));
    tmpTeamHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-proxy-team-'));
    savedHome = process.env.MYCO_HOME;
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = tmpHome;
    process.env.MYCO_TEAM_HOME = tmpTeamHome;
    // A REAL issued member token: the shared host bearer is no longer accepted,
    // so a fixture must hold a credential the host actually issued.
    memberToken = issueTestMemberToken();
    __resetVersionMismatchLogForTests();
    __resetLogThrottleForTests();

    fixture = createFixture();
    fixturePort = await listen(fixture.server);
    edge = await startFunnelEdge({ port: fixturePort });
    hostUrl = edge.url;
    config = {
      target: makeTarget(hostUrl),
      classification: { capability: 'Knowledge serving', stamp: 'serve' },
    };
    member = createMember(() => config);
    memberPort = await listen(member);
  });

  afterEach(async () => {
    // Force any lingering keep-alive / half-open sockets closed so a streamed
    // relay left mid-flight by a test can't hang server.close().
    (member as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    (fixture.server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    await edge.close();
    await close(member);
    await close(fixture.server);
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpTeamHome, { recursive: true, force: true });
  });

  const memberUrl = (p: string) => `http://127.0.0.1:${memberPort}${p}`;

  /**
   * Take the host down as a member experiences it: the member's dial must
   * FAIL, which means the public edge goes with the origin behind it. Closing
   * only the origin leaves the edge relaying a 502 — a real state, but a
   * different one ("published, not serving"), and the tests below are about a
   * host the member cannot reach at all.
   */
  const takeHostDown = async (): Promise<void> => {
    await close(fixture.server);
    await edge.close();
  };

  // --- pure helpers ---


  test('the dial CANNOT leave the recorded origin — a TLS attacker receives NOTHING', async () => {
    // Observed, not introspected. The escape is real against the primitive:
    // `'https://host:8443' + '@evil/'` reparses with the host's authority
    // demoted to userinfo and the attacker's as the origin, and this hop
    // attaches the host bearer — so the payoff is bearer exfiltration. A port
    // does not stop it. Nothing reaches it through this proxy today only
    // because llhttp refuses a target whose first byte is `@`, and because
    // every other caller passes a constant or an escaped id; both are
    // properties of OTHER code, and `Dialer` places no constraint on
    // `opts.path`.
    //
    // The attacker is a REAL TLS endpoint this process trusts. That detail is
    // what makes this a gate rather than a restatement: against a plain-HTTP
    // stand-in an escaping dial fails the TLS handshake, so the test passes for
    // the wrong reason and cannot fail on vulnerable code. Verified by
    // reverting to a concatenating dial and watching the attacker get reached.
    const reached: string[] = [];
    const attackerOrigin = http.createServer((req, res) => {
      reached.push(`${req.method} ${req.url} auth=${req.headers.authorization ?? 'none'}`);
      res.writeHead(200); res.end('pwned');
    });
    const attackerOriginPort = await listen(attackerOrigin);
    const attacker = await startFunnelEdge({ port: attackerOriginPort });
    const attackerAuthority = new URL(attacker.url).host;

    try {
      for (const escape of [
        `@${attackerAuthority}/events`,
        `:8443@${attackerAuthority}/events`,
        `https://${attackerAuthority}/events`,
      ]) {
        // A dial that THROWS or errors is a pass — nothing went anywhere. Only
        // being reached is a failure, so each shape is isolated and the
        // assertion is about the attacker's log.
        try {
          const req = await defaultDial(config.target, {
            method: 'GET',
            path: escape,
            headers: { authorization: `Bearer ${memberToken}` },
          });
          await new Promise<void>((resolve) => {
            req.once('error', () => resolve());
            req.once('response', (res) => { res.resume(); res.once('end', () => resolve()); });
            req.end();
            setTimeout(resolve, 1_000);
          });
        } catch { /* rejected before any bytes moved — pass */ }
      }

      expect(reached).toEqual([]);
      expect(attacker.seenPaths).toEqual([]);
    } finally {
      await attacker.close();
      await close(attackerOrigin);
    }
  }, 20_000);

  test('hostProtocolCompatible enforces the inclusive [min,max] window', () => {
    expect(hostProtocolCompatible(HOST_MIN_COMPAT_VERSION)).toBe(true);
    expect(hostProtocolCompatible(HOST_PROTOCOL_VERSION)).toBe(true);
    expect(hostProtocolCompatible(HOST_MIN_COMPAT_VERSION - 1)).toBe(false);
    expect(hostProtocolCompatible(HOST_PROTOCOL_VERSION + 1)).toBe(false);
  });

  test('the transport bump refuses a pre-transport host, not just an ancient one', () => {
    // The reason MIN_COMPAT rose with the version rather than staying at 1:
    // both gates test the INCLUSIVE window, so bumping only the current version
    // would WIDEN the range and admit a v3 host — one whose recorded address is
    // an overlay IP that resolves nowhere. A loud refusal beats a silent
    // timeout, and this is the assertion that keeps it loud.
    expect(hostProtocolCompatible(3)).toBe(false);
    expect(HOST_MIN_COMPAT_VERSION).toBe(HOST_PROTOCOL_VERSION);
  });

  test('isCanopyMcpCall keys on tool name + op/type selector only', () => {
    const call = (name: string, args: Record<string, unknown>) =>
      ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    expect(isCanopyMcpCall(call('myco_cortex', { op: 'canopy_map' }))).toBe(true);
    expect(isCanopyMcpCall(call('myco_cortex', { op: 'canopy_entry', id: 'x:y' }))).toBe(true);
    expect(isCanopyMcpCall(call('myco_cortex', { op: 'digest' }))).toBe(false);
    expect(isCanopyMcpCall(call('myco_search', { type: 'canopy', query: 'secret' }))).toBe(true);
    expect(isCanopyMcpCall(call('myco_search', { type: 'session', query: 'secret' }))).toBe(false);
    // A plain search — no type filter, or the explicit type:"all" — is NOT
    // Canopy: its valid vault hits must proxy, not be refused (the host simply
    // holds no Canopy entries for an attached project).
    expect(isCanopyMcpCall(call('myco_search', { query: 'secret' }))).toBe(false);
    expect(isCanopyMcpCall(call('myco_search', { type: 'all', query: 'secret' }))).toBe(false);
    expect(isCanopyMcpCall(call('myco_plans', { op: 'list' }))).toBe(false);
    // A tools/list or initialize is never a Canopy call.
    expect(isCanopyMcpCall({ jsonrpc: '2.0', id: 1, method: 'tools/list' })).toBe(false);
    // Batch: refuses if any element is Canopy.
    expect(isCanopyMcpCall([call('myco_plans', {}), call('myco_search', { type: 'canopy' })])).toBe(true);
  });

  // --- serve route relay ---

  test('serve route relays byte-faithfully with attach tenancy stamped, bearer swapped, version stamped', async () => {
    fixture.setResponder((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Host-Custom': 'yes' });
      res.end(JSON.stringify({ served: 'by-host' }));
    });
    const res = await fetch(memberUrl('/api/spores?q=1'), {
      headers: {
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
        // The caller's LOCAL grove claim (a checkout's `.myco` binding names a
        // member-side grove the host has never heard of) — the forward must
        // replace it with the attach mapping's grove, or the host 404s the
        // unknown tenancy (D-smoke regression).
        'x-myco-grove-id': 'grove_feedfacefeedfacefeedfacefeedface',
        'x-myco-machine-id': 'machine-A',
        'x-myco-auth': 'LOCAL-BEARER',
      },
    });
    expect(res.status).toBe(201);
    expect(res.headers.get('x-host-custom')).toBe('yes');
    expect(await res.json()).toEqual({ served: 'by-host' });

    const got = fixture.requests[0];
    expect(got.method).toBe('GET');
    expect(got.url).toBe('/api/spores?q=1');
    // TENANCY comes from the attach mapping — the local grove claim above is
    // overwritten; IDENTITY (machine attribution) rides through untouched.
    expect(got.headers['x-myco-project-id']).toBe('proj_0123456789abcdef0123456789abcdef');
    expect(got.headers['x-myco-grove-id']).toBe('grove_0123456789abcdef0123456789abcdef');
    expect(got.headers['x-myco-machine-id']).toBe('machine-A');
    // LOCAL bearer stripped; HOST bearer attached; version header stamped.
    expect(got.headers['x-myco-auth']).toBeUndefined();
    expect(got.headers.authorization).toBe(`Bearer ${memberToken}`);
    expect(got.headers[HOST_PROTOCOL_HEADER]).toBe(String(HOST_PROTOCOL_VERSION));
    // The Host the MEMBER claimed, captured at the edge before it rewrote the
    // header the way Funnel does. This is `hostAuthority(target)`, and it must
    // match the recorded `host_url` — it is the TLS/SNI name the connection is
    // routed by, so a wrong value fails to REACH the host rather than being
    // refused by it.
    expect(edge.seenHosts).toContain(parseHostUrl(hostUrl).authority);
  });

  test('serve route stamps the MEMBER machine id when the inbound request carries none; a caller-supplied one is preserved verbatim', async () => {
    fixture.setResponder((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });

    // Browser-shaped: a dashboard fetch sets no x-myco-machine-id. The caller
    // at this hop is the member daemon, so its own machine id is stamped —
    // without it the host handler's fallback attributes the write to the
    // HOST's machine id (a dashboard-made claim became the host's, and the
    // member's own release then 403'd not_holder).
    await fetch(memberUrl('/api/content-claims'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(fixture.requests[0].headers['x-myco-machine-id']).toBe(getMachineId());

    // Agent-shaped: hooks/MCP clients supply their own machine id — forwarded
    // verbatim, never overwritten.
    await fetch(memberUrl('/api/content-claims'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
        'x-myco-machine-id': 'agent-caller-machine',
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(fixture.requests[1].headers['x-myco-machine-id']).toBe('agent-caller-machine');
  });

  test('serve route strips the inbound browser Origin/Referer/Cookie before forwarding to the host', async () => {
    fixture.setResponder((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    // A dashboard-initiated mutation: the browser sends Origin (+ Referer,
    // Cookie) on the request the member's loopback listener already vetted.
    // This hop is server-to-server; the host's overlay CSRF gate rejects ANY
    // Origin, so a verbatim forward of these would 403 every browser-driven
    // routed mutation (the live-caught regression).
    const res = await fetch(memberUrl('/api/content-claims'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
        origin: 'http://127.0.0.1:19666',
        referer: 'http://127.0.0.1:19666/dashboard',
        cookie: 'session=should-not-cross-the-hop',
      },
      body: JSON.stringify({ artifact_kind: 'skill', artifact_id: 'skill-1' }),
    });
    expect(res.status).toBe(201);

    const got = fixture.requests[0];
    expect(got.headers.origin).toBeUndefined();
    expect(got.headers.referer).toBeUndefined();
    expect(got.headers.cookie).toBeUndefined();
  });

  test('serve/collect route strips the caller x-myco-project-root before forwarding (E-4 W2 T1b — tenancy is the attach mapping, not the caller checkout)', async () => {
    // A hook/MCP client sends `x-myco-project-root` on every request (its LOCAL
    // checkout path). Forwarded verbatim, that member path feeds the host's
    // findRegisteredProject root-equivalence filter and 404s the synthetic-root
    // hosted row registration-on-ingest just admitted. The proxy must drop it —
    // tenancy is the attach mapping's (grove/project overwritten below), never
    // the caller's local claim.
    fixture.setResponder((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    await fetch(memberUrl('/api/spores?q=1'), {
      headers: {
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
        'x-myco-project-root': '/Users/member/checkouts/some-project',
      },
    });
    const got = fixture.requests[0];
    expect(got.headers['x-myco-project-root']).toBeUndefined();
    // Tenancy (grove/project) is still stamped from the attach mapping.
    expect(got.headers['x-myco-grove-id']).toBe('grove_0123456789abcdef0123456789abcdef');
    expect(got.headers['x-myco-project-id']).toBe('proj_0123456789abcdef0123456789abcdef');
  });

  test('serve route with a request body pipes the body through to the host', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    let hostBody = '';
    fixture.setResponder((_req, res, recorded) => {
      hostBody = recorded.body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
    const res = await fetch(memberUrl('/api/some-write'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef' },
      body: JSON.stringify({ hello: 'host' }),
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(hostBody)).toEqual({ hello: 'host' });
  });

  // --- streaming (/mcp) ---

  test('/mcp streams chunks incrementally (unbuffered) and propagates client disconnect', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    let firstChunkAt = 0;
    let secondChunkAt = 0;
    let hostSawClose = false;
    let releaseSecond: () => void;
    const gotFirstOnClient = new Promise<void>((resolve) => { releaseSecond = resolve; });

    fixture.setResponder((hostReq, res) => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('data: one\n\n');
      firstChunkAt = Date.now();
      // The client disconnect tears down the member→host leg; the host observes
      // it as its response socket closing (or the request aborting) before it
      // ever called res.end().
      res.on('close', () => { if (!res.writableEnded) hostSawClose = true; });
      hostReq.on('aborted', () => { hostSawClose = true; });
      hostReq.on('close', () => { hostSawClose = true; });
      // Only send the second chunk AFTER the client confirms it received the
      // first — if the relay buffered, the client never gets the first and this
      // deadlocks (the test then times out => fails).
      void gotFirstOnClient.then(() => {
        secondChunkAt = Date.now();
        res.write('data: two\n\n');
      });
    });

    await new Promise<void>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: memberPort, path: '/mcp', method: 'GET' },
        (res) => {
          expect(res.headers['content-type']).toBe('text/event-stream');
          let seen = 0;
          res.on('data', (chunk: Buffer) => {
            seen += 1;
            if (seen === 1) {
              expect(chunk.toString()).toContain('one');
              releaseSecond();
            }
            if (seen === 2) {
              expect(chunk.toString()).toContain('two');
              // Incremental: the second chunk was written strictly after the
              // client received the first (not one buffered blob).
              expect(secondChunkAt).toBeGreaterThanOrEqual(firstChunkAt);
              req.destroy(); // client disconnects mid-stream
              resolve();
            }
          });
        },
      );
      req.on('error', () => { /* destroy triggers ECONNRESET locally — expected */ });
      req.end();
      setTimeout(() => reject(new Error('stream test timed out (relay likely buffered)')), 4000);
    });

    // The client disconnect tore down the upstream leg → the host saw its
    // response socket close.
    await new Promise((r) => setTimeout(r, 400));
    expect(hostSawClose).toBe(true);
  });

  // --- collect routes (collector contract) ---

  test('collect route: buffers locally, acks {persisted:false,buffered:true}, forwards to host', async () => {
    config.classification = { capability: 'Collection', stamp: 'collect' };
    const forwarded = new Promise<Recorded>((resolve) => {
      fixture.setResponder((_req, res, recorded) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, queued: true })); // host stop-style reply, NOT relayed
        resolve(recorded);
      });
    });

    const event = { type: 'tool', session_id: 'sess-1', transcript_path: '/member/x.jsonl', agent: 'claude' };
    const res = await fetch(memberUrl('/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef' },
      body: JSON.stringify(event),
    });

    // The member synthesizes its OWN ack — never the host's {queued:true}.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, persisted: false, buffered: true });

    // The event landed durably in the local collector buffer (DB-free path).
    const bufferFile = path.join(resolveProjectBufferDir(config.target.groveId, config.target.projectId, tmpHome), 'sess-1.jsonl');
    expect(fs.existsSync(bufferFile)).toBe(true);
    const buffered = JSON.parse(fs.readFileSync(bufferFile, 'utf-8').trim());
    expect(buffered.type).toBe('tool');
    expect(buffered.session_id).toBe('sess-1');

    // And it also reached the host, with the host bearer + version header.
    const got = await forwarded;
    expect(JSON.parse(got.body)).toMatchObject(event);
    expect(got.headers.authorization).toBe(`Bearer ${memberToken}`);
    expect(got.headers[HOST_PROTOCOL_HEADER]).toBe(String(HOST_PROTOCOL_VERSION));

    // No local Grove materialized — no grove.toml, no DB, not in listGroves.
    const groveDir = path.join(tmpHome, 'groves', config.target.groveId);
    expect(fs.existsSync(path.join(groveDir, 'grove.toml'))).toBe(false);
    expect(fs.existsSync(path.join(groveDir, 'myco.db'))).toBe(false);
    expect(listGroves(tmpHome)).toHaveLength(0);
  });

  test('stamps a /events body with an identity-bearing id — live-forward and buffered copy carry the IDENTICAL id (§4a)', async () => {
    config.classification = { capability: 'Collection', stamp: 'collect' };
    const forwarded = new Promise<Recorded>((resolve) => {
      fixture.setResponder((_req, res, recorded) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        resolve(recorded);
      });
    });

    const machineId = 'alice_a1b2c3d4';
    await fetch(memberUrl('/events'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
        [REQUEST_CONTEXT_HEADERS.machineId]: machineId,
      },
      body: JSON.stringify({ type: 'user_prompt', session_id: 'sess-id', prompt: 'hi' }),
    });

    const bufferFile = path.join(resolveProjectBufferDir(config.target.groveId, config.target.projectId, tmpHome), 'sess-id.jsonl');
    const bufferedId = readEventId(JSON.parse(fs.readFileSync(bufferFile, 'utf-8').trim()));
    const forwardedId = readEventId(JSON.parse((await forwarded).body));

    expect(bufferedId).not.toBeNull();
    expect(bufferedId!.startsWith(`${machineId}:`)).toBe(true); // identity-bearing
    // The load-bearing property: the durable copy (which the drain re-forwards) and
    // the live forward carry the SAME id, so the host dedups the replay against the
    // live delivery.
    expect(forwardedId).toBe(bufferedId);
  });

  test('collect ack lands on the hook fallback matrix "never buffer" row for every event type', () => {
    // Import the REAL matrix and assert the synthesized ack would not trip the
    // hook-side buffer fallback (which is the auto-register leak vector).
    const ack = { ok: true, data: { ok: true, persisted: false, buffered: true } };
    expect(shouldBufferFallback(ack, 'tool')).toBe(false);
    expect(shouldBufferFallback(ack, 'stop')).toBe(false);
    expect(shouldBufferFallback(ack, undefined)).toBe(false);
  });

  test('collect route with host DOWN: still buffers, still acks buffered:true, no hang', async () => {
    config.classification = { capability: 'Collection', stamp: 'collect' };
    await takeHostDown();

    const started = Date.now();
    const res = await fetch(memberUrl('/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'tool', session_id: 'sess-down' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, persisted: false, buffered: true });
    // Ack is prompt (buffer-first, no synchronous host round-trip needed).
    expect(Date.now() - started).toBeLessThan(2000);

    const bufferFile = path.join(resolveProjectBufferDir(config.target.groveId, config.target.projectId, tmpHome), 'sess-down.jsonl');
    expect(fs.existsSync(bufferFile)).toBe(true);
    // Re-open a fixture so afterEach's close() is a no-op-safe double close.
    fixture = createFixture();
  });

  test('collect route with simultaneous buffer append and live-forward failures requires hook fallback without an unhandled rejection', async () => {
    const cap = capturingLogger();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => { rejections.push(reason); };
    config.classification = { capability: 'Collection', stamp: 'collect' };
    config.deps = {
      logger: cap.logger,
      bufferAppend: () => { throw new Error('disk unavailable'); },
    };
    const failingHostId = 'host_fedcba9876543210fedcba9876543210';
    const target = makeTarget(hostUrl);
    config.target = { ...target, host: { ...target.host, host_id: failingHostId } };
    __resetLogThrottleForTests();

    process.on('unhandledRejection', onRejection);
    try {
      await takeHostDown();

      const started = Date.now();
      const res = await fetch(memberUrl('/events'), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'tool', session_id: 'sess-append-failed' }),
      });

      const ack = await res.json();
      expect(ack).toEqual({ ok: true, persisted: false, buffered: false });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(shouldBufferFallback({ ok: true, data: ack }, 'tool')).toBe(true);

      expect(cap.errors).toContainEqual([
        'collector buffer append failed',
        {
          host_id: config.target.host.host_id,
          session_id: 'sess-append-failed',
          error: 'disk unavailable',
        },
      ]);
      const fallbackWarning = await waitFor(
        () => cap.warns.find(([message, metadata]) => {
          const meta = metadata as Record<string, unknown>;
          return message === 'collect forward failed — hook fallback required'
            && meta.host_id === failingHostId
            && meta.path === '/events';
        }),
        `collect forward failure for ${failingHostId}`,
      );
      expect(fallbackWarning[1]).toMatchObject({ host_id: failingHostId, path: '/events' });
      expect(rejections).toEqual([]);
    } finally {
      process.removeListener('unhandledRejection', onRejection);
      fixture = createFixture();
    }
  });

  test('collect route without a resolvable session ID requires hook fallback', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Collection', stamp: 'collect' };
    config.deps = { logger: cap.logger };

    const res = await fetch(memberUrl('/events'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'tool' }),
    });

    const ack = await res.json();
    expect(ack).toEqual({ ok: true, persisted: false, buffered: false });
    expect(shouldBufferFallback({ ok: true, data: ack }, 'tool')).toBe(true);
    expect(cap.errors).toContainEqual([
      'collect route missing resolvable session_id',
      { host_id: config.target.host.host_id, path: '/events' },
    ]);
  });

  // --- flush-before-forward ordering ---

  test('flush hook runs before forwarding the three mining-trigger routes, not others', async () => {
    let seq = 0;
    const flushedAt: number[] = [];
    const forwardedAt: number[] = [];
    config.classification = { capability: 'Collection', stamp: 'collect' };
    config.deps = {
      flushBeforeForward: async () => { flushedAt.push(seq++); },
      bufferAppend: () => { /* no-op: keep this test off disk */ },
    };
    const forwardSeen = () => new Promise<void>((resolve) => {
      fixture.setResponder((_req, res) => { forwardedAt.push(seq++); res.end('{}'); resolve(); });
    });

    for (const route of ['/events/stop', '/sessions/register', '/sessions/unregister']) {
      flushedAt.length = 0; forwardedAt.length = 0; seq = 0;
      const seen = forwardSeen();
      await fetch(memberUrl(route), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 's' }) });
      await seen;
      expect(flushedAt).toHaveLength(1);
      expect(forwardedAt).toHaveLength(1);
      // flush strictly precedes the forward the host received.
      expect(flushedAt[0]).toBeLessThan(forwardedAt[0]);
    }

    // A mid-turn /events is NOT a flush trigger.
    flushedAt.length = 0; forwardedAt.length = 0; seq = 0;
    const seenEvents = forwardSeen();
    await fetch(memberUrl('/events'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session_id: 's', type: 'tool' }) });
    await seenEvents;
    expect(flushedAt).toHaveLength(0);
  });

  // --- host unreachable (non-collect) ---

  test('unreachable non-collect route → prompt 503 host_unreachable, no hang', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    await takeHostDown();

    const started = Date.now();
    const res = await fetch(memberUrl('/api/spores'));
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toBe('host_unreachable');
    expect(body.host_id).toBe(config.target.host.host_id);
    expect(body.retryable).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
    fixture = createFixture(); // restore for afterEach
  });

  // --- version gate ---

  test('stored-version mismatch → 409 host_protocol_mismatch WITHOUT dialing, logged once per host', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.target = makeTarget(hostUrl, { protocolVersion: 99 });
    config.deps = { logger: cap.logger };

    const res1 = await fetch(memberUrl('/api/spores'));
    expect(res1.status).toBe(409);
    const body = await res1.json();
    expect(body.error).toBe('host_protocol_mismatch');
    expect(body.host_protocol).toBe(99);
    expect(body.member_protocol).toBe(HOST_PROTOCOL_VERSION);
    // Never dialed the host.
    expect(fixture.requests).toHaveLength(0);
    // Logged loudly once.
    expect(cap.errors).toHaveLength(1);

    // Second request to the same host: no duplicate log.
    const res2 = await fetch(memberUrl('/api/spores'));
    expect(res2.status).toBe(409);
    await res2.text();
    expect(cap.errors).toHaveLength(1);
  });

  test('runtime host 409 protocol_version_unsupported passes through + logs once', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.deps = { logger: cap.logger };
    fixture.setResponder((_req, res) => {
      res.writeHead(409, { 'Content-Type': 'application/json', [HOST_PROTOCOL_HEADER]: '2' });
      res.end(JSON.stringify({ error: 'protocol_version_unsupported', supported: [2, 2] }));
    });
    const res = await fetch(memberUrl('/api/spores'));
    // The host's 409 passes through to the caller.
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('protocol_version_unsupported');
    expect(cap.errors).toHaveLength(1);
  });

  test('host 401 (bearer rejected) → 502 host_auth_rejected, not a verbatim relay', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    fixture.setResponder((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const res = await fetch(memberUrl('/api/spores'));
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe('host_auth_rejected');
  });

  // --- Task 2 (E-4 W2): relayed upstream-failure observability ---

  test('host 401 (bearer rejected) also logs once (throttled) — never the response body', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.deps = { logger: cap.logger };
    fixture.setResponder((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized', secret: 'never-log-me' }));
    });

    const res1 = await fetch(memberUrl('/api/spores'));
    expect(res1.status).toBe(502);
    expect((await res1.json()).error).toBe('host_auth_rejected');
    expect(cap.warns).toHaveLength(1);
    const [message, meta] = cap.warns[0] as [string, Record<string, unknown>];
    expect(meta.host_id).toBe(config.target.host.host_id);
    expect(meta.path).toBe('/api/spores');
    expect(meta.status).toBe(401);
    expect(JSON.stringify([message, meta])).not.toContain('never-log-me');

    // An identical repeat within the throttle interval: response byte-identical
    // (Task 2 is log-lines-only, zero wire/behavior change), no second log.
    const res2 = await fetch(memberUrl('/api/spores'));
    expect(res2.status).toBe(502);
    expect((await res2.json()).error).toBe('host_auth_rejected');
    expect(cap.warns).toHaveLength(1);
  });

  test('host 404 relayed to the caller logs once (throttled); repeat within the interval is silent; body content never appears in the log', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.deps = { logger: cap.logger };
    fixture.setResponder((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found', message: 'secret-body-content' }));
    });

    const res1 = await fetch(memberUrl('/api/spores'));
    expect(res1.status).toBe(404);
    const body1 = await res1.json();
    expect(body1.error).toBe('not_found');
    expect(cap.warns).toHaveLength(1);
    const [message, meta] = cap.warns[0] as [string, Record<string, unknown>];
    expect(meta.host_id).toBe(config.target.host.host_id);
    expect(meta.path).toBe('/api/spores');
    expect(meta.status).toBe(404);
    expect(JSON.stringify([message, meta])).not.toContain('secret-body-content');

    // An identical repeat within the interval: response byte-identical, no
    // second log.
    const res2 = await fetch(memberUrl('/api/spores'));
    expect(res2.status).toBe(404);
    expect(await res2.json()).toEqual(body1);
    expect(cap.warns).toHaveLength(1);
  });

  test('host 500 relayed to the caller also logs — a different status class on the same route is a distinct throttle key, not suppressed by a fresh 404', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.deps = { logger: cap.logger };
    fixture.setResponder((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });
    const notFound = await fetch(memberUrl('/api/spores'));
    expect(notFound.status).toBe(404);
    expect(cap.warns).toHaveLength(1);

    fixture.setResponder((_req, res) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'internal' }));
    });
    const serverError = await fetch(memberUrl('/api/spores'));
    expect(serverError.status).toBe(500);
    expect(cap.warns).toHaveLength(2);
    expect((cap.warns[1][1] as Record<string, unknown>).status).toBe(500);
  });

  test('once the throttle interval elapses, the same relayed failure logs again', async () => {
    let fakeNow = 0;
    __setLogThrottleClockForTests(() => fakeNow);
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.deps = { logger: cap.logger };
    fixture.setResponder((_req, res) => {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'not_found' }));
    });

    await fetch(memberUrl('/api/spores'));
    expect(cap.warns).toHaveLength(1);
    await fetch(memberUrl('/api/spores'));
    expect(cap.warns).toHaveLength(1);

    fakeNow += REFUSAL_LOG_THROTTLE_INTERVAL_MS + 1;
    await fetch(memberUrl('/api/spores'));
    expect(cap.warns).toHaveLength(2);
  });

  test('a successful (200) relayed response never logs a relay-failure warn', async () => {
    const cap = capturingLogger();
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.deps = { logger: cap.logger };
    const res = await fetch(memberUrl('/api/spores'));
    expect(res.status).toBe(200);
    expect(cap.warns).toHaveLength(0);
  });

  // --- per-tool /mcp degrade ---

  test('/mcp canopy tool call → JSON-RPC refusal, never crosses the wire', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_cortex', arguments: { op: 'canopy_map' } } });
    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    const parsed = await res.json();
    expect(parsed.error.code).toBe(-32004);
    expect(parsed.error.data.code).toBe('capability_unavailable_hosted');
    // The refusal echoes the request's JSON-RPC id (schema validity for SDK
    // clients — see the refusal-envelope block below).
    expect(parsed.id).toBe(1);
    // The Canopy call never reached the host.
    expect(fixture.requests).toHaveLength(0);
  });

  // --- /mcp refusal envelopes: id echo + SDK schema validity ---
  //
  // The member-side soft-fail envelopes (host_unreachable / host_auth_rejected /
  // host_protocol_mismatch) must ECHO the request's JSON-RPC id. The MCP SDK's
  // JSONRPCMessageSchema accepts a string/number response id but REJECTS
  // `id: null`, so an id:null refusal for a parseable request threw a ZodError
  // inside every SDK consumer BEFORE McpError classification — the CLI dumped a
  // ~3.4KB validation error instead of the designed message, and the stdio
  // bridge treated the refusal as a transport failure (self-heal reconnect
  // burn). Parsing each envelope with the REAL JSONRPCMessageSchema here is the
  // bridge/client-level assertion: if it parses, the SDK classifies it as a
  // proper JSON-RPC error response and no reconnect fires.

  test('mcpRequestIdFromBody: number/string ids echo (0 included); notifications, garbage, and empty batches yield null', () => {
    const call = (id: unknown) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 't' } });
    expect(mcpRequestIdFromBody(call(42))).toBe(42);
    expect(mcpRequestIdFromBody(call(0))).toBe(0); // falsy but valid — type-checked, not truthiness-checked
    expect(mcpRequestIdFromBody(call('abc'))).toBe('abc');
    expect(mcpRequestIdFromBody(call(''))).toBe(null);
    expect(mcpRequestIdFromBody({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBe(null);
    expect(mcpRequestIdFromBody(undefined)).toBe(null);
    expect(mcpRequestIdFromBody('garbage')).toBe(null);
    expect(mcpRequestIdFromBody([call(undefined), call(7)])).toBe(7);
    expect(mcpRequestIdFromBody([])).toBe(null);
  });

  test('/mcp host unreachable → refusal echoes the request id and parses under JSONRPCMessageSchema', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    await takeHostDown();

    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'myco_search', arguments: { query: 'x' } } }),
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.id).toBe(42);
    expect(parsed.error.code).toBe(-32004);
    expect(parsed.error.data.code).toBe('host_unreachable');
    // The load-bearing property: the envelope is schema-valid for the SDK.
    expect(() => JSONRPCMessageSchema.parse(parsed)).not.toThrow();
    fixture = createFixture(); // restore for afterEach
  });

  test('/mcp unparseable request keeps id: null (JSON-RPC spec; no SDK client ever sends one)', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    await takeHostDown();

    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json{{{',
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.id).toBe(null);
    expect(parsed.error.data.code).toBe('host_unreachable');
    fixture = createFixture(); // restore for afterEach
  });

  test('/mcp stored-version mismatch → refusal echoes the request id, never dials', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.target = makeTarget(hostUrl, { protocolVersion: 99 });

    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'myco_search', arguments: { query: 'x' } } }),
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.id).toBe(7);
    expect(parsed.error.data.code).toBe('host_protocol_mismatch');
    expect(() => JSONRPCMessageSchema.parse(parsed)).not.toThrow();
    expect(fixture.requests).toHaveLength(0);
  });

  test('/mcp host 401 → host_auth_rejected refusal echoes the request id', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    fixture.setResponder((_req, res) => {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'unauthorized' }));
    });
    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'myco_search', arguments: { query: 'x' } } }),
    });
    expect(res.status).toBe(200);
    const parsed = await res.json();
    expect(parsed.id).toBe(9);
    expect(parsed.error.data.code).toBe('host_auth_rejected');
    expect(() => JSONRPCMessageSchema.parse(parsed)).not.toThrow();
  });

  test('/mcp non-canopy tool call → proxied to the host', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    let hostBody = '';
    fixture.setResponder((_req, res, recorded) => {
      hostBody = recorded.body;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_search', arguments: { type: 'session', query: 'x' } } });
    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    expect(fixture.requests).toHaveLength(1);
    expect(JSON.parse(hostBody).params.name).toBe('myco_search');
  });

  test('/mcp plain search with no type filter → proxied, not refused', async () => {
    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    fixture.setResponder((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"jsonrpc":"2.0","id":1,"result":{}}');
    });
    // No `type` argument at all: a valid vault search that must reach the host.
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_search', arguments: { query: 'design decision' } } });
    const res = await fetch(memberUrl('/mcp'), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    expect(res.status).toBe(200);
    // Reached the host (not a -32004 refusal).
    expect(fixture.requests).toHaveLength(1);
    const parsed = await res.json();
    expect(parsed.error).toBeUndefined();
  });

});
