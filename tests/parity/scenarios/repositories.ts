import { expect } from 'bun:test';
import { memberHeadersFor, type ParityScenario } from '../harness.ts';
import { putCapability } from '../clients/requests.ts';
import { repository } from '../clients/runs.ts';
import { PARITY_OPERATOR, PARITY_STRANGER } from '../github-fixture.ts';

/**
 * A Project's repository connection on both targets, through the controlled GitHub: the notices that ask for one, an
 * installation by an account this server never approved refused at choice and save, the operator's account approved
 * and its repository connected through the real routes, and the retired run route.
 */
export const repositories: ParityScenario = {
  name: 'repositories: approve and connect through the App, a stranger refused, notices and retired run route',
  async run(target) {
    const endpoint = `/api/projects/${target.projectId}/repository`;
    const owner = async (method: string, body?: unknown, path = endpoint) => {
      const result = await fetch(target.url + path, { method, headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
      return { status: result.status, body: await result.json() as any };
    };
    const dispatch = async (task: string, projectId = target.projectId) => {
      const response = await fetch(target.url + '/api/harness/dispatch', { method: 'POST', headers: { ...target.ownerHeaders(), origin: target.url, 'content-type': 'application/json' }, body: JSON.stringify({ task, projectId }) });
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
      return (await response.json() as { repositoriesNeeded: Array<{ projectId: string }> }).repositoriesNeeded.filter(item => item.projectId === target.projectId);
    };
    for (const capability of ['canopy', 'vault_evolution']) expect((await putCapability(target, capability, false)).status).toBe(200);
    expect(await needed()).toEqual([]);
    expect((await putCapability(target, 'canopy', true)).status).toBe(200);
    expect(await needed()).toEqual([{ kind: 'repository_missing', tone: 'warn', projectId: target.projectId }]);
    expect(await setupNeeded()).toEqual([{ projectId: target.projectId }]);
    expect(await owner('GET')).toEqual({ status: 200, body: { repository: null, appConfigured: true } });
    try {
      // The token-era body is refused by name.
      expect(await owner('PUT', { url: 'https://github.com/example/source', branch: 'main', revision: null }))
        .toMatchObject({ status: 400, body: { reason: expect.stringContaining('`url` is no longer accepted') } });
      const listed = await owner('GET', undefined, '/api/github-app/installations');
      expect(listed.body.installations.find((entry: { installationId: number }) => entry.installationId === PARITY_STRANGER.installationId)).toMatchObject({ approved: false });
      expect((await owner('GET', undefined, `/api/github-app/installations/${PARITY_STRANGER.installationId}/repositories`)).body).toMatchObject({ failure: 'account_not_approved' });
      expect(await owner('PUT', { installationId: PARITY_STRANGER.installationId, repositoryId: 1296269, branch: 'main', revision: null }))
        .toMatchObject({ status: 409, body: { failure: 'account_not_approved' } });
      expect((await owner('GET')).body.repository).toBeNull();
      const connected = await repository(target, 'example/source');
      expect(connected).toMatchObject({ url: 'https://github.com/example/source', branch: 'main', repositoryId: 1296269, installationId: PARITY_OPERATOR.installationId });
      expect((await owner('GET')).body).toEqual({ repository: connected, appConfigured: true });
      expect(await needed()).toEqual([]);
      expect(await setupNeeded()).toEqual([]);
      const retired = await fetch(target.url + '/runs/repository', {
        method: 'POST', headers: memberHeadersFor(target.memberToken, target.projectId, { 'content-type': 'application/json' }),
        body: JSON.stringify({ runId: 'retired-repository-route' }),
      });
      expect(retired.status).toBe(401);
      expect((await owner('DELETE', { revision: 'stale' })).status).toBe(409);
      expect((await owner('DELETE', { revision: connected.revision })).status).toBe(200);
      expect(await needed()).toHaveLength(1);
    } finally {
      const current = await owner('GET');
      if (current.status === 200 && current.body.repository !== null) {
        expect((await owner('DELETE', { revision: current.body.repository.revision })).status).toBe(200);
      }
      for (const capability of ['canopy', 'vault_evolution']) expect((await putCapability(target, capability, false)).status).toBe(200);
    }
  },
};
