import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';
import { recordDefaultDeployment } from '@myco/member/default-deployment.js';
import { drainEntryBacklog } from '@myco/member/backlog.js';
import { unboundedBudget } from '@myco/member/budget.js';
import { sessionStartEvent } from '@myco/member/envelope.js';
import { seedMachineSettings } from '@myco/member/machine-settings.js';
import { prefetchContext, warmProjectContext } from '@myco/member/prefetch.js';
import { refreshMembership } from '@myco/member/refresh.js';
import { deploymentPath, REGISTRY_VERSION, writeDeploymentMembership, writeRegistryEntry, type RegistryEntry } from '@myco/member/registry.js';
import { updateSessionState } from '@myco/member/session-state.js';
import { MemberSpool } from '@myco/member/spool.js';
import { selectedDeploymentMembership } from '@myco/member/token-pairing.js';
import { ServerClient } from '@myco/member/transport.js';
import { tempMycoHome } from './helpers/server.js';

const A = 'https://a.example';
const B = 'https://b.example';
const PROJECT = 'proj_pairing';
const membership = (mycoHome: string, serverUrl: string, token: string): void => {
  writeDeploymentMembership({ serverUrl, token, machineId: 'machine_pairing', joinedAt: 1, updatedAt: 1 }, { mycoHome });
};

describe('member destination token pairing', () => {
  it('rejects a same-URL and Project client holding another Deployment token before outbound', async () => {
    const mycoHome = tempMycoHome();
    membership(mycoHome, A, 'token-a');
    membership(mycoHome, B, 'token-b');
    const spool = new MemberSpool({ serverUrl: A, projectId: PROJECT }, { mycoHome });
    expect(() => spool.assertClientDestination(new ServerClient({ serverUrl: A, projectId: PROJECT, token: 'token-b' })))
      .toThrow('belongs to another Deployment');
    expect(() => spool.assertClientDestination(new ServerClient({ serverUrl: `${A}/`, projectId: PROJECT, token: 'token-a' })))
      .not.toThrow();
    membership(mycoHome, A, 'token-a-rotated');
    expect(() => spool.assertClientDestination(new ServerClient({ serverUrl: A, projectId: PROJECT, token: 'token-a' })))
      .toThrow('does not belong to its destination membership');
    expect(() => spool.assertClientDestination(new ServerClient({ serverUrl: A, projectId: PROJECT, token: 'token-a-rotated' })))
      .not.toThrow();
    const sessionId = 'session-pairing';
    spool.append(sessionId, sessionStartEvent({ agent: 'claude-code', sessionId, stage: spool.stagerFor(sessionId), now: () => 1 }, { startedAt: 1, originPath: '/checkout' }));
    let fetches = 0;
    const fetch = async (): Promise<Response> => {
      fetches += 1;
      return new Response(JSON.stringify({ persisted: true }), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    await expect(spool.drainSession(sessionId, new ServerClient({ serverUrl: A, projectId: PROJECT, token: 'token-b' }, fetch), unboundedBudget()))
      .rejects.toThrow('belongs to another Deployment');
    expect(fetches).toBe(0);
    expect(await spool.drainSession(sessionId, new ServerClient({ serverUrl: A, projectId: PROJECT, token: 'token-a-rotated' }, fetch), unboundedBudget()))
      .toMatchObject({ acked: 1, remaining: 0 });
    expect(fetches).toBe(1);
  });

  it('keeps independent environment credentials while refusing a token known to another Deployment', () => {
    const mycoHome = tempMycoHome();
    membership(mycoHome, A, 'token-a');
    membership(mycoHome, B, 'token-b');
    const spool = new MemberSpool({ serverUrl: A, projectId: PROJECT }, { mycoHome });
    const env = (token: string) => new ServerClient({ serverUrl: A, projectId: PROJECT, token }, undefined, { credentialSource: 'env' });
    expect(() => spool.assertClientDestination(env('independent-a'))).not.toThrow();
    expect(() => spool.assertClientDestination(env('token-b'))).toThrow('belongs to another Deployment');
    fs.writeFileSync(deploymentPath(B, mycoHome), '{invalid', { mode: 0o600 });
    expect(() => spool.assertClientDestination(env('independent-a'))).toThrow('memberships are unavailable');
  });

  it('fails closed on a missing or unreadable destination membership', () => {
    const mycoHome = tempMycoHome();
    const spool = new MemberSpool({ serverUrl: A, projectId: PROJECT }, { mycoHome });
    const client = new ServerClient({ serverUrl: A, projectId: PROJECT, token: 'token-a' });
    expect(() => spool.assertClientDestination(client)).toThrow('does not belong to its destination membership');
    membership(mycoHome, A, 'token-a');
    fs.writeFileSync(deploymentPath(A, mycoHome), '{invalid', { mode: 0o600 });
    expect(() => spool.assertClientDestination(client)).toThrow('destination membership is unavailable');
  });

  it('selects only an explicit or recorded default membership', () => {
    const mycoHome = tempMycoHome();
    membership(mycoHome, A, 'token-a');
    expect(selectedDeploymentMembership(mycoHome)).toBeNull();
    expect(selectedDeploymentMembership(mycoHome, A)?.serverUrl).toBe(A);
    membership(mycoHome, B, 'token-b');
    expect(selectedDeploymentMembership(mycoHome)).toBeNull();
    recordDefaultDeployment(B, { mycoHome });
    expect(selectedDeploymentMembership(mycoHome)?.serverUrl).toBe(B);
    expect(selectedDeploymentMembership(mycoHome, A)?.serverUrl).toBe(A);
    fs.writeFileSync(deploymentPath(B, mycoHome), '{invalid', { mode: 0o600 });
    expect(selectedDeploymentMembership(mycoHome)).toBeNull();
  });

  it('does not fetch machine settings with a token from another membership', async () => {
    const mycoHome = tempMycoHome();
    membership(mycoHome, A, 'token-a');
    membership(mycoHome, B, 'token-b');
    let calls = 0;
    const seeded = await seedMachineSettings({ serverUrl: A, token: 'token-b' }, {
      mycoHome, fetch: async () => { calls += 1; throw new Error('unexpected network request'); },
    });
    expect(seeded).toBe(false);
    expect(calls).toBe(0);
  });

  it('refuses a token recorded for two Deployments before ordinary and forced non-rotating refresh', async () => {
    for (const nonRotating of [false, true]) {
      const mycoHome = tempMycoHome();
      writeDeploymentMembership({ serverUrl: A, token: 'shared-token', machineId: 'machine_pairing', joinedAt: 1, updatedAt: 1, nonRotating }, { mycoHome });
      membership(mycoHome, B, 'shared-token');
      let fetches = 0;
      const fetch = async (): Promise<Response> => {
        fetches += 1;
        throw new Error('unexpected network request');
      };
      await expect(refreshMembership(A, { mycoHome, fetch, budget: unboundedBudget(), force: true }))
        .rejects.toThrow('belongs to another Deployment');
      expect(fetches).toBe(0);
    }
  });

  it('refuses the backlog refresh before any outbound request', async () => {
    const mycoHome = tempMycoHome();
    const entry: RegistryEntry = {
      version: REGISTRY_VERSION, root: path.join(mycoHome, 'repo'), projectId: PROJECT,
      serverUrl: A, token: 'shared-token', machineId: 'machine_pairing', joinedAt: 1, updatedAt: 1,
    };
    writeRegistryEntry(entry, { mycoHome });
    membership(mycoHome, B, 'shared-token');
    let fetches = 0;
    const fetch = async (): Promise<Response> => {
      fetches += 1;
      throw new Error('unexpected network request');
    };
    await expect(drainEntryBacklog(entry, { mycoHome, fetch })).rejects.toThrow('belongs to another Deployment');
    expect(fetches).toBe(0);
  });

  it('refuses context warming and pending prefetch before their requests', async () => {
    const mycoHome = tempMycoHome();
    membership(mycoHome, A, 'shared-token');
    membership(mycoHome, B, 'shared-token');
    const record = { serverUrl: A, projectId: PROJECT, token: 'shared-token' };
    const spool = new MemberSpool(record, { mycoHome });
    const sessionId = 'session-pairing-context';
    updateSessionState(spool.dir, sessionId, (state) => { state.contextAsks = [{ kind: 'start', at: 1 }]; });
    let fetches = 0;
    const fetch = async (): Promise<Response> => {
      fetches += 1;
      throw new Error('unexpected network request');
    };
    await expect(warmProjectContext(record, { mycoHome, fetch })).rejects.toThrow('belongs to another Deployment');
    await expect(prefetchContext({
      spool, client: new ServerClient(record, fetch), serverUrl: A, mycoHome, budget: unboundedBudget(), now: Date.now,
    })).rejects.toThrow('belongs to another Deployment');
    expect(fetches).toBe(0);
  });
});
