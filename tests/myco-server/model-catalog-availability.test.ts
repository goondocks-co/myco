import { afterEach, describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { catalogResolution, readModelCatalogs, recordModelCatalog } from '@myco-server-worker/core/model-catalogs.js';
import { CONTACT_THROTTLE_MS, recordWorkerContact } from '@myco-server-worker/core/worker-contacts.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { settingsWriter } from '@myco-server-worker/core/settings.js';
import type { ModelCatalog } from '@goondocks/myco-shared/execution-profile';
import { memberPost, sqliteEnv, turnOnGatedCapabilities } from './helpers/fixtures.js';
import { asOwner, OWNER_ENV } from './helpers/owner.js';
import { offeredHarness } from './helpers/offered-harness.js';

const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });
const catalog = (now: number): ModelCatalog => ({
  harness: 'claude-code', source: { kind: 'exchange', command: 'claude listing' }, signIn: 'worker-login', fetchedAt: now,
  models: [{ id: 'opus', label: 'Opus', resolvesTo: 'claude-opus-fixture' }],
});

async function rig() {
  const e = sqliteEnv({ workerLogin: true });
  cleanups.push(() => e.sqlite.close());
  Object.assign(e.env, OWNER_ENV);
  const now = Date.now();
  const token = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine-1' }, now);
  const json = async (request: Request) => {
    const response = await worker.fetch(request, e.env);
    expect(response.status).toBe(200);
    return await response.json() as { models?: ModelCatalog[]; recorded?: boolean; claimed?: boolean; run?: { profile: { resolvesTo?: string } } };
  };
  const models = async () => (await json(await asOwner('/api/settings'))).models ?? [];
  return { ...e, now, token, json, models };
}

describe('catalog availability from current machine offers', () => {
  it('withdraws Settings models and resolutions on logout/removal, refuses late catalog revival, and permits reauthentication', async () => {
    const r = await rig();
    const report = async (offers: Array<{ id: string; authenticated: boolean }>) => {
      const answer = await r.json(memberPost(r.token.token, { harnesses: offers }, '/worker/claim'));
      expect(answer.claimed).toBe(false);
    };
    const list = () => r.json(memberPost(r.token.token, { catalog: catalog(r.now) }, '/worker/models'));
    const resolution = () => catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', Date.now());
    expect((await list()).recorded).toBe(true);
    expect(await r.models()).toHaveLength(1);
    expect(await resolution()).toBe('claude-opus-fixture');
    await report([{ id: 'claude-code', authenticated: true }]);
    expect(await r.models()).toHaveLength(1);
    await report([{ id: 'claude-code', authenticated: false }]);
    expect(await r.models()).toEqual([]);
    expect(await resolution()).toBeUndefined();
    expect((await list()).recorded).toBe(true);
    expect(await r.models()).toEqual([]);
    expect(await resolution()).toBeUndefined();
    await report([]);
    expect((await list()).recorded).toBe(true);
    expect(await r.models()).toEqual([]);
    expect(await resolution()).toBeUndefined();
    await report([{ id: 'claude-code', authenticated: true }]);
    expect(await r.models()).toHaveLength(1);
    expect(await resolution()).toBe('claude-opus-fixture');
  });

  it('keeps the latest explicit withdrawal across credentials and unknown successor reports without withdrawing other machines', async () => {
    const r = await rig();
    const successor = await issueMemberToken(r.db, { memberId: 'mem_machine_1', machineId: 'machine-1' }, r.now);
    const unrelated = await issueMemberToken(r.db, { memberId: 'mem_machine_1', machineId: 'machine-2' }, r.now);
    const renewedUnrelated = await issueMemberToken(r.db, { memberId: 'mem_machine_1', machineId: 'machine-2' }, r.now);
    const unknown = await issueMemberToken(r.db, { memberId: 'mem_machine_1', machineId: 'unknown-machine' }, r.now);
    for (const machineId of ['machine-1', 'machine-2', 'unknown-machine', 'initial-machine']) {
      await recordModelCatalog(r.db, { machineId, catalog: catalog(r.now), now: r.now });
    }
    await recordWorkerContact(r.db, { credentialId: r.token.tokenId, machineId: 'machine-1', offers: [], capabilities: [], now: r.now + 1 });
    await recordWorkerContact(r.db, { credentialId: successor.tokenId, machineId: 'machine-1', now: r.now + 2 });
    await recordWorkerContact(r.db, { credentialId: unrelated.tokenId, machineId: 'machine-2', offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], now: r.now + 3 });
    await recordWorkerContact(r.db, { credentialId: unknown.tokenId, machineId: 'unknown-machine', now: r.now + 4 });
    await recordWorkerContact(r.db, { credentialId: renewedUnrelated.tokenId, machineId: 'machine-2', now: r.now + 5 });
    expect(await readModelCatalogs(r.db, r.now + 10)).toHaveLength(2);
    expect(await catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', r.now + 10)).toBeUndefined();
    expect(await catalogResolution(r.db, 'machine-2', 'claude-code', 'opus', r.now + 10)).toBe('claude-opus-fixture');
    expect(await catalogResolution(r.db, 'unknown-machine', 'claude-code', 'opus', r.now + 10)).toBeUndefined();
    expect(await catalogResolution(r.db, 'initial-machine', 'claude-code', 'opus', r.now + 10)).toBe('claude-opus-fixture');
    r.sqlite.run(`UPDATE worker_contacts SET offers = '{unreadable' WHERE credential_id = ?`, [successor.tokenId]);
    expect(await catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', r.now + 10)).toBeUndefined();
    await recordWorkerContact(r.db, { credentialId: successor.tokenId, machineId: 'machine-1', offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], now: r.now + 20 });
    expect(await readModelCatalogs(r.db, r.now + 20)).toHaveLength(3);
    expect(await catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', r.now + 20)).toBe('claude-opus-fixture');
  });

  it('surfaces failure reading worker availability instead of returning a misleading catalog result', async () => {
    const r = await rig();
    await recordModelCatalog(r.db, { machineId: 'machine-1', catalog: catalog(r.now), now: r.now });
    const original = r.db.prepare.bind(r.db);
    r.db.prepare = (sql) => {
      if (sql.includes('FROM worker_contacts')) throw new Error('worker availability unavailable');
      return original(sql);
    };
    await expect(readModelCatalogs(r.db, r.now)).rejects.toThrow('worker availability unavailable');
    await expect(catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', r.now)).rejects.toThrow('worker availability unavailable');
  });

  it('resolves the cached model on the first reauthenticated claim using that claim’s current offers', async () => {
    const r = await rig();
    turnOnGatedCapabilities(r.sqlite);
    await ensureMember(r.db, HARNESS_MEMBER_ID, r.now, 'member', 'harness');
    r.sqlite.run(`INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','agent','built-in',1,?)`, [r.now]);
    await settingsWriter(r.db).setLeaf('agent.tasks', { 'extract-curate': { harness: 'claude-code', model: 'opus', reasoningLevel: 'high' } }, 'mem_machine_1', r.now);
    await r.json(memberPost(r.token.token, { catalog: catalog(r.now) }, '/worker/models'));
    await r.json(memberPost(r.token.token, { harnesses: [{ id: 'claude-code', authenticated: false }] }, '/worker/claim'));
    expect(await r.models()).toEqual([]);
    r.sqlite.run(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at,held_by,instruction,run_context)
      VALUES ('proj_1','reauth-run','myco-agent','extract-curate','queued',?,'worker','read the project','{}')`, [r.now]);
    const answer = await r.json(memberPost(r.token.token, { harnesses: [offeredHarness('claude-code')] }, '/worker/claim'));
    expect(answer).toMatchObject({ claimed: true, run: { profile: { model: 'opus', resolvesTo: 'claude-opus-fixture' } } });
    expect(await r.models()).toHaveLength(1);
  });

  it('keeps a newer withdrawal authoritative when an older authenticated credential renews its liveness', async () => {
    const r = await rig();
    const successor = await issueMemberToken(r.db, { memberId: 'mem_machine_1', machineId: 'machine-1' }, r.now);
    await recordModelCatalog(r.db, { machineId: 'machine-1', catalog: catalog(r.now), now: r.now });
    await recordWorkerContact(r.db, { credentialId: r.token.tokenId, machineId: 'machine-1', offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], now: r.now + 1 });
    await recordWorkerContact(r.db, { credentialId: successor.tokenId, machineId: 'machine-1', offers: [], capabilities: [], now: r.now + 2 });
    const renewedAt = r.now + CONTACT_THROTTLE_MS + 3;
    await recordWorkerContact(r.db, { credentialId: r.token.tokenId, machineId: 'machine-1', now: renewedAt });
    expect(await readModelCatalogs(r.db, renewedAt)).toEqual([]);
    expect(await catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', renewedAt)).toBeUndefined();
    expect(r.sqlite.query(`SELECT last_seen_at FROM worker_contacts WHERE credential_id = ?`).get(r.token.tokenId)).toEqual({ last_seen_at: renewedAt });
    await recordWorkerContact(r.db, { credentialId: successor.tokenId, machineId: 'machine-1', offers: [{ id: 'claude-code', authenticated: true }], capabilities: [], now: renewedAt + 1 });
    expect(await readModelCatalogs(r.db, renewedAt + 1)).toHaveLength(1);
    expect(await catalogResolution(r.db, 'machine-1', 'claude-code', 'opus', renewedAt + 1)).toBe('claude-opus-fixture');
  });
});
