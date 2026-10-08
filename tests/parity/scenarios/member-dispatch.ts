import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { lit, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The GitHub account the scenario links to the member-role member it joins. */
const MEMBER_ROLE_SUB = '1518005';
const TASK = 'title-summary';

/**
 * A member who is not an admin starting a task by hand, on both targets (#1518 A10): it reads which tasks a Project
 * has turned on and may not change them; it starts runs, each recorded as its own, up to its daily ceiling, past which
 * the dispatch answers 429 with when the ceiling resets and writes no run; a fresh run is refused to it. An admin is
 * never capped, and a task a capability gates is refused to both where the Project has it off.
 */
export const memberDispatch: ParityScenario = {
  name: 'member dispatch: a member starts tasks up to its daily ceiling, reads capabilities, and is refused what an admin alone does',
  async run(target: ParityTarget) {
    const admin = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    await target.sql(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES (${lit(target.projectId)}, ${lit(target.projectId)}, ${Date.now()})`);
    const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: admin, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
    const joined = await (await fetch(`${target.url}/members/join`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ key: invite.key, machineId: `m_parity_member_dispatch_${Date.now()}` }),
    })).json() as { joined: boolean; memberId: string };
    expect(joined.joined).toBe(true);
    await target.sql(`UPDATE members SET github_id = ${lit(MEMBER_ROLE_SUB)} WHERE id = ${lit(joined.memberId)}`);
    const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub: MEMBER_ROLE_SUB, login: 'member', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
    const member = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
    const started: string[] = [];
    const dispatch = async (headers: Record<string, string>, body: Record<string, unknown>) => {
      const res = await fetch(`${target.url}/api/harness/dispatch`, { method: 'POST', headers, body: JSON.stringify({ task: TASK, projectId: target.projectId, ...body }) });
      const answer = await res.json() as Record<string, any>;
      if (typeof answer.runId === 'string') started.push(answer.runId);
      return { status: res.status, body: answer };
    };
    try {
      const capabilities = await fetch(`${target.url}/api/projects/${target.projectId}/capabilities`, { headers: member });
      expect(capabilities.status).toBe(200);
      const change = await fetch(`${target.url}/api/projects/${target.projectId}/capabilities/vault_evolution`, { method: 'PUT', headers: member, body: JSON.stringify({ enabled: true }) });
      expect({ status: change.status, body: await change.json() }).toMatchObject({ status: 403, body: { error: 'not_admin' } });

      expect(await dispatch(member, { fresh: true })).toEqual({ status: 403, body: { error: 'fresh_needs_admin' } });

      // Start runs until the ceiling answers; the ceiling is whatever this Deployment's settings make it.
      let refused: { status: number; body: Record<string, any> } | null = null;
      for (let i = 0; i < 20 && refused === null; i += 1) {
        const answer = await dispatch(member, {});
        if (answer.status === 429) refused = answer;
        else expect({ status: answer.status, queued: answer.body.queued }).toEqual({ status: 200, queued: true });
      }
      expect(refused).not.toBeNull();
      expect(refused!.body).toMatchObject({ error: 'daily_limit', task: TASK });
      expect(started.length).toBe(refused!.body.perDay);
      if (started.length > 0) expect(typeof refused!.body.resetsAt).toBe('number');
      const actors = await target.sql(`SELECT json_extract(dispatch_spec, '$.actor') AS actor FROM agent_runs WHERE project_id = ${lit(target.projectId)} AND id IN (${started.map(lit).join(', ') || "''"})`) as Array<{ actor: string }>;
      expect(actors.map((r) => r.actor)).toEqual(started.map(() => joined.memberId));

      const listed = await (await fetch(`${target.url}/api/projects/${target.projectId}/runs?task=${TASK}`, { headers: member })).json() as { rows: Array<{ id: string; startedBy: string | null }> };
      for (const id of started) expect(listed.rows.find((r) => r.id === id)?.startedBy).toBe(joined.memberId);

      // An admin is never capped.
      expect((await dispatch(admin, {})).status).toBe(200);

      // A task a capability gates is refused, to a member and an admin alike, where the Project has it off.
      const gated = `parity-member-gate-${Date.now()}`;
      await target.sql(`INSERT INTO projects (project_id, name, created_at) VALUES (${lit(gated)}, ${lit(gated)}, ${Date.now()})`);
      for (const headers of [member, admin]) {
        const res = await fetch(`${target.url}/api/harness/dispatch`, { method: 'POST', headers, body: JSON.stringify({ task: 'extract-curate', projectId: gated }) });
        expect({ status: res.status, body: await res.json() }).toMatchObject({ status: 409, body: { error: 'capability_off', capability: 'vault_evolution' } });
      }
      const rows = await target.sql(`SELECT COUNT(*) AS n FROM agent_runs WHERE project_id = ${lit(gated)}`) as Array<{ n: number }>;
      expect(Number(rows[0]!.n)).toBe(0);
    } finally {
      if (started.length > 0) await target.sql(`DELETE FROM agent_runs WHERE project_id = ${lit(target.projectId)} AND id IN (${started.map(lit).join(', ')})`);
    }
  },
};
