/**
 * A Deployment secret is stored sealed and opened only to authenticate or to
 * hand a launched runtime its credential. No other answer carries it: an admin
 * calling every dashboard route, a member sending every member route the
 * request that route acts on, and a member calling every MCP tool meet neither
 * the value nor a fragment of it.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { MEMBER_TOKEN_REFRESH_WINDOW_MS, MEMBER_TOKEN_TTL_MS } from '@myco-server-worker/auth/tokens.js';
import { memberHeaders, sqliteEnv, turnOnGatedCapabilities, uuid } from './helpers/fixtures.js';
import { issueMemberToken } from './helpers/member-token.js';
import { memberRouteFixtures } from './helpers/member-route-fixtures.js';
import { OWNER_ENV, ownerCookie } from './helpers/owner.js';

const VALUE = 'sk-ant-api03-c2VjcmV0LWRpc3BsYXktZml4dHVyZS12YWx1ZQ';
const WRAP_KEY = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
/** Long enough to be the value's own, short enough that a masked or truncated rendering still carries it. */
const FRAGMENTS = [VALUE, VALUE.slice(-12), VALUE.slice(8, 24)];
const MEMBER = { memberId: 'mem_machine_1', machineId: 'machine_1' };

const concretePath = (path: string) => path.replace(/\{(sha256|key)\}/g, 'a'.repeat(64)).replace('{promptId}', uuid(1)).replace('{name}', 'anthropic')
  .replace('{projectId}', 'proj_1').replace('{memberId}', 'mem_machine_1').replace(/\{[^}]+\}/g, 'a');

async function deploymentWithSecret() {
  const e = sqliteEnv({ workerLogin: true });
  turnOnGatedCapabilities(e.sqlite);
  const bindings = { ...e.env, ...OWNER_ENV, SECRET_WRAP_KEY: { get: async () => WRAP_KEY } };
  const env = serverEnvFromBindings(bindings as never);
  await deploymentSecretStore(env.db, env.wrappingKey).put('anthropic', VALUE, 'mem_machine_1', Date.now());
  return { e, bindings: bindings as never };
}

const leaks = (text: string) => FRAGMENTS.some((fragment) => text.includes(fragment));

describe('a stored Deployment secret', () => {
  it('is answered by no dashboard route an admin calls', async () => {
    const leaked: string[] = [];
    const sessionRoutes = ROUTES.filter((r) => r.auth === 'session');
    expect(sessionRoutes.some((r) => r.method !== 'GET')).toBe(true);
    for (const r of sessionRoutes) {
      // A write may change what a later route reads, so each route answers on a Deployment of its own.
      const { e, bindings } = await deploymentWithSecret();
      const cookie = await ownerCookie(e.db);
      const res = await worker.fetch(new Request(`https://s${concretePath(r.path)}`, {
        method: r.method, headers: { cookie, 'cf-connecting-ip': '1.2.3.4', origin: 'https://s' }, body: r.method === 'GET' ? undefined : '{}',
      }), bindings);
      if (leaks(await res.text())) leaked.push(`${r.method} ${r.path}`);
      e.sqlite.close();
    }
    expect(leaked).toEqual([]);
  });

  it('is answered by no member route a member sends the request it acts on, each on a live credential', async () => {
    const { e, bindings } = await deploymentWithSecret();
    const issuedAt = Date.now() - (MEMBER_TOKEN_TTL_MS - MEMBER_TOKEN_REFRESH_WINDOW_MS / 2);
    const machineless = await issueMemberToken(e.db, { memberId: 'mem_anon', machineId: null }, issuedAt);
    const other = await issueMemberToken(e.db, MEMBER, issuedAt);
    const fixtures = await memberRouteFixtures(e.sqlite, issuedAt, { otherTokenId: other.tokenId, machinelessToken: machineless.token });
    const leaked: string[] = [];
    const refused: string[] = [];
    for (const r of ROUTES.filter((x) => x.auth === 'member')) {
      const route = `${r.method} ${r.path}`;
      // One credential per route: a route that revokes or rotates the credential it was sent leaves the next route its own.
      const token = (await issueMemberToken(e.db, MEMBER, issuedAt)).token;
      const fixture = fixtures[route];
      expect({ route, fixture: fixture !== undefined }).toEqual({ route, fixture: true });
      const res = await worker.fetch(fixture!.wellFormed(token), bindings);
      if (res.status === 401) refused.push(route);
      if (leaks(await res.text())) leaked.push(route);
    }
    expect(refused).toEqual([]);
    expect(leaked).toEqual([]);
    e.sqlite.close();
  });

  it('is answered by no MCP tool a member calls', async () => {
    const { e, bindings } = await deploymentWithSecret();
    const rpc = async (token: string, method: string, params?: unknown) => {
      const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(token), body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }), bindings);
      return { status: res.status, text: await res.text() };
    };
    const listed = await rpc((await issueMemberToken(e.db, MEMBER, Date.now())).token, 'tools/list');
    const tools = (JSON.parse(listed.text) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    expect(tools.length).toBeGreaterThan(0);
    const leaked: string[] = [];
    const refused: string[] = [];
    for (const name of tools) {
      const answer = await rpc((await issueMemberToken(e.db, MEMBER, Date.now())).token, 'tools/call', { name, arguments: {} });
      if (answer.status === 401) refused.push(name);
      if (leaks(answer.text)) leaked.push(name);
    }
    expect(refused).toEqual([]);
    expect(leaked).toEqual([]);
    e.sqlite.close();
  });
});
