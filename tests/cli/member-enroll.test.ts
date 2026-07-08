/**
 * The member-side REAL enrollment client (Task 2.4) — the default `join` path.
 *
 * Two levels:
 *   A. Unit (injected transport): the client POSTs to HOST_ENROLL_ROUTE carrying the
 *      version header, parses the HostEnrollment, falls back to what it already knows
 *      for host_id/label, and maps a 409 to a loud version-mismatch error.
 *   B. End-to-end THROUGH THE PROXY: the real `connectProxyEnrollTransport` tunnels an
 *      HTTP CONNECT through an in-test proxy to a real `DaemonServer` enrollment route
 *      and comes back with the host bearer — proving the whole overlay handshake.
 *
 * (The bearer-lands-in-secrets.env-only-and-not-in-host.json invariant is covered for
 * any enrollment client by the member-overlay join test.)
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { HOST_ENROLL_ROUTE, HOST_PROTOCOL_HEADER } from '@myco/constants';
import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import {
  connectProxyEnrollTransport,
  createEnrollmentClient,
  type EnrollmentContext,
  type EnrollmentTransport,
} from '@myco/host/member-overlay';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;

function ctx(overrides: Partial<EnrollmentContext> = {}): EnrollmentContext {
  return {
    hostId: 'host_local_ref', hostRef: 'host_local_ref', oneTimeKey: 'k',
    memberHostname: 'my-laptop', memberOverlayIp: '100.64.0.9',
    overlayAddress: '100.64.0.1:7433', proxyPort: 41080,
    ...overrides,
  };
}

describe('member enrollment client — unit (injected transport)', () => {
  test('POSTs to HOST_ENROLL_ROUTE with the version header and parses the HostEnrollment', async () => {
    let captured: Parameters<EnrollmentTransport>[0] | undefined;
    const transport: EnrollmentTransport = async (input) => {
      captured = input;
      return { status: 200, body: JSON.stringify({
        host_id: 'canonical-host', label: 'Canonical', overlay_address: '100.64.0.1:7433',
        protocol_version: 1, bearer: 'the-shared-bearer', projects: [],
      }) };
    };
    const enrollment = await createEnrollmentClient(transport).enroll(ctx());
    expect(captured?.path).toBe(HOST_ENROLL_ROUTE);
    expect(captured?.headers[HOST_PROTOCOL_HEADER]).toBe('1');
    expect(captured?.proxyPort).toBe(41080);
    // Body carries member identity for the host's action log.
    expect(JSON.parse(captured!.body)).toMatchObject({ member_hostname: 'my-laptop', member_overlay_ip: '100.64.0.9' });
    // Host's authoritative values win when present.
    expect(enrollment.bearer).toBe('the-shared-bearer');
    expect(enrollment.host_id).toBe('canonical-host');
    expect(enrollment.label).toBe('Canonical');
    expect(enrollment.overlay_address).toBe('100.64.0.1:7433');
  });

  test('falls back to the member-known host_id/label when the host does not self-report them', async () => {
    const transport: EnrollmentTransport = async () => ({
      status: 200,
      body: JSON.stringify({ host_id: '', label: '', overlay_address: '100.64.0.1:7433', protocol_version: 1, bearer: 'b' }),
    });
    const enrollment = await createEnrollmentClient(transport).enroll(ctx({ hostId: 'the-ref', hostRef: 'the-ref', label: undefined }));
    expect(enrollment.host_id).toBe('the-ref');
    expect(enrollment.label).toBe('the-ref'); // label ?? hostRef
  });

  test('a 409 from the host maps to a loud version-mismatch error', async () => {
    const transport: EnrollmentTransport = async () => ({ status: 409, body: JSON.stringify({ error: 'protocol_version_unsupported' }) });
    await expect(createEnrollmentClient(transport).enroll(ctx())).rejects.toThrow(/protocol-version mismatch/);
  });

  test('a non-200/409 status is a clear failure', async () => {
    const transport: EnrollmentTransport = async () => ({ status: 500, body: 'boom' });
    await expect(createEnrollmentClient(transport).enroll(ctx())).rejects.toThrow(/Host enrollment failed \(HTTP 500\)/);
  });

  test('a missing host overlay address is a clear, actionable error (not a fabricated record)', async () => {
    const transport: EnrollmentTransport = async () => ({ status: 200, body: '{}' });
    await expect(createEnrollmentClient(transport).enroll(ctx({ overlayAddress: undefined }))).rejects.toThrow(/overlay address/);
  });
});

describe('member enrollment client — end-to-end through the CONNECT proxy', () => {
  let tmp: string;
  let server: DaemonServer;
  let proxy: http.Server;
  let proxyPort: number;
  let savedTeamHome: string | undefined;
  const HOST_BEARER = 'e2e-host-bearer-abcdef0123456789';

  beforeEach(async () => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enroll-e2e-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;

    server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      hostServe: { overlayAddress: '127.0.0.1', overlayPort: 0, bearer: HOST_BEARER, hostId: 'host_e2e', label: 'e2e' },
    });
    await server.start(0);

    // A minimal HTTP-CONNECT proxy standing in for the member's userspace-tailscaled
    // `--outbound-http-proxy-listen`: it tunnels CONNECT <authority> to that TCP peer.
    proxy = http.createServer();
    proxy.on('connect', (req, clientSocket) => {
      const [h, p] = (req.url ?? '').split(':');
      const upstream = net.connect(Number(p), h, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      upstream.on('error', () => clientSocket.destroy());
      clientSocket.on('error', () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    proxyPort = (proxy.address() as net.AddressInfo).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await server.stop();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('the real client tunnels through the proxy to the host enrollment route and receives the bearer', async () => {
    const client = createEnrollmentClient(connectProxyEnrollTransport);
    const enrollment = await client.enroll(ctx({
      overlayAddress: `127.0.0.1:${server.overlayPort}`,
      proxyPort,
    }));
    expect(enrollment.bearer).toBe(HOST_BEARER);
    expect(enrollment.overlay_address).toBe(`127.0.0.1:${server.overlayPort}`);
    expect(enrollment.protocol_version).toBe(1);
    expect(enrollment.host_id).toBe('host_e2e');
  });
});
