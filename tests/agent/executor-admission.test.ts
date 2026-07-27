/**
 * Write admission at the run entry: `runAgent` refuses to start (or resume) a
 * run for a project whose write lease is held — before any durable act, so a
 * refused dispatch leaves no agent_runs row. A run writes into the project
 * for its whole lifetime and has no abort path once dispatched; admission at
 * this entry is what keeps an in-flight run from writing through a residency
 * transition's push window.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getDatabase } from '@myco/db/client.js';
import { setupTestDb, cleanTestDb, teardownTestDb } from '../helpers/db';
import { runAgent } from '@myco/agent/executor.js';
import { acquireProjectLease } from '@myco/grove/project-lease.js';
import { assertGroveProjectId } from '@myco/grove/ids.js';
import type { MycoRequestContext } from '@myco/grove/request-context.js';
import { testPerUserLockNamespace } from '../helpers/per-user-lock-namespace.js';

const PROJECT = assertGroveProjectId('proj_' + 'e'.repeat(32));

describe('runAgent — write admission before the first durable act', () => {
  let mycoHome: string;
  let vaultDir: string;
  const prevMycoHome = process.env.MYCO_HOME;

  beforeAll(() => { setupTestDb(); });
  afterAll(() => {
    teardownTestDb();
    if (prevMycoHome === undefined) delete process.env.MYCO_HOME;
    else process.env.MYCO_HOME = prevMycoHome;
  });
  beforeEach(() => {
    cleanTestDb();
    mycoHome = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-run-admission-'));
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'myco-run-vault-'));
    process.env.MYCO_HOME = mycoHome;
  });
  afterEach(() => {
    fs.rmSync(mycoHome, { recursive: true, force: true });
    fs.rmSync(vaultDir, { recursive: true, force: true });
  });

  function requestContext(): MycoRequestContext {
    return {
      projectRoot: vaultDir,
      callerRoot: null,
      projectId: PROJECT,
      groveId: 'grv_' + '0'.repeat(32),
      machineId: 'test_machine',
      sessionId: null,
      projectVaultDir: path.join(vaultDir, '.myco'),
      databasePath: ':memory:',
      source: 'explicit',
      tenancySource: 'daemon',
    };
  }

  it('refuses dispatch while the project lease is held, with no run row created', async () => {
    acquireProjectLease(PROJECT, 'residency-detach', 'leaving the team', null, mycoHome, testPerUserLockNamespace);

    const result = await runAgent(vaultDir, { requestContext: requestContext() });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('project_lease_held');
    expect(result.error).toContain('residency-detach');
    const runs = getDatabase().prepare('SELECT COUNT(*) AS n FROM agent_runs').get() as { n: number };
    expect(runs.n).toBe(0);
  });

  it('refuses resume through the same entry while the lease is held', async () => {
    acquireProjectLease(PROJECT, 'grove-move', 'moving grove', null, mycoHome, testPerUserLockNamespace);

    const result = await runAgent(vaultDir, {
      requestContext: requestContext(),
      resumeRunId: 'run_preexisting',
    });

    expect(result.status).toBe('failed');
    expect(result.runId).toBe('run_preexisting');
    expect(result.error).toContain('project_lease_held');
  });

  it('an unreadable lease record refuses dispatch — failed read is never unheld', async () => {
    const leasePath = path.join(mycoHome, 'leases', `${PROJECT}.json`);
    fs.mkdirSync(path.dirname(leasePath), { recursive: true });
    fs.writeFileSync(leasePath, '{ torn', 'utf-8');

    const result = await runAgent(vaultDir, { requestContext: requestContext() });

    expect(result.status).toBe('failed');
    expect(result.error).toContain('project_lease_held');
  });
});
