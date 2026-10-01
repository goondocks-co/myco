import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { projectRepositories, RepositoryConflictError } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const URL = 'https://github.com/example/project.git';
const TOKEN = 'fixture-read-token-with-no-real-permissions';

function rig() {
  const r = sqliteEnv();
  r.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
  const store = deploymentSecretStore(r.db, r.serverEnv.wrappingKey);
  return { ...r, serverEnv: r.serverEnv, store, repositories: projectRepositories(r.db, store) };
}

const input = { url: URL, branch: 'main', revision: null, credential: { username: 'reader', token: TOKEN } };

describe('project repository connection', () => {
  it('seals the token and publishes only metadata and member attribution', async () => {
    const r = rig();
    const saved = await r.repositories.save('proj_1', input, 'mem_machine_1', 1);
    expect(saved).toMatchObject({ url: URL, branch: 'main', updatedBy: 'mem_machine_1', credential: { configured: true, readable: true } });
    expect(JSON.stringify(saved)).not.toContain(TOKEN);
    expect(JSON.stringify(r.sqlite.query('SELECT * FROM project_repositories').all())).not.toContain(TOKEN);
    expect(JSON.stringify(r.sqlite.query('SELECT * FROM deployment_secrets').all())).not.toContain(TOKEN);
    expect((await r.repositories.access('proj_1'))?.credential?.token).toBe(TOKEN);
    expect(await r.repositories.access('proj_2')).toBeNull();
  });

  it('retains credentials for a branch edit, clears them on a URL change and refuses stale writers', async () => {
    const r = rig();
    const first = (await r.repositories.save('proj_1', input, 'mem_machine_1', 1))!;
    const next = (await r.repositories.save('proj_1', { url: URL, branch: 'release', revision: first.revision }, 'mem_machine_1', 2))!;
    expect((await r.repositories.access('proj_1'))?.credential?.token).toBe(TOKEN);
    await expect(r.repositories.save('proj_1', { ...input, revision: first.revision }, 'mem_machine_1', 3)).rejects.toBeInstanceOf(RepositoryConflictError);
    const changed = await r.repositories.save('proj_1', { url: 'https://example.test/other.git', branch: 'main', revision: next.revision }, 'mem_machine_1', 4);
    expect(changed?.credential).toBeNull();
    expect(await r.store.list()).toHaveLength(0);
  });

  it('disconnects only the current revision and removes its read credential', async () => {
    const r = rig();
    const saved = (await r.repositories.save('proj_1', input, 'mem_machine_1', 1))!;
    await expect(r.repositories.remove('proj_1', 'stale', 'mem_machine_1', 2)).rejects.toThrow();
    await r.repositories.remove('proj_1', saved.revision, 'mem_machine_1', 3);
    expect(await r.repositories.describe('proj_1')).toBeNull();
    expect(await r.store.list()).toHaveLength(0);
    await expect(r.repositories.save('proj_1', { ...input, revision: saved.revision }, 'mem_machine_1', 4)).rejects.toThrow();
  });

  it('admits one concurrent credential replacement and retains only its readable secret', async () => {
    const r = rig();
    const first = (await r.repositories.save('proj_1', input, 'mem_machine_1', 1))!;
    const tokens = ['fixture-replacement-one', 'fixture-replacement-two'];
    const outcomes = await Promise.allSettled(tokens.map((token) => r.repositories.save('proj_1', {
      ...input, revision: first.revision, credential: { username: 'reader', token },
    }, 'mem_machine_1', 2)));
    expect(outcomes.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = outcomes.find((result) => result.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(RepositoryConflictError);
    const winner = outcomes.findIndex((result) => result.status === 'fulfilled');
    expect((await r.repositories.access('proj_1'))?.credential?.token).toBe(tokens[winner]);
    expect(await r.store.list()).toHaveLength(1);
  });

  it('serves project Settings through authenticated owner routes', async () => {
    const r = rig();
    const env = { ...r.env, ...OWNER_ENV };
    const path = '/api/projects/proj_1/repository';
    const saved = await worker.fetch(new Request(await asOwnerPost(path, input), { method: 'PUT' }), env);
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain(TOKEN);
    const read = await worker.fetch(await asOwner(path), env);
    expect(read.status).toBe(200);
    const { repository } = await read.json() as any;
    expect(repository.updatedBy).toBe('mem_machine_1');
    expect((await worker.fetch(new Request('https://s' + path, { headers: { 'cf-connecting-ip': '1.2.3.4' } }), env)).status).toBe(401);
    expect((await worker.fetch(await asOwner('/api/projects/missing/repository'), env)).status).toBe(404);
    const removed = await worker.fetch(new Request(await asOwnerPost(path, { revision: repository.revision }), { method: 'DELETE' }), env);
    expect(removed.status).toBe(200);
  });
});
