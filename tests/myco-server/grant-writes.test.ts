/**
 * What an External Agent grant writes, and what it still cannot.
 *
 * A grant records what it found: `myco_spores` `save` and `supersede`, into the
 * one Project its row names, attributed to the grant's own `agents` row rather
 * than to the `user` agent a member writes under. It has no Myco session, so it
 * cites a pull request or a commit instead. Everything else the surface refuses
 * is held by `mcp.test.ts`, which enumerates the registry minus the allowlist;
 * this file proves the writes that are on the surface land correctly attributed
 * and that a lapsed grant reaches nothing while its rows stay whole.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { issueExternalGrant, rotateExternalGrant } from '@myco-server-worker/auth/grants.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { USER_AGENT_ID } from '@myco-server-worker/mcp/context.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteEnv, memberHeaders } from './helpers/fixtures.js';

const DAY_MS = 86_400_000;
const PR = 'https://github.com/goondocks/myco/pull/1149';
const SHA = '0123456789abcdef0123456789abcdef01234567';

const rpc = (method: string, params?: unknown) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

const grantRequest = (key: string, body: string, headers: Record<string, string> = {}) =>
  new Request('https://s/mcp', { method: 'POST', headers: { authorization: `Bearer ${key}`, 'cf-connecting-ip': '1.2.3.4', ...headers }, body });

async function setup(ttlDays?: number) {
  const e = sqliteEnv();
  const now = Date.now();
  const member = await issueMemberToken(e.db, { memberId: 'mem_machine_1', machineId: 'machine_1' }, now);
  const grant = await issueExternalGrant(e.db, { projectId: 'proj_1' }, 'review bot', 'mem_machine_1', now, ttlDays);

  const callAs = async (key: string, name: string, args: Record<string, unknown> = {}, headers: Record<string, string> = {}) => {
    const res = await worker.fetch(grantRequest(key, rpc('tools/call', { name, arguments: args }), headers), e.env);
    const body = await res.json() as any;
    return { status: res.status, result: body.result?.structuredContent?.result, error: body.error };
  };
  const memberCall = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await worker.fetch(new Request('https://s/mcp', { method: 'POST', headers: memberHeaders(member.token), body: rpc('tools/call', { name, arguments: args }) }), e.env);
    return ((await res.json()) as any).result?.structuredContent?.result;
  };
  /** A spore the grant recorded, straight from the row. */
  const sporeRow = (id: string) => e.sqlite.query(`SELECT agent_id, author, session_id, provenance_kind, provenance_ref FROM spores WHERE id = ?`).get(id) as any;
  const save = async (args: Record<string, unknown> = {}) =>
    callAs(grant.key, 'myco_spores', { op: 'save', type: 'discovery', content: 'the reviewer found a dangling index', ...args });

  return { ...e, now, member, grant, callAs, memberCall, sporeRow, save };
}

describe('an External Agent grant writes as itself', () => {
  it('records a spore attributed to the grant, not to the user agent, and with no session of its own', async () => {
    const { grant, save, sporeRow, sqlite } = await setup();
    const written = (await save()).result;
    expect(written).toMatchObject({ observation_type: 'discovery', status: 'active' });
    expect(sporeRow(written.id)).toMatchObject({ agent_id: grant.id, author: grant.id, session_id: null });
    expect(sporeRow(written.id).agent_id).not.toBe(USER_AGENT_ID);
    expect(sqlite.query(`SELECT id FROM agents WHERE id = ?`).get(grant.id)).toEqual({ id: grant.id });
  });

  it('withholds the author from the grant\'s own read of its own write, and shows it to a member', async () => {
    const { save, callAs, memberCall, grant } = await setup();
    const written = (await save()).result;
    const own = await callAs(grant.key, 'myco_spores', { op: 'get', id: written.id });
    expect('author' in own.result).toBe(false);
    const listed = await callAs(grant.key, 'myco_spores', { op: 'list' });
    expect(listed.result.spores.map((s: any) => 'author' in s)).toEqual([false]);
    expect((await memberCall('myco_spores', { op: 'get', id: written.id })).author).toBe(grant.id);
  });

  it('supersedes its own spore, carrying the same author onto the resolution event', async () => {
    const { grant, save, callAs, sqlite } = await setup();
    const older = (await save()).result;
    const newer = (await save({ content: 'the index is dangling on the successor too' })).result;
    const resolved = await callAs(grant.key, 'myco_spores', { op: 'supersede', old_spore_id: older.id, new_spore_id: newer.id, reason: 'the newer read is the accurate one' });
    expect(resolved.result).toEqual({ old_spore: older.id, new_spore: newer.id, status: 'superseded' });
    expect(sqlite.query(`SELECT agent_id, author, action FROM resolution_events WHERE spore_id = ?`).get(older.id))
      .toEqual({ agent_id: grant.id, author: grant.id, action: 'supersede' });
    expect(sqlite.query(`SELECT status FROM spores WHERE id = ?`).get(older.id)).toEqual({ status: 'superseded' });
  });

  it('cites a pull request or a commit in place of a session, and refuses a citation that is half given or malformed', async () => {
    const { save, sporeRow } = await setup();
    const cited = (await save({ provenance_kind: 'pr', provenance_ref: PR })).result;
    expect(sporeRow(cited.id)).toMatchObject({ provenance_kind: 'pr', provenance_ref: PR, session_id: null });
    const committed = (await save({ provenance_kind: 'commit', provenance_ref: SHA })).result;
    expect(sporeRow(committed.id)).toMatchObject({ provenance_kind: 'commit', provenance_ref: SHA });

    const bad: Array<Record<string, unknown>> = [
      { provenance_kind: 'pr' },
      { provenance_ref: PR },
      { provenance_kind: 'commit', provenance_ref: 'not-a-sha' },
      { provenance_kind: 'commit', provenance_ref: 'abc' },
      { provenance_kind: 'pr', provenance_ref: 'http://github.com/x/y/pull/1' },
      { provenance_kind: 'pr', provenance_ref: `https://x/${'y'.repeat(600)}` },
    ];
    for (const args of bad) {
      const refused = await save(args);
      expect({ args, ok: refused.result?.ok, id: refused.result?.id }).toEqual({ args, ok: false, id: undefined });
    }
  });

  it('names no session: a grant that sends one is told the session is not found, not that the tool is unknown', async () => {
    const { grant, callAs } = await setup();
    const named = await callAs(grant.key, 'myco_spores', { op: 'save', type: 'gotcha', content: 'x', session_id: 'sess_1' });
    expect({ error: named.error, ok: named.result.ok, reason: named.result.error }).toEqual({ error: undefined, ok: false, reason: 'session_id not found' });
  });

  it('cannot write a plan, and cannot read or write any Project but its own', async () => {
    const { grant, callAs, executed } = await setup();
    const plan = await callAs(grant.key, 'myco_plans', { op: 'save', content: '# p', session_id: 's', plan_key: 'k' });
    expect(plan.error).toEqual({ code: -32000, message: 'Unknown tool: myco_plans', data: { code: 'unknown_tool' } });

    const from = executed.length;
    for (const projectId of ['proj_2', 'proj_nowhere']) {
      const foreign = await callAs(grant.key, 'myco_spores', { op: 'save', type: 'gotcha', content: 'x', project_id: projectId });
      expect({ projectId, error: foreign.error }).toEqual({ projectId, error: { code: -32000, message: 'Unknown tool: myco_spores', data: { code: 'unknown_tool' } } });
    }
    expect(executed.slice(from).filter((sql) => /\bprojects\b/i.test(sql))).toEqual([]);

    const misnamed = await callAs(grant.key, 'myco_spores', { op: 'save', type: 'gotcha', content: 'in its own project' }, { [PROJECT_HEADER]: 'proj_2' });
    expect((await callAs(grant.key, 'myco_spores', { op: 'get', id: misnamed.result.id })).result.content).toBe('in its own project');
  });

  it('refuses a lapsed grant with 401 while every row it wrote survives with its attribution', async () => {
    const { env, grant, save, sporeRow, sqlite } = await setup(1);
    const written = (await save()).result;
    sqlite.query(`UPDATE external_grants SET expires_at = ? WHERE id = ?`).run(Date.now() - DAY_MS, grant.id);

    const refused = await worker.fetch(grantRequest(grant.key, rpc('tools/list')), env);
    expect(refused.status).toBe(401);
    expect(sporeRow(written.id)).toMatchObject({ agent_id: grant.id, author: grant.id });
    expect(sqlite.query(`SELECT id FROM external_grants WHERE id = ?`).get(grant.id)).toEqual({ id: grant.id });
    expect(sqlite.query(`SELECT id FROM agents WHERE id = ?`).get(grant.id)).toEqual({ id: grant.id });
  });

  it('refuses a rotated predecessor with 401 and admits the successor, whose writes carry the successor\'s own id', async () => {
    const { env, db, grant, callAs, sporeRow } = await setup();
    const successor = await rotateExternalGrant(db, { projectId: 'proj_1' }, grant.id, 'mem_machine_1', Date.now());
    expect((await worker.fetch(grantRequest(grant.key, rpc('tools/list')), env)).status).toBe(401);
    const written = await callAs(successor!.key, 'myco_spores', { op: 'save', type: 'decision', content: 'written after the rotation' });
    expect(sporeRow(written.result.id)).toMatchObject({ agent_id: successor!.id, author: successor!.id });
  });
});
