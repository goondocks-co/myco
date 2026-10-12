import { expect } from 'bun:test';
import { lit, MEMBER_ID, memberHeadersFor, type ParityScenario } from '../harness.ts';

export const repositories: ParityScenario = {
  name: 'repositories: sealed owner access and retired run route',
  async run(target) {
    await target.sql(`INSERT OR IGNORE INTO projects(project_id,name,created_at) VALUES (${lit(target.projectId)},'Repository parity',${Date.now()})`);
    const endpoint = `/api/projects/${target.projectId}/repository`;
    const source = 'https://github.com/example/source.git';
    const secret = 'parity-repository-token-with-no-real-permissions';
    const owner = async (method: string, body?: unknown) => {
      const result = await fetch(target.url + endpoint, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: result.status, body: await result.json() as any };
    };
    const prior = await owner('GET');
    expect(prior.status).toBe(200);
    expect(prior.body.repository).toBeNull();
    try {
      const saved = await owner('PUT', { url: source, branch: 'main', revision: null, credential: { username: 'reader', token: secret } });
      expect(saved.status).toBe(200);
      expect(saved.body.repository.updatedBy).toBe(MEMBER_ID);
      expect(saved.body.repository.credential.readable).toBe(true);
      expect(JSON.stringify(saved.body)).not.toContain(secret);
      const rows = await target.sql(`SELECT ciphertext FROM deployment_secrets WHERE name LIKE ${lit('repository:' + target.projectId + ':%')}`);
      expect(rows.length).toBe(1);
      expect(JSON.stringify(rows)).not.toContain(secret);
      expect((await owner('PUT', { url: source, branch: 'main', revision: 'stale' })).status).toBe(409);
      const retired = await fetch(target.url + '/runs/repository', {
        method: 'POST', headers: memberHeadersFor(target.memberToken, target.projectId, { 'content-type': 'application/json' }),
        body: JSON.stringify({ runId: 'retired-repository-route' }),
      });
      expect(retired.status).toBe(401);
      expect((await owner('GET')).body.repository).toEqual(saved.body.repository);
      expect(await target.sql(`SELECT ciphertext FROM deployment_secrets WHERE name LIKE ${lit('repository:' + target.projectId + ':%')}`)).toEqual(rows);
      const edited = await owner('PUT', { url: 'https://example.test/new.git', branch: 'main', revision: saved.body.repository.revision });
      expect(edited.status).toBe(200);
      expect(edited.body.repository.credential).toBeNull();
      expect((await owner('DELETE', { revision: edited.body.repository.revision })).status).toBe(200);
      expect((await owner('GET')).body.repository).toBeNull();
    } finally {
      const current = await owner('GET');
      if (current.status === 200 && current.body.repository !== null) {
        expect((await owner('DELETE', { revision: current.body.repository.revision })).status).toBe(200);
      }
    }
  },
};
