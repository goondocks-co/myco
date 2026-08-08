/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
/**
 * `myco leave` RELEASES the host's record — over the real transport.
 *
 * Leaving used to be a member-side write only, which was harmless while the
 * host's credential was shared. With per-member tokens it is not: a host that
 * is never told keeps a LIVE record for a machine that has gone, and that
 * machine's next join is refused as already-enrolled — recoverable only by an
 * operator, possibly on a machine the departing member cannot reach.
 *
 * Driven through a real `DaemonServer` behind a real TLS edge, using the
 * PRODUCTION transport, because the defect class this PR kept hitting was
 * exactly a default that no test exercised: the seam (`deps.enrollmentTransport`)
 * exists, and every one of these tests deliberately declines to use it.
 *
 * The unreachable-host cases are the other half of the contract. A host that is
 * down must never be able to trap a member in a membership it is trying to
 * leave, so leaving still completes locally and reports what could not be done.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { DaemonServer } from '@myco/daemon/server';
import { DaemonLogger } from '@myco/daemon/logger';
import type { DaemonStateAuthority } from '@myco/daemon/daemon-state-authority';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants';
import { createHostRegistryOperations, readHostRegistry, type HostRecord } from '@myco/host/registry';
import { createHostId } from '@myco/grove/ids';
import { leaveHost } from '@myco/host/member-overlay';
import { authenticateMemberToken, issueMemberToken } from '@myco/team-host/member-tokens';
import { readHostActionLog } from '@myco/host/action-log';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { startFunnelEdge, type FunnelEdge } from '../helpers/funnel-edge.js';
import { teamTestPort } from '../helpers/team-socket.js';

const stubAuthority = { read: () => null, write: () => {} } as unknown as DaemonStateAuthority;
const { writeHostSecret } = createHostRegistryOperations(testPerUserLockNamespace);
const HOST_BEARER = 'test-leave-resign-host-bearer-0123456789';

const MEMBER_MACHINE = 'alice_a1b2c3d4';

const describeTeamTransport = process.platform === 'win32' ? describe.skip : describe;

describeTeamTransport('leave releases the host record', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;
  let HOST_ID: string;
  let teamPort: number;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-leave-resign-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
    HOST_ID = createHostId();
    teamPort = teamTestPort();
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  /** A member joined to `hostUrl`, holding `token` as this host's bearer. */
  const joinFixture = (hostUrl: string, token: string): HostRecord => {
    const record: HostRecord = {
      host_id: HOST_ID,
      label: 'Test host',
      host_url: hostUrl,
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: new Date().toISOString(),
      projects: [],
    };
    writeHostRecordFixture(record);
    writeHostSecret(HOST_ID, HOST_BEARER_SECRET, token);
    return record;
  };

  test('the host STOPS accepting the member token, and the local record is gone', async () => {
    const server = new DaemonServer({
      vaultDir: path.join(tmp, 'vault'),
      logger: new DaemonLogger(path.join(tmp, 'logs')),
      daemonStateAuthority: stubAuthority,
      teamPort: teamPort,
      hostServe: { bearer: HOST_BEARER, hostId: HOST_ID, label: 'Test host' },
      lockNamespace: testPerUserLockNamespace,
    });
    await server.start(0);
    const edge = await startFunnelEdge({ port: teamPort });

    try {
      const issued = issueMemberToken(MEMBER_MACHINE);
      joinFixture(edge.url, issued.token);
      expect(authenticateMemberToken(issued.token).ok).toBe(true);

      const result = await leaveHost(HOST_ID, {
        lockNamespace: testPerUserLockNamespace,
        teamsHome: tmp,
        logger: () => {},
      });

      expect(result.removed).toBe(true);
      // THE POINT: the host no longer accepts this member.
      expect(authenticateMemberToken(issued.token).ok).toBe(false);
      // And nothing was left behind on either side.
      expect(readHostRegistry(testPerUserLockNamespace)).toEqual([]);
      expect(result.notes.join(' ')).not.toMatch(/may still list it/);
      // The operator can see the member LEFT, not just that a row went quiet.
      expect(readHostActionLog().filter((e) => e.action === 'resign')).toHaveLength(1);
    } finally {
      await edge.close();
      await server.stop();
    }
  }, 30_000);

  test('a host that is DOWN cannot trap the member — leave still completes', async () => {
    // Port 1 refuses immediately. A member must never need the host's
    // cooperation to stop being a member of it.
    const issued = issueMemberToken(MEMBER_MACHINE);
    joinFixture('https://127.0.0.1:1', issued.token);

    const result = await leaveHost(HOST_ID, {
      lockNamespace: testPerUserLockNamespace,
      teamsHome: tmp,
      logger: () => {},
    });

    expect(result.removed).toBe(true);
    expect(readHostRegistry(testPerUserLockNamespace)).toEqual([]);
    // ...and the user is TOLD, so they can ask the operator rather than being
    // surprised by a refused re-join later.
    expect(result.notes.join(' ')).toMatch(/may still list it/);
  }, 30_000);

  test('a host that STALLS mid-response is bounded, and leave still completes', async () => {
    // The failure mode that used to hang forever. Leave must be bounded by the
    // transport deadline, not by the peer's willingness to answer.
    const stalled = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '9999' });
      res.write('{"partial"');
    });
    await new Promise<void>((r) => stalled.listen(0, '127.0.0.1', () => r()));
    const edge = await startFunnelEdge({ port: (stalled.address() as { port: number }).port });

    try {
      const issued = issueMemberToken(MEMBER_MACHINE);
      joinFixture(edge.url, issued.token);

      const result = await leaveHost(HOST_ID, {
        lockNamespace: testPerUserLockNamespace,
        teamsHome: tmp,
        logger: () => {},
      });

      expect(result.removed).toBe(true);
      expect(readHostRegistry(testPerUserLockNamespace)).toEqual([]);
      expect(result.notes.join(' ')).toMatch(/may still list it/);
    } finally {
      stalled.closeAllConnections?.();
      await edge.close();
      await new Promise<void>((r) => stalled.close(() => r()));
    }
  }, 40_000);
});
