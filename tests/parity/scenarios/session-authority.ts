import { expect } from 'bun:test';
import type { ParityScenario } from '../harness.ts';
import { linkedMember, asMember } from '../clients/runs.ts';
import { event, owner } from '../clients/requests.ts';

/** A linked non-admin account reads dashboard views and only its own credentials. */
export const sessionAuthority: ParityScenario = {
  name: 'session authority: a member who is not an admin is refused administration and answered the read views',
  async run(target) {
    const joined = await linkedMember(target, '1491001');
    const call = (method: string, path: string) => fetch(`${target.url}${path}`, { method, headers: joined.headers, ...(method === 'GET' ? {} : { body: '{}' }) });
    try {
      await event(asMember(target, joined.token), `authority-${crypto.randomUUID()}`, 'session.start', { agent: 'claude-code', startedAt: Date.now() });
      const refused = await call('POST', `/api/projects/${target.projectId}/archive`);
      expect({ status: refused.status, body: await refused.json() }).toMatchObject({ status: 403, body: { error: 'not_admin' } });
      for (const path of ['/api/status', '/api/projects', '/api/kpis?window=7', `/api/projects/${target.projectId}/sessions`, `/api/projects/${target.projectId}/spores`, `/api/projects/${target.projectId}/plans`, `/api/projects/${target.projectId}/runs`]) expect((await call('GET', path)).status).toBe(200);
      const listed = await (await call('GET', '/api/credentials?purpose=member')).json() as { rows: { id: string; memberId: string }[] };
      expect(listed.rows.length).toBeGreaterThan(0);
      expect([...new Set(listed.rows.map(row => row.memberId))]).toEqual([joined.memberId]);
      const everyone = await owner(target, '/api/credentials?purpose=member');
      const another = everyone.body.rows.find((row: any) => row.memberId !== joined.memberId);
      expect(another).toBeDefined();
      expect((await call('GET', `/api/credentials/${another.id}/activity`)).status).toBe(404);
      expect((await call('GET', `/api/credentials/${listed.rows[0]!.id}/activity`)).status).toBe(200);
      expect((await owner(target, `/api/credentials/${another.id}/activity`)).status).toBe(200);
      expect((await owner(target, '/api/secrets')).status).toBe(200);
      expect((await owner(target, '/api/settings')).status).toBe(200);
    } finally {
      expect((await owner(target, `/api/members/${joined.memberId}/revoke`, { method: 'POST', body: '{}' })).status).toBe(200);
    }
  },
};
