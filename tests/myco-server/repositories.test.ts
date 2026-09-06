import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { projectRepositories, RepositoryConflictError } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { handleRunRepository } from '@myco-server-worker/api/repositories.js';
import type { RouteContext } from '@myco-server-worker/context.js';
import { sqliteEnv } from './helpers/fixtures.js';
import { seedCredential } from './helpers/d1.js';
import { asOwner, asOwnerPost, OWNER_ENV } from './helpers/owner.js';

const URL = 'https://github.com/example/project.git';
const TOKEN = 'fixture-read-token-with-no-real-permissions';
const SHA = 'a'.repeat(40);

function rig() {
  const r = sqliteEnv();
  r.env.SECRET_WRAP_KEY = { get: async () => btoa('a'.repeat(32)) };
  const store = deploymentSecretStore(r.db, r.serverEnv.wrappingKey);
  return { ...r, serverEnv: r.serverEnv, store, repositories: projectRepositories(r.db, store) };
}

const input = { url: URL, branch: 'main', revision: null, credential: { username: 'reader', token: TOKEN } };

function run(r: ReturnType<typeof rig>) {
  const now = Date.now();
  const tokenId = seedCredential(r.sqlite, { memberId: HARNESS_MEMBER_ID, machineId: 'harness', issuedAt: now, expiresAt: now + 60_000 });
  r.sqlite.query("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco','Myco','built-in',1,?)").run(now);
  r.sqlite.query("INSERT INTO agent_runs (project_id,id,agent_id,status,task,started_at,dispatched_by,run_context) VALUES ('proj_1','run_1','myco','running','skill-generate',?,?,?)")
    .run(now, tokenId, JSON.stringify({ input_hash: 'keep', timeoutSeconds: 300 }));
  return { projectId: 'proj_1', memberId: HARNESS_MEMBER_ID, tokenId, now, body: JSON.stringify({ runId: 'run_1' }) } as RouteContext;
}

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

describe('held run repository access', () => {
  it('opens credentials only for the dispatched live code run', async () => {
    const r = rig();
    await r.repositories.save('proj_1', input, 'mem_machine_1', 1);
    const ctx = run(r);
    const answer = await handleRunRepository(r.serverEnv, ctx);
    expect(answer.headers.get('cache-control')).toBe('no-store');
    expect((await answer.json() as any).repository.credential.token).toBe(TOKEN);
    for (const changed of [{ memberId: 'mem_machine_1' }, { tokenId: 'another' }, { projectId: 'proj_2' }, { now: ctx.now + 3_600_000 }]) {
      const denied = await handleRunRepository(r.serverEnv, { ...ctx, ...changed });
      expect(await denied.json()).toEqual({ persisted: true, held: false });
    }
    r.sqlite.query("UPDATE agent_runs SET task = 'title-summary'").run();
    expect(await (await handleRunRepository(r.serverEnv, ctx)).json()).toEqual({ persisted: true, held: false });
  });

  it('pins once, preserves other run context and refuses a changed repository', async () => {
    const r = rig();
    const connection = (await r.repositories.save('proj_1', input, 'mem_machine_1', 1))!;
    const ctx = run(r);
    const pin = async (commit: string) => (await handleRunRepository(r.serverEnv, { ...ctx, body: JSON.stringify({ runId: 'run_1', url: URL, branch: 'main', commit }) })).json() as Promise<any>;
    expect((await pin(SHA)).pin.commit).toBe(SHA);
    expect((await pin('b'.repeat(40))).pin.commit).toBe(SHA);
    const { run_context } = r.sqlite.query('SELECT run_context FROM agent_runs').get() as { run_context: string };
    expect(JSON.parse(run_context).input_hash).toBe('keep');
    expect((await (await handleRunRepository(r.serverEnv, ctx)).json() as any).repository.commit).toBe(SHA);
    await r.repositories.save('proj_1', { url: URL, branch: 'changed', revision: connection.revision }, 'mem_machine_1', 2);
    expect((await (await handleRunRepository(r.serverEnv, ctx)).json() as any).error).toContain('changed');
    r.sqlite.query("UPDATE agent_runs SET status = 'completed'").run();
    expect(await (await handleRunRepository(r.serverEnv, ctx)).json()).toEqual({ persisted: true, held: false });
  });
});
