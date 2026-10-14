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
    const dispatch = async (task: string, projectId = target.projectId) => {
      const response = await fetch(target.url + '/api/harness/dispatch', {
        method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' },
        body: JSON.stringify({ task, projectId }),
      });
      return { status: response.status, body: await response.json() };
    };
    for (const [task, projectId, error, message] of [
      ['canopy-map', target.projectId, 'repository_missing', 'Connect the project repository in Settings before running a code task.'],
      ['no-such-task', target.projectId, 'unknown_task', 'this server cannot run that task'],
      ['canopy-map', 'proj_absent_refusal', 'unknown_project', 'the project is not on this server'],
    ]) expect(await dispatch(task!, projectId!)).toEqual({ status: 400, body: { error, message } });
    const needed = async () => {
      const response = await fetch(target.url + '/api/attention', { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      const body = await response.json() as { items: Array<{ kind: string; tone: string; projectId?: string }>; unavailable: string[] };
      expect(body.unavailable).not.toContain('repository_missing');
      return body.items.filter(item => item.kind === 'repository_missing' && item.projectId === target.projectId);
    };
    const setupNeeded = async () => {
      const response = await fetch(target.url + '/api/setup', { headers: target.ownerHeaders() });
      expect(response.status).toBe(200);
      return (await response.json() as { repositoriesNeeded: Array<{ projectId: string }> }).repositoriesNeeded
        .filter(item => item.projectId === target.projectId);
    };
    await target.sql(`DELETE FROM project_capabilities WHERE project_id=${lit(target.projectId)} AND capability IN ('canopy','vault_evolution')`);
    expect(await needed()).toEqual([]);
    expect(await setupNeeded()).toEqual([]);
    await target.sql(`INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by)
      VALUES (${lit(target.projectId)},'vault_evolution',1,${Date.now()},${lit(MEMBER_ID)})`);
    expect(await needed()).toEqual([]);
    expect(await setupNeeded()).toEqual([]);
    await target.sql(`INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by)
      VALUES (${lit(target.projectId)},'canopy',1,${Date.now()},${lit(MEMBER_ID)})`);
    expect(await needed()).toEqual([{ kind: 'repository_missing', tone: 'warn', projectId: target.projectId }]);
    expect(await setupNeeded()).toEqual([{ projectId: target.projectId }]);
    const prior = await owner('GET');
    expect(prior.status).toBe(200);
    expect(prior.body.repository).toBeNull();
    try {
      const saved = await owner('PUT', { url: source, branch: 'main', revision: null, credential: { username: 'reader', token: secret } });
      expect(saved.status).toBe(200);
      expect(await needed()).toEqual([]);
      expect(await setupNeeded()).toEqual([]);
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
      expect(await needed()).toHaveLength(1);
      await target.sql(`INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by)
        VALUES (${lit(target.projectId)},'canopy',0,1,'fixture'),(${lit(target.projectId)},'vault_evolution',0,1,'fixture')
        ON CONFLICT(project_id,capability) DO UPDATE SET enabled=0`);
      expect(await needed()).toEqual([]);
      expect(await setupNeeded()).toEqual([]);
      await target.sql(`DELETE FROM project_capabilities WHERE project_id=${lit(target.projectId)} AND capability IN ('canopy','vault_evolution')`);
    } finally {
      const current = await owner('GET');
      if (current.status === 200 && current.body.repository !== null) {
        expect((await owner('DELETE', { revision: current.body.repository.revision })).status).toBe(200);
      }
    }
  },
};
