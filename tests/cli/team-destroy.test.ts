import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { vi } from '../helpers/vi-shim.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { teamRegistry } from '@myco/team/registry';

const execHandlers: Array<() => string | Error> = [];
const execCalls: Array<{ command: string; args: string[] }> = [];
const TEAM_ID = `team_${'b'.repeat(32)}`;

import * as childProcessActual__ns from 'node:child_process';
const childProcessActual = { ...childProcessActual__ns };
mock.module('node:child_process', () => ({
    ...childProcessActual,
    execFileSync: vi.fn((command: string, args: string[] = []) => {
      execCalls.push({ command, args });
      const handler = execHandlers.shift();
      if (!handler) return '';
      const result = handler();
      if (result instanceof Error) throw result;
      return result;
    }),
  }));

describe('teamDestroy', () => {
  let tempDir: string;
  let originalMycoHome: string | undefined;
  let originalTeamHome: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-team-destroy-'));
    execHandlers.length = 0;
    execCalls.length = 0;
    originalMycoHome = process.env.MYCO_HOME;
    originalTeamHome = process.env.MYCO_TEAM_HOME;
    process.env.MYCO_HOME = path.join(tempDir, 'home');
    process.env.MYCO_TEAM_HOME = path.join(tempDir, 'home');

    teamRegistry.saveDeployment({
      team_id: TEAM_ID,
      worker_name: 'myco-team-test',
      worker_url: 'https://myco-team-test.example.workers.dev',
      package_version: '0.1.1',
      created_at: '2026-04-13T00:00:00.000Z',
      last_upgraded: '2026-04-13T00:00:00.000Z',
      config_version: 1,
    });
    teamRegistry.save({
      team_id: TEAM_ID,
      name: 'Destroy Team',
      worker_url: 'https://myco-team-test.example.workers.dev',
      domain: null,
      mcp_endpoint: 'https://myco-team-test.example.workers.dev/mcp',
      created_at: new Date().toISOString(),
      projects: [],
    });
    teamRegistry.writeSecret(TEAM_ID, 'MYCO_TEAM_API_KEY', 'api-key');
  });

  afterEach(() => {
    if (originalMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = originalMycoHome;
    if (originalTeamHome === undefined) delete process.env.MYCO_TEAM_HOME;
    else process.env.MYCO_TEAM_HOME = originalTeamHome;
    fs.rmSync(tempDir, { recursive: true, force: true });
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('preserves local retry state when remote teardown fails', async () => {
    // Sequence: detach sync consumer, detach dlq consumer, worker delete, ...
    execHandlers.push(
      () => '',                                    // detach sync-queue consumer
      () => '',                                    // detach dlq consumer
      () => new Error('worker delete exploded'),   // worker delete -> hard failure
      () => '',                                    // vectorize delete
      () => '[]',                                  // d1 list (none)
      () => '[]',                                  // kv list (none)
      () => '',                                    // queue sync delete
      () => '',                                    // queue dlq delete
    );

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');

    await expect(teamDestroy({ teamId: TEAM_ID })).rejects.toThrow('Local state preserved for retry');
    expect(teamRegistry.readDeployment(TEAM_ID)).not.toBeNull();
  });

  it('detaches queue consumers before deleting the worker, then tears everything down', async () => {
    execHandlers.push(
      () => '',                                    // detach sync-queue consumer
      () => '',                                    // detach dlq consumer
      () => '',                                    // worker delete
      () => '',                                    // vectorize delete
      () => JSON.stringify([{ name: 'myco-team-test', uuid: 'db-uuid-123' }]), // d1 list
      () => '',                                    // d1 delete
      () => JSON.stringify([{ id: 'kv-namespace-456', title: 'myco-team-test-secrets' }]), // kv list
      () => '',                                    // kv delete
      () => '',                                    // queue sync delete
      () => '',                                    // queue dlq delete
    );

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');
    await teamDestroy({ teamId: TEAM_ID });

    const calls = execCalls.map((call) => call.args);
    // Regression guard for the CF mutual-reference bug: the worker must be
    // detached as a queue consumer BEFORE the worker delete is attempted.
    const detachIdx = calls.findIndex((a) => a[0] === 'queues' && a[1] === 'consumer' && a[2] === 'worker' && a[3] === 'remove');
    const workerDeleteIdx = calls.findIndex((a) => a[0] === 'delete' && a[1] === 'myco-team-test');
    expect(detachIdx).toBeGreaterThanOrEqual(0);
    expect(workerDeleteIdx).toBeGreaterThan(detachIdx);

    expect(calls).toContainEqual(['queues', 'consumer', 'worker', 'remove', 'myco-team-test-sync', 'myco-team-test']);
    expect(calls).toContainEqual(['queues', 'consumer', 'http', 'remove', 'myco-team-test-sync-dlq']);
    expect(calls).toContainEqual(['delete', 'myco-team-test']);
    expect(calls).toContainEqual(['vectorize', 'delete', 'myco-team-test-vectors']);
    expect(calls).toContainEqual(['d1', 'delete', 'myco-team-test', '--skip-confirmation']);
    expect(calls).toContainEqual(['kv', 'namespace', 'delete', '--namespace-id', 'kv-namespace-456', '--skip-confirmation']);
    expect(calls).toContainEqual(['queues', 'delete', 'myco-team-test-sync']);
    expect(calls).toContainEqual(['queues', 'delete', 'myco-team-test-sync-dlq']);
    expect(teamRegistry.readDeployment(TEAM_ID)).toBeNull();
    expect(teamRegistry.get(TEAM_ID)).toBeNull();
  });

  it('converges on retry when resources are already absent', async () => {
    // Every step reports the resource is already gone — destroy treats this as
    // success and removes local state (idempotent cleanup after a partial run).
    execHandlers.push(
      () => new Error('no consumer found for queue'),
      () => new Error('no consumer found for queue'),
      () => new Error('workers.api.error: service not found [code: 10007]'),
      () => new Error('vectorize.index.deleted - Index name "x-vectors" [code: 3005]'),
      () => '[]',                                  // d1 list (none)
      () => '[]',                                  // kv list (none)
      () => new Error('queue not found'),
      () => new Error('queue not found'),
    );

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');
    await teamDestroy({ teamId: TEAM_ID });   // must NOT throw

    expect(teamRegistry.readDeployment(TEAM_ID)).toBeNull();
    expect(teamRegistry.get(TEAM_ID)).toBeNull();
  });

  it('does NOT mistake a real error containing a hash digit-run for "already absent"', async () => {
    // The worker name embeds an 8-hex hash; a real failure whose message merely
    // echoes a name like "...-3005beef" must not be misread as code 3005 and
    // swallowed (which would wipe local state while the paid worker still lives).
    execHandlers.push(
      () => '',                                                                    // detach sync consumer
      () => '',                                                                    // detach dlq consumer
      () => new Error('myco-team-test-3005beef: too many requests [code: 10013]'), // worker delete: REAL failure
      () => '',                                                                    // vectorize delete
      () => '[]',                                                                  // d1 list (none)
      () => '[]',                                                                  // kv list (none)
      () => '',                                                                    // queue sync delete
      () => '',                                                                    // queue dlq delete
    );

    const { teamDestroy } = await import('../../packages/myco-team/src/cli.js');
    await expect(teamDestroy({ teamId: TEAM_ID })).rejects.toThrow('Local state preserved for retry');
    expect(teamRegistry.readDeployment(TEAM_ID)).not.toBeNull();
  });
});
