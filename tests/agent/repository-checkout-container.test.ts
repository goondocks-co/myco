/**
 * The container half of the repository checkout (retire-1.4 P0 split it from `repository-checkout.test.ts`): the 1.4
 * server runner prepares a held run's checkout over HTTP and hands the harness its committed files. It goes with the
 * container launch path (retire-1.4 P7); the worker's checkout is `repository-checkout.test.ts`'s.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { access } from 'node:fs/promises';
import { gitRepositoryFixture, GIT_READ_CREDENTIAL } from '../helpers/git-repository.js';

let fixture: Awaited<ReturnType<typeof gitRepositoryFixture>>;
let gitPath: string;
let second: string;
let url: string;
const token = GIT_READ_CREDENTIAL.token;

beforeAll(async () => {
  fixture = await gitRepositoryFixture();
  ({ gitPath, second, url } = fixture);
}, 20_000);

afterAll(async () => { await fixture?.dispose(); });

describe('code task runner', () => {
  it('prepares through held-run HTTP, exposes committed files and removes the workspace', async () => {
    const { sqliteEnv } = await import('../myco-server/helpers/fixtures.js');
    const { projectRepositories } = await import('@myco-server-worker/core/repositories.js');
    const { deploymentSecretStore } = await import('@myco-server-worker/core/secrets.js');
    const { issueMemberToken } = await import('@myco-server-worker/auth/tokens.js');
    const { ensureMember } = await import('@myco-server-worker/auth/enrollment.js');
    const { recordDispatch } = await import('@myco-server-worker/core/runs.js');
    const { ServerClient } = await import('@myco/member/transport.js');
    const { runServerTask } = await import('@myco/agent/runtime/server-runner.js');
    const worker = (await import('@myco-server-worker/index.js')).default;
    const fixture = sqliteEnv();
    fixture.env.SECRET_WRAP_KEY = { get: async () => btoa('r'.repeat(32)) };
    const now = Date.now();
    await ensureMember(fixture.db, 'mem_harness', now, 'member', 'harness');
    const minted = await issueMemberToken(fixture.db, { memberId: 'mem_harness', machineId: 'machine_1' }, now);
    fixture.sqlite.query("INSERT INTO project_capabilities(project_id,capability,enabled,updated_at,updated_by) VALUES ('proj_1','skills',1,1,'test')").run();
    await projectRepositories(fixture.db, deploymentSecretStore(fixture.db, fixture.serverEnv.wrappingKey)).save('proj_1', {
      url, branch: 'main', revision: null, credential: { username: 'reader', token },
    }, 'mem_machine_1', now);
    await recordDispatch(fixture.db, { projectId: 'proj_1' }, { id: 'code-run', agentId: 'user', task: 'skill-generate', provider: 'anthropic', model: null, runContext: '{}', dispatchedBy: minted.tokenId, startedAt: now });
    const client = new ServerClient({ serverUrl: 'https://s', token: minted.token, projectId: 'proj_1' }, (async (input, init) => {
      const request = new Request(input, init);
      request.headers.set('cf-connecting-ip', '1.2.3.4');
      return worker.fetch(request, fixture.env);
    }) as typeof fetch);
    let workspace = '';
    const result = await runServerTask({
      client, budget: { connectTimeoutMs: 1000, requestTimeoutMs: 5000 }, runId: 'code-run', taskName: 'skill-generate', admission: 'skills', repositoryGitPath: gitPath,
      harness: { id: 'stand-in', execute: async (input) => {
        workspace = input.toolSurface.projectRoot!;
        expect(workspace).toBeTruthy();
        expect(input.prompt).toContain(second);
        expect(input.prompt).not.toContain(token);
        const read = input.toolSurface.tools!.find((tool) => tool.name === 'fs_read')!;
        const rules = await read.handler({ path: 'AGENTS.md' }, {});
        expect(JSON.parse(rules.content[0].text).content).toBe('Second committed rules.');
        await expect(read.handler({ path: '.git/config' }, {})).rejects.toThrow();
        return { finalText: 'inspected', turnsUsed: 1, usage: {} };
      }, supports: () => false } satisfies import('@myco/agent/harness/types.js').AgentHarness,
    });
    expect(result.status).toBe('completed');
    await expect(access(workspace)).rejects.toThrow();
    const stored = fixture.sqlite.query("SELECT run_context FROM agent_runs WHERE id='code-run'").get() as { run_context: string };
    expect(JSON.parse(stored.run_context).repository.commit).toBe(second);
    fixture.sqlite.close();
  });
});
