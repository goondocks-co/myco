/*
 * Copyright 2026 Myco Contributors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 *     Unless required by applicable law or agreed to in writing, software
 *     distributed under the License is distributed on an "AS IS" BASIS,
 *     WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 *     See the License for the specific language governing permissions and
 *     limitations under the License.
 */
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  HOST_BEARER_SECRET,
  HOST_PROTOCOL_VERSION,
  MEMBER_OVERLAY_PROXY_PORT_BASE,
} from '@myco/constants.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import {
  createHostRegistryOperations,
  type EnrollmentHostRecord,
  type HostRecord,
} from '@myco/host/registry.js';
import * as registryModule from '@myco/host/registry.js';
import {
  testPerUserLockNamespace,
  testPerUserLocksRoot,
} from '../helpers/per-user-lock-namespace.js';

const {
  attachProject,
  advanceHostEnrollmentPhase,
  getHost,
  getHostMembershipSnapshot,
  persistEnrollmentMembership,
  readHostRegistry,
  readHostSecrets,
  releaseHostProxyPort,
  reserveHostProxyPort,
  writeHostSecret,
} = createHostRegistryOperations(testPerUserLockNamespace);

const JOIN_RESERVATION_HELPER = path.resolve('tests/helpers/host-join-proxy-reservation-helper.ts');
const WAIT_TIMEOUT_MS = 10_000;

interface ChildResult {
  code: number | null;
  stderr: string;
}

interface SpawnedJoin {
  child: ChildProcess;
  readyPath: string;
  releasePath: string;
  resultPath: string;
  result: Promise<ChildResult>;
}

function makeHost(overrides: Partial<HostRecord> = {}): HostRecord {
  return {
    host_id: createHostId(),
    label: 'Original',
    overlay_address: '100.64.0.1:7433',
    protocol_version: HOST_PROTOCOL_VERSION,
    created_at: '2026-07-01T00:00:00.000Z',
    projects: [],
    ...overrides,
  };
}

function enrollmentRecord(host: HostRecord, overrides: Partial<EnrollmentHostRecord> = {}): EnrollmentHostRecord {
  return {
    host_id: host.host_id,
    label: host.label,
    overlay_address: host.overlay_address,
    protocol_version: host.protocol_version,
    served_grove_id: host.served_grove_id,
    created_at: host.created_at,
    ...overrides,
  };
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = WAIT_TIMEOUT_MS): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

function spawnJoin(
  tmp: string,
  teamHome: string,
  hostId: string,
  mode: 'hold' | 'crash' | 'handled-failure' | 'leave',
  preferredPort?: number,
): SpawnedJoin {
  const readyPath = path.join(tmp, `${hostId}.${mode}.ready`);
  const releasePath = path.join(tmp, `${hostId}.${mode}.release`);
  const resultPath = path.join(tmp, `${hostId}.${mode}.result`);
  const child = spawn(
    process.execPath,
    [
      'run',
      JOIN_RESERVATION_HELPER,
      testPerUserLocksRoot,
      teamHome,
      hostId,
      mode,
      readyPath,
      releasePath,
      resultPath,
      ...(preferredPort === undefined ? [] : [String(preferredPort)]),
    ],
    {
      cwd: process.cwd(),
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, MYCO_TEAM_HOME: teamHome },
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.on('exit', (code) => resolve({ code, stderr }));
    child.on('error', reject);
  });
  return { child, readyPath, releasePath, resultPath, result };
}

async function findFreeLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('could not allocate a test port');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

describe.skipIf(process.platform === 'win32')('host registry cross-process transactions', () => {
  let tmp: string;
  let teamHome: string;
  let savedTeamHome: string | undefined;
  const children = new Set<ChildProcess>();

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-registry-race-'));
    teamHome = path.join(tmp, 'team-home');
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = teamHome;
  });

  afterEach(() => {
    for (const child of children) {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    children.clear();
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('concurrent new-host joins reserve distinct proxy ports before provisioning completes', async () => {
    const first = spawnJoin(tmp, teamHome, createHostId(), 'hold');
    const second = spawnJoin(tmp, teamHome, createHostId(), 'hold');
    children.add(first.child);
    children.add(second.child);
    await Promise.all([
      waitFor(() => fs.existsSync(first.readyPath), 'first join did not reach enrollment'),
      waitFor(() => fs.existsSync(second.readyPath), 'second join did not reach enrollment'),
    ]);

    fs.writeFileSync(first.releasePath, 'release\n');
    fs.writeFileSync(second.releasePath, 'release\n');
    const [firstExit, secondExit] = await Promise.all([first.result, second.result]);

    expect(firstExit).toEqual({ code: 0, stderr: '' });
    expect(secondExit).toEqual({ code: 0, stderr: '' });
    const ports = readHostRegistry().map((host) => host.proxy_port).sort();
    expect(ports).toEqual([
      MEMBER_OVERLAY_PROXY_PORT_BASE,
      MEMBER_OVERLAY_PROXY_PORT_BASE + 1,
    ]);
  }, 30_000);

  test('a crashed join leaves a durable claim that its retry reuses and other hosts avoid', async () => {
    const crashedHostId = createHostId();
    const crashed = spawnJoin(tmp, teamHome, crashedHostId, 'crash');
    children.add(crashed.child);
    await waitFor(() => fs.existsSync(crashed.readyPath), 'crashing join did not reach enrollment');
    expect((await crashed.result).code).toBe(86);

    const other = spawnJoin(tmp, teamHome, createHostId(), 'hold');
    children.add(other.child);
    await waitFor(() => fs.existsSync(other.readyPath), 'other host did not reach enrollment');
    fs.writeFileSync(other.releasePath, 'release\n');
    expect(await other.result).toEqual({ code: 0, stderr: '' });

    const retry = spawnJoin(tmp, teamHome, crashedHostId, 'hold');
    children.add(retry.child);
    await waitFor(() => fs.existsSync(retry.readyPath), 'crashed host retry did not reach enrollment');
    fs.writeFileSync(retry.releasePath, 'release\n');
    expect(await retry.result).toEqual({ code: 0, stderr: '' });

    expect(getHost(crashedHostId)?.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
    expect(readHostRegistry().find((host) => host.host_id !== crashedHostId)?.proxy_port)
      .toBe(MEMBER_OVERLAY_PROXY_PORT_BASE + 1);
  }, 30_000);

  test('a handled provisioning failure releases its claim for another host', async () => {
    const preferredPort = await findFreeLoopbackPort();
    const failed = spawnJoin(tmp, teamHome, createHostId(), 'handled-failure', preferredPort);
    children.add(failed.child);
    expect((await failed.result).code).not.toBe(0);
    const failedResult = JSON.parse(fs.readFileSync(failed.resultPath, 'utf-8')) as {
      uninstallCalls: string[];
    };
    expect(failedResult.uninstallCalls).toHaveLength(1);

    const next = spawnJoin(tmp, teamHome, createHostId(), 'hold', preferredPort);
    children.add(next.child);
    await waitFor(() => fs.existsSync(next.readyPath), 'next host did not reach enrollment');
    const ready = JSON.parse(fs.readFileSync(next.readyPath, 'utf-8')) as { proxyPort: number };
    expect(ready.proxyPort).toBe(preferredPort);
    fs.writeFileSync(next.releasePath, 'release\n');
    expect(await next.result).toEqual({ code: 0, stderr: '' });
  }, 30_000);

  test('leave cannot interleave with an in-progress join for the same host', async () => {
    const hostId = createHostId();
    const joining = spawnJoin(tmp, teamHome, hostId, 'hold');
    children.add(joining.child);
    await waitFor(() => fs.existsSync(joining.readyPath), 'join did not reach enrollment');

    const leaving = spawnJoin(tmp, teamHome, hostId, 'leave');
    children.add(leaving.child);
    expect((await leaving.result).code).not.toBe(0);
    const leaveResult = JSON.parse(fs.readFileSync(leaving.resultPath, 'utf-8')) as {
      message: string;
      uninstallCalls: string[];
    };
    expect(leaveResult.message).toMatch(/join or leave operation in progress/);
    expect(leaveResult.uninstallCalls).toEqual([]);
    expect(fs.existsSync(path.join(teamHome, 'hosts', hostId, 'proxy-port-claim.json')))
      .toBe(true);

    fs.writeFileSync(joining.releasePath, 'release\n');
    expect(await joining.result).toEqual({ code: 0, stderr: '' });
    expect(getHost(hostId)?.proxy_port).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE);
  }, 30_000);

});

describe('host registry enrollment capability', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-host-registry-enroll-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test('a successful rejoin merges fresh attachments and created_at after a stale caller read', () => {
    const host = makeHost();
    writeHostRecordFixture(host);
    const stale = getHost(host.host_id)!;
    const ref = { grove_id: createGroveId(), project_id: createProjectId() };
    attachProject(host.host_id, ref);

    const reservation = reserveHostProxyPort(host.host_id);
    advanceHostEnrollmentPhase(reservation, 'enrolling');
    persistEnrollmentMembership(
      enrollmentRecord(stale, {
        label: 'Rejoined',
        overlay_address: '100.64.0.7:7433',
        created_at: '2026-07-24T00:00:00.000Z',
      }),
      'rejoined-bearer',
      reservation,
    );

    expect(getHost(host.host_id)).toEqual({
      ...host,
      label: 'Rejoined',
      overlay_address: '100.64.0.7:7433',
      proxy_port: MEMBER_OVERLAY_PROXY_PORT_BASE,
      projects: [ref],
      enrollment_generation: 1,
      bearer_generation: 1,
    });
  });

  test('reservation durably allocates one generation, claim, and reusable intent before side effects', () => {
    const hostId = createHostId();
    const first = reserveHostProxyPort(hostId);
    const retry = reserveHostProxyPort(hostId);

    expect(first.generation).toBe(1);
    expect(first.baseGeneration).toBeNull();
    expect(first.enrollmentNonce).toMatch(/^[a-f0-9]{32,}$/);
    expect(retry).toEqual(first);

    const ledger = JSON.parse(fs.readFileSync(
      path.join(tmp, 'host-generations', `${hostId}.json`),
      'utf-8',
    )) as Record<string, unknown>;
    expect(ledger).toMatchObject({
      host_id: hostId,
      last_allocated_generation: 1,
      retired_through_generation: 0,
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(tmp, 'hosts', hostId, 'proxy-port-claim.json'),
      'utf-8',
    ))).toMatchObject({
      host_id: hostId,
      generation: 1,
      claim_id: first.claimId,
      proxy_port: first.proxyPort,
    });
    expect(JSON.parse(fs.readFileSync(
      path.join(tmp, 'hosts', hostId, 'enrollment-intent.json'),
      'utf-8',
    ))).toMatchObject({
      host_id: hostId,
      generation: 1,
      base_generation: null,
      enrollment_nonce: first.enrollmentNonce,
      phase: 'reserved',
    });
  });

  test('host.json switches record and staged bearer through one generation pointer', () => {
    const host = makeHost();
    const reservation = reserveHostProxyPort(host.host_id);
    advanceHostEnrollmentPhase(reservation, 'enrolling');
    persistEnrollmentMembership(enrollmentRecord(host), 'generation-bearer', reservation);

    const record = getHost(host.host_id);
    expect(record).toMatchObject({
      host_id: host.host_id,
      enrollment_generation: 1,
      bearer_generation: 1,
    });
    expect(getHostMembershipSnapshot(host.host_id)).toMatchObject({
      record: { host_id: host.host_id, enrollment_generation: 1 },
      bearer: 'generation-bearer',
    });
    expect(readHostSecrets(host.host_id)[HOST_BEARER_SECRET]).toBe('generation-bearer');
    expect(fs.readFileSync(
      path.join(tmp, 'hosts', host.host_id, 'bearers', '1.env'),
      'utf-8',
    )).toContain('generation-bearer');
    expect(fs.existsSync(path.join(tmp, 'hosts', host.host_id, 'proxy-port-claim.json')))
      .toBe(false);
    expect(fs.existsSync(path.join(tmp, 'hosts', host.host_id, 'enrollment-intent.json')))
      .toBe(false);
  });

  test('a generation pointer with no matching staged bearer fails closed', () => {
    const host = makeHost({
      proxy_port: MEMBER_OVERLAY_PROXY_PORT_BASE,
      enrollment_generation: 3,
      bearer_generation: 3,
    });
    writeHostRecordFixture(host);
    fs.mkdirSync(path.join(tmp, 'host-generations'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'host-generations', `${host.host_id}.json`),
      JSON.stringify({
        schema_version: 1,
        host_id: host.host_id,
        last_allocated_generation: 3,
        retired_through_generation: 0,
      }),
    );

    expect(() => getHost(host.host_id)).toThrow(/host_join_state_corrupt|bearer/i);
    expect(() => readHostRegistry()).toThrow(/host_join_state_corrupt|bearer/i);
  });

  test('a rejoin keeps the old record and bearer visible until the new pointer publishes', () => {
    const host = makeHost();
    const initial = reserveHostProxyPort(host.host_id);
    advanceHostEnrollmentPhase(initial, 'enrolling');
    persistEnrollmentMembership(enrollmentRecord(host), 'old-bearer', initial);

    const rejoin = reserveHostProxyPort(host.host_id);
    expect(rejoin.generation).toBe(2);
    expect(rejoin.baseGeneration).toBe(1);
    advanceHostEnrollmentPhase(rejoin, 'enrolling');

    expect(getHostMembershipSnapshot(host.host_id)).toMatchObject({
      record: { label: host.label, enrollment_generation: 1 },
      bearer: 'old-bearer',
    });

    persistEnrollmentMembership(
      enrollmentRecord(host, { label: 'Rejoined' }),
      'new-bearer',
      rejoin,
    );
    expect(getHostMembershipSnapshot(host.host_id)).toMatchObject({
      record: { label: 'Rejoined', enrollment_generation: 2 },
      bearer: 'new-bearer',
    });
  });

  test('raw record snapshots and rollback writers are not public registry surfaces', () => {
    expect(registryModule).not.toHaveProperty('upsertHost');
    expect(registryModule.hostRegistry).not.toHaveProperty('upsertHost');
    expect(registryModule).not.toHaveProperty('snapshotHostRecord');
    expect(registryModule).not.toHaveProperty('restoreHostRecord');
  });

  test('a retry reuses its durable token and an older generation cannot release the next one', () => {
    const hostId = createHostId();
    const firstAttempt = reserveHostProxyPort(hostId);
    const retry = reserveHostProxyPort(hostId);

    expect(retry).toEqual(firstAttempt);
    releaseHostProxyPort(firstAttempt);

    const nextGeneration = reserveHostProxyPort(hostId);
    expect(nextGeneration.generation).toBe(firstAttempt.generation + 1);
    releaseHostProxyPort(firstAttempt);
    const otherHost = reserveHostProxyPort(createHostId());
    expect(otherHost.proxyPort).toBe(MEMBER_OVERLAY_PROXY_PORT_BASE + 1);
    releaseHostProxyPort(nextGeneration);
    releaseHostProxyPort(otherHost);
  });

  test('allocation fails closed when another host has a malformed durable claim', () => {
    const malformedHostId = createHostId();
    const hostDir = path.join(tmp, 'hosts', malformedHostId);
    fs.mkdirSync(hostDir, { recursive: true });
    fs.writeFileSync(
      path.join(hostDir, 'proxy-port-claim.json'),
      JSON.stringify({
        host_id: malformedHostId,
        proxy_port: 'not-a-port',
        claim_id: 'claim',
      }),
      { mode: 0o600 },
    );

    expect(() => reserveHostProxyPort(createHostId())).toThrow(/invalid proxy-port claim/i);
  });

  test('an existing duplicate persisted port fails closed on rejoin', () => {
    const first = makeHost({ proxy_port: MEMBER_OVERLAY_PROXY_PORT_BASE });
    const second = makeHost({ proxy_port: MEMBER_OVERLAY_PROXY_PORT_BASE });
    writeHostRecordFixture(first);
    writeHostRecordFixture(second);

    expect(() => reserveHostProxyPort(first.host_id)).toThrow(/assigned to host .* and another host/);
  });
});
