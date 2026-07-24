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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createHostId } from '@myco/grove/ids.js';
import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { readSecrets } from '@myco/config/secrets.js';
import { writeHostRecordFixture } from '../helpers/host-registry-fixture.js';
import {
  createHostRegistryOperations,
} from '@myco/host/registry.js';
import {
  testPerUserLockNamespace,
  testPerUserLocksRoot,
} from '../helpers/per-user-lock-namespace.js';
import { vi } from '../helpers/vi-shim.js';

const {
  advanceHostEnrollmentPhase,
  getHost,
  getHostMembershipSnapshot,
  persistEnrollmentMembership,
  readHostRegistry,
  readHostSecrets,
  reconcileHostRollbackBearers,
  reserveHostProxyPort,
  writeHostSecret,
} = createHostRegistryOperations(testPerUserLockNamespace);

const HELPER = path.resolve('tests/helpers/host-enrollment-crash-helper.ts');
const READER_HELPER = path.resolve('tests/helpers/host-membership-read-helper.ts');
const LEAVE_HELPER = path.resolve('tests/helpers/host-leave-crash-helper.ts');

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await Bun.sleep(10);
  }
}

function crashAt(
  teamHome: string,
  hostId: string,
  boundary: string,
  label: string,
  bearer: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['run', HELPER, testPerUserLocksRoot, teamHome, hostId, boundary, label, bearer],
    {
      cwd: process.cwd(),
      env: { ...process.env, MYCO_TEAM_HOME: teamHome },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
}

function crashLeaveAt(
  teamHome: string,
  hostId: string,
  boundary: string,
): Promise<{ code: number | null; stderr: string }> {
  const child = spawn(
    process.execPath,
    ['run', LEAVE_HELPER, testPerUserLocksRoot, teamHome, hostId, boundary],
    {
      cwd: process.cwd(),
      env: { ...process.env, MYCO_TEAM_HOME: teamHome, HOME: teamHome },
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => resolve({ code, stderr }));
  });
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

describe.skipIf(process.platform === 'win32')('host enrollment crash recovery', () => {
  let tmp: string;
  let savedTeamHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-enrollment-crash-'));
    savedTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_TEAM_HOME = tmp;
  });

  afterEach(() => {
    if (savedTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = savedTeamHome;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  for (const boundary of ['ledger', 'claim', 'intent', 'bearer', 'legacy_bearer'] as const) {
    test(`retry converges after process exit immediately after ${boundary} publication`, async () => {
      const hostId = createHostId();
      const crashed = await crashAt(tmp, hostId, boundary, 'Crashed', 'crashed-bearer');
      expect(crashed.code).toBe(86);
      expect(getHostMembershipSnapshot(hostId)).toBeNull();

      const retry = reserveHostProxyPort(hostId);
      advanceHostEnrollmentPhase(retry, 'enrolling');
      persistEnrollmentMembership(
        {
          host_id: hostId,
          label: 'Recovered',
          overlay_address: '100.64.0.1:7433',
          protocol_version: HOST_PROTOCOL_VERSION,
          created_at: '2026-07-24T00:00:00.000Z',
        },
        'recovered-bearer',
        retry,
      );

      expect(getHostMembershipSnapshot(hostId)).toMatchObject({
        record: {
          host_id: hostId,
          label: 'Recovered',
          proxy_port: retry.proxyPort,
          enrollment_generation: retry.generation,
        },
        bearer: 'recovered-bearer',
      });
      expect(readSecrets(path.join(tmp, 'hosts', hostId))).toMatchObject({
        [HOST_BEARER_SECRET]: 'recovered-bearer',
      });
    });
  }

  for (const boundary of ['pointer', 'intent_cleanup', 'claim_cleanup'] as const) {
    test(`a crash after ${boundary} leaves one readable committed generation`, async () => {
      const hostId = createHostId();
      const crashed = await crashAt(tmp, hostId, boundary, 'Committed', 'committed-bearer');
      expect(crashed.code).toBe(86);

      expect(getHostMembershipSnapshot(hostId)).toMatchObject({
        record: {
          host_id: hostId,
          label: 'Committed',
          enrollment_generation: 1,
          bearer_generation: 1,
        },
        bearer: 'committed-bearer',
      });
      expect(readSecrets(path.join(tmp, 'hosts', hostId))).toMatchObject({
        [HOST_BEARER_SECRET]: 'committed-bearer',
      });
      expect(fs.existsSync(path.join(tmp, 'hosts', hostId, 'enrollment-intent.json')))
        .toBe(boundary === 'pointer');
      expect(fs.existsSync(path.join(tmp, 'hosts', hostId, 'proxy-port-claim.json')))
        .toBe(boundary !== 'claim_cleanup');
    });
  }

  test('publishing a generated enrollment bearer preserves legacy non-bearer secrets', () => {
    const hostId = createHostId();
    writeHostSecret(hostId, 'EXISTING_HOST_SECRET', 'preserved');
    const reservation = reserveHostProxyPort(hostId);
    advanceHostEnrollmentPhase(reservation, 'enrolling');

    persistEnrollmentMembership(
      {
        host_id: hostId,
        label: 'Preserved',
        overlay_address: '100.64.0.1:7433',
        protocol_version: HOST_PROTOCOL_VERSION,
        created_at: '2026-07-24T00:00:00.000Z',
      },
      'generated-bearer',
      reservation,
    );

    expect(readSecrets(path.join(tmp, 'hosts', hostId))).toEqual({
      EXISTING_HOST_SECRET: 'preserved',
      [HOST_BEARER_SECRET]: 'generated-bearer',
    });
  });

  test('direct secret writes cannot split a committed generated bearer', () => {
    const hostId = createHostId();
    const reservation = reserveHostProxyPort(hostId);
    advanceHostEnrollmentPhase(reservation, 'enrolling');
    persistEnrollmentMembership(
      {
        host_id: hostId,
        label: 'Updated',
        overlay_address: '100.64.0.1:7433',
        protocol_version: HOST_PROTOCOL_VERSION,
        created_at: '2026-07-24T00:00:00.000Z',
      },
      'initial-bearer',
      reservation,
    );

    expect(() => writeHostSecret(hostId, HOST_BEARER_SECRET, 'updated-bearer'))
      .toThrow(/committed enrollment bearer/i);

    expect(readHostSecrets(hostId)[HOST_BEARER_SECRET]).toBe('initial-bearer');
    expect(readSecrets(path.join(tmp, 'hosts', hostId))).toMatchObject({
      [HOST_BEARER_SECRET]: 'initial-bearer',
    });
  });

  test('committed-intent recovery repairs the rollback bearer before clearing residue', async () => {
    const hostId = createHostId();
    const crashed = await crashAt(tmp, hostId, 'pointer', 'Committed', 'committed-bearer');
    expect(crashed.code).toBe(86);
    const hostDir = path.join(tmp, 'hosts', hostId);
    fs.unlinkSync(path.join(hostDir, 'secrets.env'));

    const retry = reserveHostProxyPort(hostId);

    expect(retry.recoveredCommit).toBe(true);
    expect(readSecrets(hostDir)).toMatchObject({
      [HOST_BEARER_SECRET]: 'committed-bearer',
    });
    expect(fs.existsSync(path.join(hostDir, 'enrollment-intent.json'))).toBe(false);
    expect(fs.existsSync(path.join(hostDir, 'proxy-port-claim.json'))).toBe(false);
  });

  for (const legacyState of ['missing', 'stale'] as const) {
    test(`startup reconciliation repairs a ${legacyState} rollback bearer without enrollment residue`, () => {
      const hostId = createHostId();
      const reservation = reserveHostProxyPort(hostId);
      advanceHostEnrollmentPhase(reservation, 'enrolling');
      persistEnrollmentMembership(
        {
          host_id: hostId,
          label: 'Upgrade',
          overlay_address: '100.64.0.1:7433',
          protocol_version: HOST_PROTOCOL_VERSION,
          created_at: '2026-07-24T00:00:00.000Z',
        },
        'generation-bearer',
        reservation,
      );
      const hostDir = path.join(tmp, 'hosts', hostId);
      expect(fs.existsSync(path.join(hostDir, 'enrollment-intent.json'))).toBe(false);
      expect(fs.existsSync(path.join(hostDir, 'proxy-port-claim.json'))).toBe(false);
      if (legacyState === 'missing') {
        fs.unlinkSync(path.join(hostDir, 'secrets.env'));
      } else {
        fs.writeFileSync(
          path.join(hostDir, 'secrets.env'),
          `EXISTING_HOST_SECRET=preserved\n${HOST_BEARER_SECRET}=stale-bearer\n`,
          { mode: 0o600 },
        );
      }

      expect(reconcileHostRollbackBearers()).toBe(1);
      expect(readSecrets(hostDir)).toEqual({
        ...(legacyState === 'stale' ? { EXISTING_HOST_SECRET: 'preserved' } : {}),
        [HOST_BEARER_SECRET]: 'generation-bearer',
      });
      expect(reconcileHostRollbackBearers()).toBe(0);
    });
  }

  test('startup reconciliation refuses a malformed rollback store without replacing it', () => {
    const hostId = createHostId();
    const reservation = reserveHostProxyPort(hostId);
    advanceHostEnrollmentPhase(reservation, 'enrolling');
    persistEnrollmentMembership(
      {
        host_id: hostId,
        label: 'Malformed',
        overlay_address: '100.64.0.1:7433',
        protocol_version: HOST_PROTOCOL_VERSION,
        created_at: '2026-07-24T00:00:00.000Z',
      },
      'generation-bearer',
      reservation,
    );
    const secretsPath = path.join(tmp, 'hosts', hostId, 'secrets.env');
    const malformed = Buffer.from(`KEEP=malformed\0value\n`);
    fs.writeFileSync(secretsPath, malformed);

    expect(() => reconcileHostRollbackBearers()).toThrow(/malformed/i);
    expect(fs.readFileSync(secretsPath)).toEqual(malformed);
  });

  test('startup reconciliation refuses a symlinked rollback store without replacing it', () => {
    const hostId = createHostId();
    const reservation = reserveHostProxyPort(hostId);
    advanceHostEnrollmentPhase(reservation, 'enrolling');
    persistEnrollmentMembership(
      {
        host_id: hostId,
        label: 'Symlink',
        overlay_address: '100.64.0.1:7433',
        protocol_version: HOST_PROTOCOL_VERSION,
        created_at: '2026-07-24T00:00:00.000Z',
      },
      'generation-bearer',
      reservation,
    );
    const secretsPath = path.join(tmp, 'hosts', hostId, 'secrets.env');
    const target = path.join(tmp, 'outside-secrets.env');
    fs.writeFileSync(target, `${HOST_BEARER_SECRET}=stale-bearer\n`, { mode: 0o600 });
    fs.unlinkSync(secretsPath);
    fs.symlinkSync(target, secretsPath);

    expect(() => reconcileHostRollbackBearers()).toThrow(/unsafe|malformed/i);
    expect(fs.lstatSync(secretsPath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(target, 'utf-8'))
      .toBe(`${HOST_BEARER_SECRET}=stale-bearer\n`);
  });

  for (const errorCode of ['EACCES', 'EIO'] as const) {
    test(`startup reconciliation fails closed when host enumeration returns ${errorCode}`, () => {
      const hostId = createHostId();
      const reservation = reserveHostProxyPort(hostId);
      advanceHostEnrollmentPhase(reservation, 'enrolling');
      persistEnrollmentMembership(
        {
          host_id: hostId,
          label: 'Unreadable registry',
          overlay_address: '100.64.0.1:7433',
          protocol_version: HOST_PROTOCOL_VERSION,
          created_at: '2026-07-24T00:00:00.000Z',
        },
        'generation-bearer',
        reservation,
      );
      const hostsDir = path.join(tmp, 'hosts');
      const secretsPath = path.join(hostsDir, hostId, 'secrets.env');
      const staleSecrets = `${HOST_BEARER_SECRET}=stale-bearer\n`;
      fs.writeFileSync(secretsPath, staleSecrets, { mode: 0o600 });

      const readdirSync = fs.readdirSync.bind(fs);
      let hostsDirectoryReads = 0;
      const readdir = vi.spyOn(fs, 'readdirSync').mockImplementation(
        ((target, options) => {
          if (path.resolve(String(target)) === path.resolve(hostsDir)
            && ++hostsDirectoryReads === 2) {
            throw Object.assign(
              new Error(`injected ${errorCode} host enumeration failure`),
              { code: errorCode },
            );
          }
          return readdirSync(target, options);
        }) as typeof fs.readdirSync,
      );

      try {
        expect(() => reconcileHostRollbackBearers()).toThrow(errorCode);
      } finally {
        readdir.mockRestore();
      }

      expect(fs.readFileSync(secretsPath, 'utf-8')).toBe(staleSecrets);
    });
  }

  test('a retry after pointer publication adopts the committed generation and cleans residue', async () => {
    const hostId = createHostId();
    const crashed = await crashAt(tmp, hostId, 'pointer', 'Committed', 'committed-bearer');
    expect(crashed.code).toBe(86);

    expect(getHostMembershipSnapshot(hostId)?.record.host_id).toBe(hostId);
    expect(getHost(hostId)?.host_id).toBe(hostId);
    expect(readHostRegistry().map((record) => record.host_id)).toContain(hostId);
    expect(readHostSecrets(hostId)).toMatchObject({
      [HOST_BEARER_SECRET]: 'committed-bearer',
    });
    expect(fs.existsSync(path.join(tmp, 'hosts', hostId, 'enrollment-intent.json')))
      .toBe(true);
    expect(fs.existsSync(path.join(tmp, 'hosts', hostId, 'proxy-port-claim.json')))
      .toBe(true);

    const retry = reserveHostProxyPort(hostId);

    expect(retry).toMatchObject({
      generation: 1,
      baseGeneration: null,
      recoveredCommit: true,
    });
    expect(fs.existsSync(path.join(tmp, 'hosts', hostId, 'enrollment-intent.json')))
      .toBe(false);
    expect(fs.existsSync(path.join(tmp, 'hosts', hostId, 'proxy-port-claim.json')))
      .toBe(false);
    expect(JSON.parse(fs.readFileSync(
      path.join(tmp, 'host-generations', `${hostId}.json`),
      'utf-8',
    ))).toMatchObject({
      last_allocated_generation: 1,
      retired_through_generation: 0,
    });
  });

  test('claim-only recovery preserves an exact legacy rejoin base and nonce', async () => {
    const hostId = createHostId();
    writeHostRecordFixture({
      host_id: hostId,
      label: 'Legacy',
      overlay_address: '100.64.0.1:7433',
      proxy_port: 41_080,
      protocol_version: HOST_PROTOCOL_VERSION,
      created_at: '2026-07-24T00:00:00.000Z',
      projects: [],
    });
    const hostDir = path.join(tmp, 'hosts', hostId);
    fs.writeFileSync(
      path.join(hostDir, 'secrets.env'),
      `${HOST_BEARER_SECRET}=legacy-bearer\n`,
      { mode: 0o600 },
    );
    const crashed = await crashAt(
      tmp,
      hostId,
      'intent_cleanup',
      'Migrated',
      'generation-bearer',
    );
    expect(crashed.code).toBe(86);
    const claim = JSON.parse(fs.readFileSync(
      path.join(hostDir, 'proxy-port-claim.json'),
      'utf-8',
    )) as Record<string, unknown>;

    const retry = reserveHostProxyPort(hostId);

    expect(retry).toMatchObject({
      generation: 1,
      baseGeneration: 0,
      enrollmentNonce: claim.enrollment_nonce,
      recoveredCommit: true,
    });
    expect(claim.base_generation).toBe(0);
    expect(claim.enrollment_nonce).toMatch(/^[a-f0-9]{32,}$/);
    expect(JSON.parse(fs.readFileSync(
      path.join(tmp, 'host-generations', `${hostId}.json`),
      'utf-8',
    )).last_allocated_generation).toBe(1);
  });

  test('a reader blocks behind bearer staging and observes old record plus old bearer after writer death', async () => {
    const hostId = createHostId();
    const initial = reserveHostProxyPort(hostId);
    advanceHostEnrollmentPhase(initial, 'enrolling');
    persistEnrollmentMembership(
      {
        host_id: hostId,
        label: 'Old',
        overlay_address: '100.64.0.1:7433',
        protocol_version: HOST_PROTOCOL_VERSION,
        created_at: '2026-07-24T00:00:00.000Z',
      },
      'old-bearer',
      initial,
    );

    const writer = spawn(
      process.execPath,
      ['run', HELPER, testPerUserLocksRoot, tmp, hostId, 'pause_bearer', 'New', 'new-bearer'],
      {
        cwd: process.cwd(),
        env: { ...process.env, MYCO_TEAM_HOME: tmp },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    await waitFor(
      () => fs.existsSync(path.join(tmp, 'hosts', hostId, 'bearers', '2.env')),
      'writer did not pause after bearer publication',
    );

    const readerStarted = path.join(tmp, 'reader.started');
    const readerResult = path.join(tmp, 'reader.result');
    const reader = spawn(
      process.execPath,
      ['run', READER_HELPER, testPerUserLocksRoot, tmp, hostId, readerStarted, readerResult],
      {
        cwd: process.cwd(),
        env: { ...process.env, MYCO_TEAM_HOME: tmp },
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    );
    await waitFor(() => fs.existsSync(readerStarted), 'reader did not start');
    expect(fs.existsSync(readerResult)).toBe(false);

    writer.kill('SIGKILL');
    await new Promise<void>((resolve) => writer.once('exit', () => resolve()));
    await new Promise<void>((resolve, reject) => {
      reader.once('error', reject);
      reader.once('exit', () => resolve());
    });

    expect(JSON.parse(fs.readFileSync(readerResult, 'utf-8'))).toMatchObject({
      record: { label: 'Old', enrollment_generation: 1, bearer_generation: 1 },
      bearer: 'old-bearer',
    });
  });

  for (const boundary of ['retirement', 'host_dir'] as const) {
    test(`leave stays retired after a crash at the ${boundary} durability boundary`, async () => {
      const hostId = createHostId();
      const proxyPort = await findFreeLoopbackPort();
      const reservation = reserveHostProxyPort(hostId, proxyPort);
      advanceHostEnrollmentPhase(reservation, 'enrolling');
      persistEnrollmentMembership(
        {
          host_id: hostId,
          label: 'Retiring',
          overlay_address: '100.64.0.1:7433',
          protocol_version: HOST_PROTOCOL_VERSION,
          created_at: '2026-07-24T00:00:00.000Z',
        },
        'retiring-bearer',
        reservation,
      );

      const crashed = await crashLeaveAt(tmp, hostId, boundary);
      expect(crashed.code).toBe(86);
      expect(getHostMembershipSnapshot(hostId)).toBeNull();

      const retried = await crashLeaveAt(tmp, hostId, 'none');
      expect(retried.code).toBe(0);
      expect(getHostMembershipSnapshot(hostId)).toBeNull();
    });
  }
});
