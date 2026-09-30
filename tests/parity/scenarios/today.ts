import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { expectPersisted, lit, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The GitHub account the scenario links to the member-role member it joins. */
const MEMBER_ROLE_SUB = '1518001';
const DAY_MS = 86_400_000;

/**
 * Today's reads on both targets (#1518): the session, spore and plan lists across Projects, Myco's work over a window,
 * capture recency on the status, and Needs you. A member who is not an admin reads every one of them but Needs you,
 * which answers an admin alone; and every rule Needs you composes reads on the target's own store.
 */
export const today: ParityScenario = {
  name: 'today: the lists across Projects, Myco\'s work, capture recency and Needs you, read by a member and an admin',
  async run(target: ParityTarget) {
    const admin = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: admin, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
    const machineId = `m_parity_today_${Date.now()}`;
    const joined = await (await fetch(`${target.url}/members/join`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ key: invite.key, machineId }),
    })).json() as { joined: boolean; memberId: string; token: string };
    expect(joined.joined).toBe(true);
    // The run and its spore sit weeks back, in a window no other scenario's work reaches.
    const at = Date.now() - 20 * DAY_MS;
    const runId = `run_parity_today_${at}`;
    const sporeId = `sp_parity_today_${at}`;
    try {
      const stamp = Date.now();
      const sessionId = `parity-today-${stamp}`;
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...memberHeadersFor(joined.token, target.projectId), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }),
      }), 'session.start');
      await target.sql(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('agent_parity_today', 'parity', 'built-in', 1, ${at})`);
      await target.sql(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, started_at, completed_at, tokens_used, cost_usd)
                        VALUES (${lit(target.projectId)}, ${lit(runId)}, 'agent_parity_today', 'extract-curate', 'completed', ${at}, ${at + 60_000}, 1200, 0.42)`);
      await target.sql(`INSERT INTO spores (project_id, id, agent_id, observation_type, status, content, author, created_at)
                        VALUES (${lit(target.projectId)}, ${lit(sporeId)}, 'agent_parity_today', 'gotcha', 'active', 'parity today', ${lit(runId)}, ${at})`);
      await target.sql(`UPDATE members SET github_id = ${lit(MEMBER_ROLE_SUB)} WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: MEMBER_ROLE_SUB, login: 'member', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const member = { cookie, 'cf-connecting-ip': '1.2.3.4' };
      const read = async (headers: Record<string, string>, path: string) => {
        const res = await fetch(`${target.url}${path}`, { headers });
        return { status: res.status, body: await res.json() as Record<string, any> };
      };

      const sessions = await read(member, `/api/sessions?since=${stamp}&agent=claude-code`);
      expect(sessions.status).toBe(200);
      expect(sessions.body.rows.find((r: any) => r.sessionId === sessionId)).toMatchObject({ projectId: target.projectId, agent: 'claude-code' });

      const spores = await read(member, `/api/spores?project=${target.projectId}&since=${at}`);
      expect(spores.status).toBe(200);
      expect(spores.body.spores.find((s: any) => s.id === sporeId)).toMatchObject({ projectId: target.projectId, author: runId });
      expect(spores.body.facets.project[target.projectId]).toBeGreaterThanOrEqual(1);

      const plans = await read(member, '/api/plans');
      expect(plans.status).toBe(200);
      expect(Array.isArray(plans.body.plans)).toBe(true);

      const work = await read(member, `/api/work?project=${target.projectId}&since=${at - 1000}&until=${at + 120_000}`);
      expect(work.status).toBe(200);
      expect(work.body.outcomes).toEqual([expect.objectContaining({
        projectId: target.projectId, kind: 'learn', runs: { completed: 1 }, outcome: { spores: 1, sessions: 0, maps: 0 }, tokens: 1200, costUsd: 0.42,
      })]);
      expect(work.body.runs.map((r: any) => [r.id, r.result])).toEqual([[runId, 'produced']]);
      expect(work.body.upkeep).toMatchObject({ task: 'embedding-reconcile' });

      const status = await read(member, '/api/status');
      expect(status.status).toBe(200);
      expect(status.body.capture.find((c: any) => c.machineId === machineId)).toMatchObject({ agent: 'claude-code', projectId: target.projectId });

      expect(await read(member, '/api/attention')).toMatchObject({ status: 403, body: { error: 'not_admin' } });
      const needs = await read(target.ownerHeaders(), '/api/attention');
      expect(needs.status).toBe(200);
      expect(Array.isArray(needs.body.items)).toBe(true);
      // Every rule reads on this target's store; only the recovery producer, which a target may not run, may be unreadable.
      expect((needs.body.unavailable as string[]).filter((kind) => kind !== 'backup_overdue')).toEqual([]);
      expect((needs.body.items as { kind: string }[]).filter((i) => i.kind === 'schema_mismatch')).toEqual([]);
    } finally {
      await target.sql(`DELETE FROM spores WHERE project_id = ${lit(target.projectId)} AND id = ${lit(sporeId)}`);
      await target.sql(`DELETE FROM agent_runs WHERE project_id = ${lit(target.projectId)} AND id = ${lit(runId)}`);
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(joined.memberId)} AND revoked_at IS NULL`);
      await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(joined.memberId)}`);
    }
  },
};
