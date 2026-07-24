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
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { HOST_BEARER_SECRET, HOST_PROTOCOL_VERSION } from '@myco/constants.js';
import { createGroveId, createHostId, createProjectId } from '@myco/grove/ids.js';
import {
  attachProject,
  getHost,
  persistEnrollmentMembership,
  readHostSecrets,
  upsertHost,
  writeHostSecret,
  type EnrollmentHostRecord,
  type HostRecord,
} from '@myco/host/registry.js';
import * as registryModule from '@myco/host/registry.js';

const OPERATION_HELPER = path.resolve('tests/helpers/host-registry-operation-helper.ts');
const SECRETS_LOCK_HELPER = path.resolve('tests/helpers/secrets-lock-holder-helper.ts');
const WAIT_TIMEOUT_MS = 10_000;

interface ChildResult {
  code: number | null;
  stderr: string;
}

interface SpawnedOperation {
  child: ChildProcess;
  startedPath: string;
  completedPath: string;
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
    proxy_port: host.proxy_port,
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

function spawnOperation(
  tmp: string,
  teamHome: string,
  name: string,
  operation: Record<string, unknown>,
): SpawnedOperation {
  const payloadPath = path.join(tmp, `${name}.json`);
  const startedPath = path.join(tmp, `${name}.started`);
  const completedPath = path.join(tmp, `${name}.completed`);
  fs.writeFileSync(payloadPath, JSON.stringify(operation));
  const child = spawn(
    process.execPath,
    ['run', OPERATION_HELPER, teamHome, payloadPath, startedPath, completedPath],
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
  return { child, startedPath, completedPath, result };
}

function spawnSecretLockHolder(
  tmp: string,
  hostDir: string,
  name: string,
  holdMs: number,
): { child: ChildProcess; readyPath: string; result: Promise<ChildResult> } {
  const readyPath = path.join(tmp, `${name}.ready`);
  const child = spawn(
    process.execPath,
    ['run', SECRETS_LOCK_HELPER, hostDir, String(holdMs), 'hold-only', readyPath],
    { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'] },
  );
  let stderr = '';
  child.stderr!.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf-8'); });
  const result = new Promise<ChildResult>((resolve, reject) => {
    child.on('exit', (code) => resolve({ code, stderr }));
    child.on('error', reject);
  });
  return { child, readyPath, result };
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

  test('a failed enrollment rolls back before a concurrent attach enters the registry', async () => {
    const host = makeHost();
    const ref = { grove_id: createGroveId(), project_id: createProjectId() };
    upsertHost(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'original-bearer');
    const hostDir = path.join(teamHome, 'hosts', host.host_id);
    const secretPath = path.join(hostDir, 'secrets.env');

    const holder = spawnSecretLockHolder(tmp, hostDir, 'attach-race-secret-lock', 600);
    children.add(holder.child);
    await waitFor(() => fs.existsSync(holder.readyPath), 'secret lock holder did not become ready');
    fs.rmSync(secretPath);
    fs.mkdirSync(secretPath);

    const failing = spawnOperation(tmp, teamHome, 'failing-enrollment-vs-attach', {
      mode: 'enroll',
      record: enrollmentRecord(host, {
        label: 'Failing enrollment',
        overlay_address: '100.64.0.9:7433',
      }),
      bearer: 'replacement-bearer',
    });
    children.add(failing.child);
    await waitFor(
      () => getHost(host.host_id)?.label === 'Failing enrollment',
      'failing enrollment never reached bearer persistence',
    );

    const attaching = spawnOperation(tmp, teamHome, 'concurrent-attach', {
      mode: 'attach',
      hostId: host.host_id,
      ref,
    });
    children.add(attaching.child);

    const [holderResult, failingResult, attachingResult] = await Promise.all([
      holder.result,
      failing.result,
      attaching.result,
    ]);
    expect(holderResult.code).toBe(0);
    expect(failingResult.code).not.toBe(0);
    expect(attachingResult).toEqual({ code: 0, stderr: '' });
    expect(getHost(host.host_id)).toEqual({ ...host, projects: [ref] });
    expect(fs.statSync(secretPath).isDirectory()).toBe(true);
  }, 30_000);

  test('a failed enrollment cannot restore stale bytes over a concurrent successful rejoin', async () => {
    const host = makeHost();
    upsertHost(host);
    writeHostSecret(host.host_id, HOST_BEARER_SECRET, 'original-bearer');
    const hostDir = path.join(teamHome, 'hosts', host.host_id);
    const secretPath = path.join(hostDir, 'secrets.env');

    const holder = spawnSecretLockHolder(tmp, hostDir, 'rejoin-race-secret-lock', 1_000);
    children.add(holder.child);
    await waitFor(() => fs.existsSync(holder.readyPath), 'secret lock holder did not become ready');
    fs.rmSync(secretPath);
    fs.mkdirSync(secretPath);

    const failing = spawnOperation(tmp, teamHome, 'failing-enrollment-vs-rejoin', {
      mode: 'enroll',
      record: enrollmentRecord(host, {
        label: 'Failing enrollment',
        overlay_address: '100.64.0.9:7433',
      }),
      bearer: 'failing-bearer',
    });
    children.add(failing.child);
    await waitFor(
      () => getHost(host.host_id)?.label === 'Failing enrollment',
      'failing enrollment never reached bearer persistence',
    );

    const succeeding = spawnOperation(tmp, teamHome, 'successful-concurrent-rejoin', {
      mode: 'enroll',
      record: enrollmentRecord(host, {
        label: 'Successful rejoin',
        overlay_address: '100.64.0.8:7433',
      }),
      bearer: 'successful-bearer',
    });
    children.add(succeeding.child);
    await waitFor(() => fs.existsSync(succeeding.startedPath), 'successful rejoin did not start');

    const competingWriteDeadline = Date.now() + 250;
    while (Date.now() < competingWriteDeadline
      && getHost(host.host_id)?.label !== 'Successful rejoin') {
      await Bun.sleep(5);
    }
    process.kill(succeeding.child.pid!, 'SIGSTOP');

    const [holderResult, failingResult] = await Promise.all([holder.result, failing.result]);
    expect(holderResult.code).toBe(0);
    expect(failingResult.code).not.toBe(0);
    fs.rmSync(secretPath, { recursive: true, force: true });
    process.kill(succeeding.child.pid!, 'SIGCONT');

    const succeedingResult = await succeeding.result;
    expect(succeedingResult).toEqual({ code: 0, stderr: '' });
    expect(getHost(host.host_id)).toEqual({
      ...host,
      label: 'Successful rejoin',
      overlay_address: '100.64.0.8:7433',
    });
    expect(readHostSecrets(host.host_id)[HOST_BEARER_SECRET]).toBe('successful-bearer');
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
    upsertHost(host);
    const stale = getHost(host.host_id)!;
    const ref = { grove_id: createGroveId(), project_id: createProjectId() };
    attachProject(host.host_id, ref);

    persistEnrollmentMembership(
      enrollmentRecord(stale, {
        label: 'Rejoined',
        overlay_address: '100.64.0.7:7433',
        created_at: '2026-07-24T00:00:00.000Z',
      }),
      'rejoined-bearer',
    );

    expect(getHost(host.host_id)).toEqual({
      ...host,
      label: 'Rejoined',
      overlay_address: '100.64.0.7:7433',
      projects: [ref],
    });
  });

  test('raw record snapshots and rollback writers are not public registry surfaces', () => {
    expect(registryModule).not.toHaveProperty('snapshotHostRecord');
    expect(registryModule).not.toHaveProperty('restoreHostRecord');
  });
});
