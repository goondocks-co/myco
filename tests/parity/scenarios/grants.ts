import { expect } from 'bun:test';
import { EXTERNAL_TOOLS } from '@myco-server-worker/mcp/external.js';
import { lit, type ParityScenario, type ParityTarget } from '../harness.ts';

/**
 * An External Agent grant on both targets: the owner mints it, it lists the
 * external surface and writes a spore attributed to itself, its own read
 * withholds the author a member's read shows, naming another Project is one
 * refusal, a key the schema does not declare is refused by name, and after the
 * owner revokes it nothing answers while its rows keep their attribution.
 */
export const grants: ParityScenario = {
  name: 'grants: minted by the owner, writes as itself, refused off its Project, silent after revocation',
  async run(target: ParityTarget) {
    const ownerPost = async (path: string, body: Record<string, unknown> = {}) =>
      fetch(`${target.url}${path}`, { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const asGrant = async (key: string, method: string, params?: unknown) => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { ...target.grantHeaders(key), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      });
      return { status: res.status, body: (res.status === 200 ? await res.json() : null) as any };
    };
    const asMember = async (name: string, args: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/mcp`, {
        method: 'POST',
        headers: { ...target.memberHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
      });
      expect(res.status).toBe(200);
      return ((await res.json()) as any).result.structuredContent.result;
    };

    const minted = await ownerPost(`/api/projects/${target.projectId}/grants`, { label: 'parity reviewer' });
    expect(minted.status).toBe(201);
    const { key, id } = (await minted.json()) as { key: string; id: string };

    // The surface it lists is the external one, and nothing else.
    const listed = await asGrant(key, 'tools/list');
    expect(listed.status).toBe(200);
    expect(listed.body.result.tools.map((t: { name: string }) => t.name).sort()).toEqual([...EXTERNAL_TOOLS].sort());

    // An executed write, attributed to the grant, citing a pull request in place of a session.
    const stamp = Date.now();
    const saved = await asGrant(key, 'tools/call', {
      name: 'myco_spores',
      arguments: { op: 'save', type: 'discovery', content: `the reviewer found a dangling index ${stamp}`, provenance_kind: 'pr', provenance_ref: 'https://github.com/goondocks/myco/pull/1149' },
    });
    const spore = saved.body.result.structuredContent.result as { id: string; status: string };
    expect(spore.status).toBe('active');
    expect((await target.sql(`SELECT agent_id, author, session_id, provenance_kind FROM spores WHERE id = ${lit(spore.id)}`))[0])
      .toEqual({ agent_id: id, author: id, session_id: null, provenance_kind: 'pr' });

    // Its own read withholds the author; a member's read shows it.
    const own = (await asGrant(key, 'tools/call', { name: 'myco_spores', arguments: { op: 'get', id: spore.id } })).body.result.structuredContent.result;
    expect('author' in own).toBe(false);
    expect((await asMember('myco_spores', { op: 'get', id: spore.id })).author).toBe(id);

    // Another Project, read or written, is one refusal; a retired spelling of the tenancy key is refused by name.
    const foreign = await asGrant(key, 'tools/call', { name: 'myco_spores', arguments: { op: 'list', project: `elsewhere-${stamp}` } });
    expect(foreign.body.error).toEqual({ code: -32000, message: 'Unknown tool: myco_spores', data: { code: 'unknown_tool' } });
    const misspelled = await asGrant(key, 'tools/call', { name: 'myco_spores', arguments: { op: 'list', project_id: target.projectId } });
    expect([misspelled.body.error?.data?.code, String(misspelled.body.error?.message).includes("'project_id'")]).toEqual(['invalid_input', true]);

    // Revoked: no answer for the key, every row it wrote keeps its attribution.
    const revoked = await ownerPost(`/api/projects/${target.projectId}/grants/${id}/revoke`);
    expect([revoked.status, ((await revoked.json()) as { revoked: boolean }).revoked]).toEqual([200, true]);
    expect((await asGrant(key, 'tools/list')).status).toBe(401);
    expect((await target.sql(`SELECT author FROM spores WHERE id = ${lit(spore.id)}`))[0]).toEqual({ author: id });
  },
};
