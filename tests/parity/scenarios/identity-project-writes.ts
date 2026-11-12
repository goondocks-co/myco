import { expect } from 'bun:test';
import { lit, type ParityScenario } from '../harness.ts';
import { owner } from '../clients/requests.ts';

/**
 * A replaced repository credential retires the secret it replaced, on both stores. Project capacity admission and the
 * replacement's rollback when retirement fails are covered by `identity-project-atomic.test.ts`.
 */
export const identityProjectWrites: ParityScenario = {
  name: 'identity and Project writes: a replaced repository credential retires its old secret',
  dedicated: { timeoutMs: 240_000 },
  async run(target) {
    const path = `/api/projects/${target.projectId}/repository`;
    const payload = { url: 'https://github.com/example/parity.git', branch: 'main', credential: { username: 'reader', token: 'fixture-old-token' } };
    const first = await owner(target, path, { method: 'PUT', body: JSON.stringify({ ...payload, revision: null }) });
    expect(first.status).toBe(200);
    // The secret slot a repository holds its credential under, which no read names.
    const slot = async () => String((await target.sql(`SELECT secret_slot FROM project_repositories WHERE project_id=${lit(target.projectId)}`))[0]?.secret_slot);
    const old = await slot();
    const replaced = await owner(target, path, { method: 'PUT', body: JSON.stringify({ ...payload, revision: first.body.repository.revision, credential: { ...payload.credential, token: 'fixture-new-token' } }) });
    expect(replaced.status).toBe(200);
    expect(await slot()).not.toBe(old);
    // The replaced secret is deleted from the store itself.
    expect(await target.sql(`SELECT name FROM deployment_secrets WHERE name=${lit(old)}`)).toEqual([]);
  },
};
