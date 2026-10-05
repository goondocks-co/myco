import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { expectPersisted, lit, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The GitHub account the scenario links to the member-role member it joins. */
const MEMBER_ROLE_SUB = '1518001';
const DAY_MS = 86_400_000;

/**
 * Today's reads on both targets (#1518): the session, spore and plan lists across Projects (sessions by start and by
 * activity), Myco's work over a window, capture recency on the status, and Needs you. A member who is not an admin
 * reads every one of them but Needs you, which answers an admin alone; and every rule Needs you composes reads on the
 * target's own store.
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

      // A session that started days ago and is still receiving is in today's activity window, not in today's starts.
      await target.sql(`UPDATE sessions SET started_at = ${stamp - 2 * DAY_MS} WHERE project_id = ${lit(target.projectId)} AND session_id = ${lit(sessionId)}`);
      const listed = async (path: string) => ((await read(member, path)).body.rows as any[]).some((r) => r.sessionId === sessionId);
      const since = stamp - 60_000;
      const until = Date.now() + 60_000;
      expect(await listed(`/api/sessions?since=${since}&until=${until}&window=activity`)).toBe(true);
      expect(await listed(`/api/projects/${target.projectId}/sessions?since=${since}&until=${until}&window=activity`)).toBe(true);
      expect(await listed(`/api/sessions?since=${since}&until=${until}`)).toBe(false);

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
      await dashboardHonesty(target, member, at);
    } finally {
      await target.sql(`DELETE FROM spores WHERE project_id = ${lit(target.projectId)} AND id = ${lit(sporeId)}`);
      await target.sql(`DELETE FROM agent_runs WHERE project_id = ${lit(target.projectId)} AND id = ${lit(runId)}`);
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(joined.memberId)} AND revoked_at IS NULL`);
      await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(joined.memberId)}`);
    }
  },
};


/** Full-window work state and all-project task scope through each target's HTTP API. */
async function dashboardHonesty(target: ParityTarget, member: Record<string, string>, at: number) {
  const a = `proj_honesty_a_${at}`;
  const b = `proj_honesty_b_${at}`;
  const failed = `run_honesty_failed_${at}`;
  const read = async <T,>(path: string): Promise<T> => {
    const response = await fetch(`${target.url}${path}`, { headers: member });
    expect(response.status).toBe(200);
    return await response.json() as T;
  };
  await target.sql(`INSERT INTO projects (project_id, name, created_at) VALUES (${lit(a)},'Honesty A',${at}), (${lit(b)},'Honesty B',${at})`);
  try {
    await target.sql(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by)
      VALUES (${lit(a)},'canopy',0,${at},'fixture'), (${lit(b)},'canopy',1,${at},'fixture')`);
    const tasks = async () => {
      const data = await read<{ tasks: Array<{ task: string; availabilityNote: string | null }> }>('/api/tasks');
      const counts = (await target.sql(`SELECT COUNT(*) AS total,
        SUM(CASE WHEN EXISTS (SELECT 1 FROM project_capabilities pc WHERE pc.project_id=p.project_id AND pc.capability='canopy' AND pc.enabled=1) THEN 0 ELSE 1 END) AS off
        FROM projects p WHERE archived_at IS NULL`))[0]!;
      const expected = counts.off === 0 ? null : counts.total === 1 ? 'Switched off for this project'
        : counts.off === counts.total ? 'Switched off for every project' : `Switched off for ${counts.off} of ${counts.total} selected projects`;
      expect(data.tasks.find((task) => task.task === 'canopy-map')?.availabilityNote)
        .toBe(expected);
    };
    await tasks();
    await target.sql(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,completed_at)
      VALUES (${lit(a)},${lit(failed)},'agent_parity_today','canopy-map','failed',${at},${at})`);
    await target.sql(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<200)
      INSERT INTO agent_runs (project_id,id,agent_id,task,status,started_at,completed_at)
      SELECT ${lit(b)},'run_honesty_' || ${at} || '_' || i,'agent_parity_today','canopy-map','completed',${at}+i,${at}+i FROM n`);
    await target.sql(`INSERT INTO agent_run_events (project_id,run_id,event_type,tool_name,outcome,payload,recorded_at)
      SELECT project_id,id,'run_write','myco_run_map','written','{}',completed_at FROM agent_runs WHERE project_id=${lit(b)}`);
    const query = `/api/work?project=${a}&project=${b}&since=${at-1}&until=${at+1000}`;
    interface Work { runs: Array<{ id: string }>; cursor: string | null; outcomes: Array<{ projectId: string; kind: string; runs: Record<string, number>; outcome: { spores: number }; failure: { runs: number; latestRunId: string; producedSince: number } | null }> }
    const first = await read<Work>(query);
    expect(first.runs).toHaveLength(200);
    expect(first.cursor).not.toBeNull();
    expect(first.runs.some((run) => run.id === failed)).toBe(false);
    expect(first.outcomes.find((outcome) => outcome.projectId === a)?.failure).toMatchObject({ runs: 1, latestRunId: failed, producedSince: 0 });
    const next = await read<Work>(`${query}&cursor=${encodeURIComponent(first.cursor!)}`);
    expect(next.runs.map((run) => run.id)).toEqual([failed]);
    expect(next.cursor).toBeNull();
    expect(next.outcomes).toEqual(first.outcomes);
    await target.sql(`INSERT INTO agent_runs (project_id,id,agent_id,task,status,queued_at)
      VALUES (${lit(a)},'run_honesty_queued','agent_parity_today','vault-seed','queued',${at})`);
    const queued = (await read<Work>(query)).outcomes.find((outcome) => outcome.kind === 'seed');
    expect(queued).toMatchObject({ runs: { queued: 1 }, outcome: { spores: 0 }, failure: null });
    await target.sql(`UPDATE projects SET archived_at=${at+1000} WHERE project_id=${lit(a)}`);
    await tasks();
  } finally {
    await target.sql(`UPDATE agent_runs SET status='failed', completed_at=${at+1000} WHERE project_id=${lit(a)} AND status='queued'`);
    await target.sql(`UPDATE projects SET archived_at=${at+1000} WHERE project_id IN (${lit(a)},${lit(b)})`);
  }
}
