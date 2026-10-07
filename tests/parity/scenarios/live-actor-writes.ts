import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { MEMBER_ID, SESSION_SECRET, lit, type ParityScenario, type ParityTarget } from '../harness.ts';

const ADMIN = 'mem_live_write_admin';
const MEMBER = 'mem_live_write_member';
const TASK = 'extract-curate';

async function request(target: ParityTarget, path: string, method: string, headers: Record<string, string>, body?: unknown): Promise<Response> {
  return fetch(`${target.url}${path}`, {
    method, headers: { ...headers, origin: target.url, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function session(target: ParityTarget, sub: string): Promise<Record<string, string>> {
  const now = Date.now();
  return { cookie: `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { aud: target.deploymentId, sub, login: 'live-write', iat: now, exp: now + 3_600_000 })}`, 'cf-connecting-ip': '1.2.3.4' };
}

/** Demotion commits on the serving store before the guarded mutation batch begins. */
export const liveActorWrites: ParityScenario = {
  name: 'live actor writes: settings and dispatch refuse demotion at the native and D1 commit',
  dedicated: { cloudflare: { main: '../../tests/parity/owner-review/worker-entry.ts' }, stopRace: true, timeoutMs: 240_000 },
  async run(target) {
    const now = Date.now();
    await target.sql(`INSERT INTO members (id, role, github_id, created_at) VALUES (${lit(ADMIN)}, 'admin', '720901', ${now}), (${lit(MEMBER)}, 'member', '720902', ${now})`);
    // Keep the admin distinct from the Deployment owner.
    await target.sql(`UPDATE deployment_ownership SET member_id = ${lit(MEMBER_ID)}, bootstrap_mode = 'selection' WHERE id = 1`);
    const admin = await session(target, '720901');
    const member = await session(target, '720902');
    await target.sql(`INSERT INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (${lit(target.projectId)}, 'vault_evolution', 1, ${now}, ${lit(MEMBER_ID)})`);
    await target.sql(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES ('agent.tasks', ${lit(JSON.stringify({ [TASK]: { schedule: { memberRunsPerDay: 1 } } }))}, ${now}, ${lit(MEMBER_ID)})`);
    for (const harness of ['claude-code', 'codex', 'opencode']) {
      await target.sql(`INSERT INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (${lit(`agent.harnesses.${harness}.credential`)}, '"worker-login"', ${now}, ${lit(MEMBER_ID)})`);
    }
    expect((await request(target, '/api/settings/agent.reasoning_map.claude-code.default', 'PUT', admin, { value: 'claude-opus-5' })).status).toBe(200);
    expect((await request(target, '/api/secrets/anthropic', 'PUT', admin, { value: 'synthetic-subscription' })).status).toBe(200);
    const cases = [
      { path: '/api/harness/dispatch', method: 'POST', body: { task: 'container-smoke', projectId: target.projectId, fresh: true, timeoutSeconds: 123 }, write: 'INSERT INTO agent_runs', table: 'agent_runs', where: "task = 'container-smoke'" },
      { path: '/api/settings/agent.scheduled_tasks_enabled', method: 'PUT', body: { value: true }, write: 'INSERT INTO deployment_settings', table: 'deployment_settings', where: "leaf = 'agent.scheduled_tasks_enabled'" },
      { path: '/api/harness/dispatch', method: 'POST', body: { task: TASK, projectId: target.projectId, fresh: true, timeoutSeconds: 123 }, write: 'INSERT INTO agent_runs', table: 'agent_runs', where: '1=1' },
      { path: `/api/projects/${target.projectId}`, method: 'PATCH', body: { name: 'renamed' }, write: 'UPDATE projects', table: 'projects', where: `project_id = ${lit(target.projectId)}` },
    ];
    for (const operation of cases) {
      const before = await target.sql(`SELECT * FROM ${operation.table} WHERE ${operation.where}`);
      const refusedMember = await request(target, operation.path, operation.method, member, operation.body);
      expect(refusedMember.status).toBe(403);
      expect(await target.sql(`SELECT * FROM ${operation.table} WHERE ${operation.where}`)).toEqual(before);
      for (const revoke of [false, true]) {
        await target.sql(`UPDATE members SET role = 'admin', revoked_at = NULL WHERE id = ${lit(ADMIN)}`);
        expect((await request(target, '/__parity/stop-race/arm', 'POST', {}, { memberId: ADMIN, write: operation.write, revoke })).status).toBe(200);
        const refused = await request(target, operation.path, operation.method, admin, operation.body);
        expect(refused.status).toBe(403);
        expect(await refused.json() as Record<string, unknown>).toEqual(operation.path === '/api/harness/dispatch'
          ? { error: 'fresh_needs_admin' }
          : { error: 'not_admin', reason: 'this action is for an admin' });
        expect(await target.sql(`SELECT * FROM ${operation.table} WHERE ${operation.where}`)).toEqual(before);
        expect(await (await fetch(`${target.url}/__parity/stop-race/status`)).json() as Record<string, unknown>).toEqual({ fired: true, armed: false });
        expect(await target.sql(`SELECT role, revoked_at FROM members WHERE id = ${lit(ADMIN)}`)).toEqual([{ role: revoke ? 'admin' : 'member', revoked_at: revoke ? 1 : null }]);
      }
      await target.sql(`UPDATE members SET role = 'admin', revoked_at = NULL WHERE id = ${lit(ADMIN)}`);
      const applied = await request(target, operation.path, operation.method, admin, operation.body);
      expect(applied.status).toBe(200);
      expect(await target.sql(`SELECT * FROM ${operation.table} WHERE ${operation.where}`)).not.toEqual(before);
    }
    for (const operation of ['recovery', 'first', 'all']) {
      for (const revoke of [false, true]) {
        await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(ADMIN)}`);
        const table = operation === 'recovery' ? 'recovery_forget_commands' : 'projects';
        const before = await target.sql(`SELECT * FROM ${table}`);
        await request(target, '/__parity/stop-race/arm', 'POST', {}, { memberId: ADMIN, write: operation === 'recovery' ? 'INSERT INTO recovery_forget_commands' : 'UPDATE projects', revoke });
        expect((await request(target, '/__parity/live-write', 'POST', {}, { memberId: ADMIN, operation, projectId: target.projectId })).status).toBe(403);
        expect(await target.sql(`SELECT * FROM ${table}`)).toEqual(before);
      }
      await target.sql(`UPDATE members SET role='admin', revoked_at=NULL WHERE id=${lit(ADMIN)}`);
      expect((await request(target, '/__parity/live-write', 'POST', {}, { memberId: ADMIN, operation, projectId: target.projectId })).status).toBe(200);
    }
    const ordinary = { task: TASK, projectId: target.projectId, timeoutSeconds: 123 };
    expect((await request(target, '/api/harness/dispatch', 'POST', member, ordinary)).status).toBe(200);
    expect((await request(target, '/api/harness/dispatch', 'POST', member, ordinary)).status).toBe(429);
    const [run] = await target.sql(`SELECT json_extract(run_context, '$.timeoutSeconds') AS timeout FROM agent_runs WHERE json_extract(dispatch_spec, '$.actor') = ${lit(MEMBER)}`);
    expect(run?.timeout).not.toBe(123);
  },
};
