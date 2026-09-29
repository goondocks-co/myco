import { expect } from 'bun:test';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { ROUTES } from '@myco-server-worker/routes.js';
import { expectPersisted, lit, memberHeadersFor, SESSION_SECRET, type ParityScenario, type ParityTarget } from '../harness.ts';

/** The GitHub account the scenario links to the member-role member it joins. */
const MEMBER_ROLE_SUB = '1491001';

/** A path a route serves, with every segment it names filled in. */
function pathOf(template: string, projectId: string): string {
  return template
    .replace('{projectId}', projectId).replace('{sessionId}', 's_parity_authority').replace('{promptId}', '00000000-0000-7000-8000-000000000001')
    .replace('{planKey}', '00000000-0000-5000-8000-000000000002').replace('{runId}', 'r_parity_authority').replace('{memberId}', 'mem_parity_absent')
    .replace('{grantId}', 'eg_parity_absent').replace('{child}', 'prompts').replace('{key}', 'a'.repeat(64)).replace('{leaf}', 'digest.enabled')
    .replace('{name}', 'openai').replace('{capability}', 'search').replace('{check}', 'optimize').replace('{tier}', '5000')
    .replace(/\{[A-Za-z]+\}/g, 'x_parity_absent');
}

/**
 * Who a dashboard session reaches, on both targets (#1491): a member who is not an admin is refused every route the
 * route table declares `admin`, before its handler runs, and is answered the read views and their own credentials.
 */
export const sessionAuthority: ParityScenario = {
  name: 'session authority: a member who is not an admin is refused every admin route and answered the read views',
  async run(target: ParityTarget) {
    const admin = { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' };
    const invite = await (await fetch(`${target.url}/api/enrollment`, { method: 'POST', headers: admin, body: JSON.stringify({ role: 'member' }) })).json() as { key: string };
    const joined = await (await fetch(`${target.url}/members/join`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'cf-connecting-ip': '1.2.3.4' },
      body: JSON.stringify({ key: invite.key, machineId: `m_parity_authority_${Date.now()}` }),
    })).json() as { joined: boolean; memberId: string; token: string };
    expect(joined.joined).toBe(true);
    try {
      // The member captures a session, which is also what makes the Project exist for the reads below.
      const stamp = Date.now();
      await expectPersisted(await fetch(`${target.url}/events`, {
        method: 'POST', headers: { ...memberHeadersFor(joined.token, target.projectId), 'content-type': 'application/json' },
        body: JSON.stringify({ eventId: crypto.randomUUID(), sessionId: `parity-authority-${stamp}`, kind: 'session.start', createdAt: stamp, channel: 'cli', producer: { adapter: 'parity', version: '1' }, payload: { agent: 'claude-code', startedAt: stamp } }),
      }), 'session.start');
      await target.sql(`UPDATE members SET github_id = ${lit(MEMBER_ROLE_SUB)} WHERE id = ${lit(joined.memberId)}`);
      const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: MEMBER_ROLE_SUB, login: 'member', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
      const member = { cookie, 'cf-connecting-ip': '1.2.3.4', origin: target.url, 'content-type': 'application/json' };
      const call = (headers: Record<string, string>, method: string, path: string) =>
        fetch(`${target.url}${path}`, { method, headers, body: method === 'GET' ? undefined : '{}' });

      // Every admin route refuses the member, with the refusal an admin-only surface answers.
      const answered: Record<string, number | string> = {};
      const expected: Record<string, number | string> = {};
      for (const r of ROUTES) {
        if (r.auth !== 'session' || r.authority !== 'admin') continue;
        const res = await call(member, r.method, pathOf(r.path, target.projectId));
        const body = res.status === 403 ? (await res.json() as { error?: string }).error ?? res.status : res.status;
        answered[`${r.method} ${r.path}`] = body;
        expected[`${r.method} ${r.path}`] = 'not_admin';
      }
      expect(Object.keys(expected).length).toBeGreaterThan(40);
      expect(answered).toEqual(expected);

      // The read views answer the member.
      const reads = ['/api/status', '/api/projects', '/api/kpis?window=7d', `/api/projects/${target.projectId}/sessions`, `/api/projects/${target.projectId}/spores`,
        `/api/projects/${target.projectId}/plans`, `/api/projects/${target.projectId}/runs`, `/api/projects/${target.projectId}/digests`];
      const statuses = Object.fromEntries(await Promise.all(reads.map(async (p) => [p, (await call(member, 'GET', p)).status] as const)));
      expect(statuses).toEqual(Object.fromEntries(reads.map((p) => [p, 200])));

      // Runtimes: a member is listed their own credentials alone, and reads no other member's activity.
      const listed = await (await call(member, 'GET', '/api/credentials?purpose=member')).json() as { rows: { id: string; memberId: string }[] };
      expect(listed.rows.length).toBeGreaterThan(0);
      expect([...new Set(listed.rows.map((r) => r.memberId))]).toEqual([joined.memberId]);
      const everyone = await (await call(admin, 'GET', '/api/credentials?purpose=member')).json() as { rows: { id: string; memberId: string }[] };
      const another = everyone.rows.find((r) => r.memberId !== joined.memberId);
      expect(another).toBeDefined();
      expect((await call(member, 'GET', `/api/credentials/${another!.id}/activity`)).status).toBe(404);
      expect((await call(member, 'GET', `/api/credentials/${listed.rows[0]!.id}/activity`)).status).toBe(200);
      expect((await call(admin, 'GET', `/api/credentials/${another!.id}/activity`)).status).toBe(200);

      // An admin reaches the routes the member is refused.
      expect((await call(admin, 'GET', '/api/secrets')).status).toBe(200);
      expect((await call(admin, 'GET', '/api/settings')).status).toBe(200);
    } finally {
      await target.sql(`UPDATE member_credentials SET revoked_at = ${Date.now()} WHERE member_id = ${lit(joined.memberId)} AND revoked_at IS NULL`);
      await target.sql(`UPDATE members SET revoked_at = ${Date.now()}, github_id = NULL WHERE id = ${lit(joined.memberId)}`);
    }
  },
};
