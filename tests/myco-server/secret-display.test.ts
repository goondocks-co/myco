/**
 * A Deployment secret is stored sealed and opened only to authenticate or to
 * hand a launched runtime its credential. No surface that displays anything
 * answers it: an admin reading every dashboard route, and a member reading
 * every member route, meets neither the value nor a fragment of it.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities, uuid } from './helpers/fixtures.js';
import { issueMemberToken } from './helpers/member-token.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const VALUE = 'sk-ant-api03-c2VjcmV0LWRpc3BsYXktZml4dHVyZS12YWx1ZQ';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
/** Long enough to be the value's own, short enough that a masked or truncated rendering still carries it. */
const FRAGMENTS = [VALUE, VALUE.slice(-12), VALUE.slice(8, 24)];

const concretePath = (path: string) => path.replace(/\{(sha256|key)\}/g, 'a'.repeat(64)).replace('{promptId}', uuid(1)).replace('{name}', 'anthropic')
  .replace('{projectId}', 'proj_1').replace('{memberId}', 'mem_machine_1').replace(/\{[^}]+\}/g, 'a');

async function deploymentWithSecret() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  const bindings = { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } };
  const env = serverEnvFromBindings(bindings as never);
  await deploymentSecretStore(env.db, env.wrappingKey).put('anthropic', VALUE, 'mem_machine_1', Date.now());
  return { e, bindings };
}

const leaks = (text: string) => FRAGMENTS.filter((fragment) => text.includes(fragment));

describe('a stored Deployment secret', () => {
  it('is answered by no dashboard route an admin reads', async () => {
    const { e, bindings } = await deploymentWithSecret();
    const cookie = await ownerCookie(e.db);
    const read = ROUTES.filter((r) => r.auth === 'session' && r.method === 'GET');
    expect(read.length).toBeGreaterThan(0);
    const leaked: string[] = [];
    for (const r of read) {
      const res = await worker.fetch(new Request(`https://s${concretePath(r.path)}`, { headers: { cookie, 'cf-connecting-ip': '1.2.3.4' } }), bindings as never);
      if (leaks(await res.text()).length > 0) leaked.push(`${r.method} ${r.path}`);
    }
    expect(leaked).toEqual([]);
    e.sqlite.close();
  });

  it('is answered by no member route a member reads', async () => {
    const { e, bindings } = await deploymentWithSecret();
    const t = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, Date.now());
    const read = ROUTES.filter((r) => r.auth === 'member');
    const leaked: string[] = [];
    for (const r of read) {
      const res = await worker.fetch(new Request(`https://s${concretePath(r.path)}`, { method: r.method, headers: memberHeaders(t.token), body: r.method === 'GET' ? undefined : '{}' }), bindings as never);
      if (leaks(await res.text()).length > 0) leaked.push(`${r.method} ${r.path}`);
    }
    expect(leaked).toEqual([]);
    e.sqlite.close();
  });
});
