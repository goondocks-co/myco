/**
 * A queued run is in flight, on native SQLite and on D1 alike: a task that runs
 * once at a time admits no second run while one of it waits in the queue, a
 * queued run can still be ended, and a run its runtime was launched for and that
 * went back to the queue is still claimed by that runtime's credential.
 */
import { describe, expect, it } from 'bun:test';
import type { RelationalStore } from '@myco-server-worker/core/adapters.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { claimRun, launchQueued, NO_LIMITS, recordDispatch, recordQueued, returnToQueue } from '@myco-server-worker/db/runs/claim.js';
import { applyRunUpdate } from '@myco-server-worker/db/runs/change.js';
import { getRun } from '@myco-server-worker/db/runs/lifecycle.js';
import { issueMemberToken } from './helpers/member-token.js';
import { withDocumentStores } from './helpers/document-stores.js';

const TASK = 'embedding-reconcile';
const NOW = 1_800_000_000_000;
const scope = { projectId: 'project' };

async function queue(db: RelationalStore, id: string) {
  await db.prepare("INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, 1)").run();
  expect(await recordQueued(db, scope, { id, agentId: 'myco-agent', task: TASK, provider: null, model: null, heldBy: 'worker', queuedAt: NOW, dispatchSpec: '{}' })).toBe(true);
}

const status = async (db: RelationalStore, id: string) => (await getRun(db, scope, id))?.status ?? null;

describe('a queued run, on both stores', () => {
  it('holds its task: a single-flight dispatch of the same task is not admitted while it waits', async () => {
    await withDocumentStores(async (db, target) => {
      await queue(db, 'run_waiting');
      const admitted = await recordDispatch(db, scope, { id: 'run_second', agentId: 'myco-agent', task: TASK, provider: null, model: null, runContext: null, dispatchedBy: null, startedAt: NOW },
        { limits: NO_LIMITS, now: NOW, singleFlight: true });
      expect({ target, admitted, second: await getRun(db, scope, 'run_second') }).toEqual({ target, admitted: false, second: null });
    });
  });

  it('can still be ended: a terminal change applies to it', async () => {
    await withDocumentStores(async (db, target) => {
      await queue(db, 'run_waiting');
      const changed = await applyRunUpdate(db, scope, 'run_waiting', { status: 'failed', error: 'ended while queued' });
      expect({ target, changed, status: await status(db, 'run_waiting') }).toEqual({ target, changed: 1, status: 'failed' });
    });
  });

  it('is claimed by the credential it was launched for after it went back to the queue', async () => {
    await withDocumentStores(async (db, target) => {
      await queue(db, 'run_relaunched');
      await ensureMember(db, 'mem_runtime', NOW, 'member', 'runtime');
      const credential = await issueMemberToken(db, { memberId: 'mem_runtime', machineId: 'machine_runtime' }, NOW);
      expect(await launchQueued(db, scope, 'run_relaunched', { task: TASK, dispatchedBy: credential.tokenId, startedAt: NOW, runContext: null, provider: null, model: null })).toBe(true);
      expect(await returnToQueue(db, scope, 'run_relaunched', { heldBy: 'runtime', dispatchSpec: '{}', credential: credential.tokenId, now: NOW })).toBe(true);
      expect(await status(db, 'run_relaunched')).toBe('queued');
      const claimed = await claimRun(db, scope, { id: 'run_relaunched', agentId: 'myco-agent', task: TASK, instruction: null, harness: 'embedding', provider: null, model: null, dryRun: false, startedAt: NOW, runContext: null, dispatchedBy: credential.tokenId },
        { taskName: TASK, admission: { kind: 'embedding' }, embeddingConfigured: true, dispatchedOnly: true }, NOW);
      expect({ target, claimed, status: await status(db, 'run_relaunched') }).toEqual({ target, claimed: { claimed: true }, status: 'running' });
    });
  });
});
