import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { sha256Hex } from '@myco-server-worker/hash.js';
import { expectPersisted, lit, memberHeadersFor, SESSION_SECRET, waitFor, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The GitHub account the scenario links to the member-role member it joins. */
const MEMBER_ROLE_SUB = '1518003';

/**
 * What a run read, on both targets (#1518 P3): a titling run served its session's material over its own credential
 * leaves a record of the read after the answer, and a member who is not an administrator reads it off the session
 * (the runs that read it) and off the run (the sessions it read).
 */
export const runReads: ParityScenario = {
  name: 'run reads: a run\'s read of its session is recorded, and a member reads it off the session and the run',
  async run(target: ParityTarget) {
    const now = Date.now();
    const admin = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: admin, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
    const joined = await (await fetch(`${target.url}/members/join`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ key: invite.key, machineId: `m_parity_reads_${now}` }),
    })).json() as { joined: boolean; memberId: string; token: string };
    expect(joined.joined).toBe(true);

    const sessionId = `parity-reads-${now}`;
    const runId = `run_parity_reads_${now}`;
    const tokenId = `mt_parity_reads_${now}`;
    const token = `parity-reads-${now}`.padEnd(43, 'x');
    try {
      const post = async (kind: string, payload: Record<string, unknown>) => expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...memberHeadersFor(joined.token, target.projectId), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind, createdAt: Date.now(), channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload }),
      }), kind);
      await post('session.start', { agent: 'claude-code', startedAt: now });
      await post('prompt', { promptId: crypto.randomUUID(), text: 'Record what the run reads', origin: 'user' });

      await target.sql(`INSERT OR IGNORE INTO members (id, label, created_at) VALUES ('mem_harness', 'harness', ${now})`);
      await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'myco-agent', 'built-in', 1, ${now})`);
      await target.sql(`INSERT INTO member_credentials (id, member_id, machine_id, token_hash, issued_at, expires_at, bytes_written, lineage_root, lineage_started_at)
        VALUES (${lit(tokenId)}, 'mem_harness', 'harness', ${lit(await sha256Hex(token))}, ${now}, ${now + 3_600_000}, 0, ${lit(tokenId)}, ${now})`);
      await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, dispatched_by, run_context)
        VALUES (${lit(target.projectId)}, ${lit(runId)}, 'myco-agent', 'title-summary', 'running', ${now}, ${lit(tokenId)},
          ${lit(JSON.stringify({ session_id: sessionId, mode: 'claim', timeoutSeconds: 300 }))})`);

      const mcp = await fetch(`${target.url}/mcp`, {
        method: 'POST', headers: memberHeadersFor(token, target.projectId, { 'content-type': 'application/json' }),
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'myco_run_sessions', arguments: { op: 'material' } } }),
      });
      expect(mcp.status).toBe(200);
      expect(((await mcp.json()) as { result: { structuredContent: { result: { session_id: string } } } }).result.structuredContent.result.session_id).toBe(sessionId);

      // The record lands after the answer; it is read once it has.
      const recorded = await waitFor(
        () => target.sql(`SELECT session_id AS sessionId, token_id AS tokenId FROM run_reads WHERE project_id = ${lit(target.projectId)} AND run_id = ${lit(runId)}`),
        (rows) => rows.length > 0,
      );
      expect(recorded).toEqual([{ sessionId, tokenId }]);

      await target.sql(`UPDATE members SET github_id = ${lit(MEMBER_ROLE_SUB)} WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: MEMBER_ROLE_SUB, login: 'member', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const read = async (path: string) => {
        const res = await fetch(`${target.url}${path}`, { headers: { cookie, 'cf-connecting-ip': '1.2.3.4' } });
        return { status: res.status, body: await res.json() as Record<string, any> };
      };
      const session = await read(`/api/projects/${target.projectId}/sessions/${sessionId}`);
      expect(session.status).toBe(200);
      expect(session.body.outcome.runs).toEqual([expect.objectContaining({ runId, task: 'title-summary', readAt: expect.any(Number), target: true, titled: false, spores: 0 })]);
      const run = await read(`/api/projects/${target.projectId}/runs/${runId}`);
      expect(run.status).toBe(200);
      expect(run.body.read).toEqual({ sessions: [{ sessionId, title: null, readAt: expect.any(Number) }], total: 1, recorded: true });
      expect(run.body.produced).toEqual({ spores: { total: 0, items: [] } });
    } finally {
      // The scenario's own connection may hold foreign keys off, so the run's record is removed beside the run rather than by its cascade.
      await target.sql(`DELETE FROM run_reads WHERE project_id = ${lit(target.projectId)} AND run_id = ${lit(runId)}`);
      await target.sql(`DELETE FROM agent_runs WHERE project_id = ${lit(target.projectId)} AND id = ${lit(runId)}`);
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE id = ${lit(tokenId)} OR (member_id = ${lit(joined.memberId)} AND revoked_at IS NULL)`);
      await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(joined.memberId)}`);
    }
  },
};
