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

import {
  handleAttachedRequest,
  isCanopyMcpCall,
  parseOverlayAddress,
  hostProtocolCompatible,
  __resetVersionMismatchLogForTests,
  type HostProxyDeps,
  type ProxyLogger,
} from '@myco/daemon/host-proxy';
import type { RemoteTarget, RouteClassification } from '@myco/host/routing';
import { shouldBufferFallback } from '@myco/hooks/send-event';
import { resolveProjectBufferDir } from '@myco/grove/paths';
import { listGroves } from '@myco/grove/registry';
import { HOST_PROTOCOL_HEADER } from '@myco/constants';

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

function makeTarget(fixturePort: number, opts: { protocolVersion?: number; proxyPort?: number } = {}): RemoteTarget {
  return {
    projectId: 'proj_0123456789abcdef0123456789abcdef' as RemoteTarget['projectId'],
    groveId: 'grove_0123456789abcdef0123456789abcdef',
    host: {
      host_id: 'host_0123456789abcdef0123456789abcdef',
      label: 'Mac Studio',
      overlay_address: `127.0.0.1:${fixturePort}`,
      protocol_version: opts.protocolVersion ?? 1,
      proxy_port: opts.proxyPort,
    },
    bearer: HOST_BEARER,
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

describe('host-proxy forwarder', () => {
  let tmpHome: string;
  let tmpTeamHome: string;
  let savedHome: string | undefined;
  let savedTeamHome: string | undefined;
  let fixture: ReturnType<typeof createFixture>;
  let fixturePort: number;
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
    __resetVersionMismatchLogForTests();

    fixture = createFixture();
    fixturePort = await listen(fixture.server);
    config = {
      target: makeTarget(fixturePort),
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
    await close(member);
    await close(fixture.server);
    if (savedHome === undefined) delete process.env.MYCO_HOME; else process.env.MYCO_HOME = savedHome;
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME; else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmpHome, { recursive: true, force: true });
    fs.rmSync(tmpTeamHome, { recursive: true, force: true });
  });

  const memberUrl = (p: string) => `http://127.0.0.1:${memberPort}${p}`;

  // --- pure helpers ---

  test('parseOverlayAddress handles host:port and URL forms', () => {
    expect(parseOverlayAddress('100.64.0.1:7433')).toEqual({ host: '100.64.0.1', port: 7433 });
    expect(parseOverlayAddress('http://host.example:9000')).toEqual({ host: 'host.example', port: 9000 });
    expect(parseOverlayAddress('bare-host')).toEqual({ host: 'bare-host', port: 80 });
  });

  test('hostProtocolCompatible enforces the inclusive [min,max] window', () => {
    expect(hostProtocolCompatible(1)).toBe(true);
    expect(hostProtocolCompatible(0)).toBe(false);
    expect(hostProtocolCompatible(99)).toBe(false);
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

  test('serve route relays byte-faithfully with tenancy preserved, bearer swapped, version stamped', async () => {
    fixture.setResponder((_req, res) => {
      res.writeHead(201, { 'Content-Type': 'application/json', 'X-Host-Custom': 'yes' });
      res.end(JSON.stringify({ served: 'by-host' }));
    });
    const res = await fetch(memberUrl('/api/spores?q=1'), {
      headers: {
        'x-myco-project-id': 'proj_0123456789abcdef0123456789abcdef',
        'x-myco-grove-id': 'grove_0123456789abcdef0123456789abcdef',
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
    // Tenancy headers preserved verbatim; machine attribution rides through.
    expect(got.headers['x-myco-project-id']).toBe('proj_0123456789abcdef0123456789abcdef');
    expect(got.headers['x-myco-machine-id']).toBe('machine-A');
    // LOCAL bearer stripped; HOST bearer attached; version header stamped.
    expect(got.headers['x-myco-auth']).toBeUndefined();
    expect(got.headers.authorization).toBe(`Bearer ${HOST_BEARER}`);
    expect(got.headers[HOST_PROTOCOL_HEADER]).toBe('1');
    expect(got.headers.host).toBe(`127.0.0.1:${fixturePort}`);
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
    expect(got.headers.authorization).toBe(`Bearer ${HOST_BEARER}`);
    expect(got.headers[HOST_PROTOCOL_HEADER]).toBe('1');

    // No local Grove materialized — no grove.toml, no DB, not in listGroves.
    const groveDir = path.join(tmpHome, 'groves', config.target.groveId);
    expect(fs.existsSync(path.join(groveDir, 'grove.toml'))).toBe(false);
    expect(fs.existsSync(path.join(groveDir, 'myco.db'))).toBe(false);
    expect(listGroves(tmpHome)).toHaveLength(0);
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
    // Point at a closed port (host unreachable).
    await close(fixture.server);
    config.target = makeTarget(fixturePort); // same port, now dead

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
    await close(fixture.server);
    config.target = makeTarget(fixturePort); // dead port

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
    config.target = makeTarget(fixturePort, { protocolVersion: 99 });
    config.deps = { logger: cap.logger };

    const res1 = await fetch(memberUrl('/api/spores'));
    expect(res1.status).toBe(409);
    const body = await res1.json();
    expect(body.error).toBe('host_protocol_mismatch');
    expect(body.host_protocol).toBe(99);
    expect(body.member_protocol).toBe(1);
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
    // The Canopy call never reached the host.
    expect(fixture.requests).toHaveLength(0);
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

  // --- dial seam: CONNECT proxy ---

  test('proxy_port routes the dial through the local HTTP CONNECT proxy', async () => {
    // A minimal HTTP CONNECT proxy that tunnels to the requested authority.
    const proxy = http.createServer();
    proxy.on('connect', (req, clientSocket, head) => {
      const [h, p] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(p), h, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
    });
    const proxyPort = await new Promise<number>((resolve) => proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as AddressInfo).port)));

    config.classification = { capability: 'Knowledge serving', stamp: 'serve' };
    config.target = makeTarget(fixturePort, { proxyPort });
    fixture.setResponder((_req, res) => { res.writeHead(200); res.end('via-proxy'); });

    const res = await fetch(memberUrl('/api/spores'));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('via-proxy');
    // The request reached the fixture through the CONNECT tunnel.
    expect(fixture.requests).toHaveLength(1);
    await new Promise<void>((r) => proxy.close(() => r()));
  });
});
