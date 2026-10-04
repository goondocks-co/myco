import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { ROUTES } from '@myco-server-worker/routes.js';
import worker from '@myco-server-worker/index.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { recordDispatch } from '@myco-server-worker/core/runs.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { runServerTask, CAPTURE_DRIVEN_ADMISSION } from '@myco/agent/runtime/server-runner.js';
import { ServerClient } from '@myco/member/transport.js';
import type { AgentHarness } from '@myco/agent/harness/types.js';
import { sqliteEnv, turnOnGatedCapabilities } from '../myco-server/helpers/fixtures.js';
import { gitRepositoryFixture } from '../helpers/git-repository.js';
import { embeddingRuntimeContract } from '../myco-server/helpers/embedding-runtime-contract.js';

/** Every active run route accepts the values its dispatch and runtime build. */
test('run-route validators admit real dispatched runtime requests', async () => {
  const exercised = new Set<string>();
  for (const runtime of ['bun-entry', 'cloudflare'] as const) {
    const f = await embeddingRuntimeContract('custom model, ' + 'm'.repeat(200), runtime, undefined, runtime === 'cloudflare' ? { target: 'cloudflare' } : {});
    try {
      expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('completed');
      for (const path of f.requests.keys()) exercised.add(path);
    } finally { await f.close(); }
  }
  const f = sqliteEnv();
  const repo = await gitRepositoryFixture('public');
  try {
    await mkdir(join(repo.repo, 'src'));
    await writeFile(join(repo.repo, 'src/module.ts'), 'export const value = 1;');
    repo.git('add', '.');
    repo.git('commit', '-qm', 'source');
    const now = Date.now();
    turnOnGatedCapabilities(f.sqlite);
    await ensureMember(f.db, HARNESS_MEMBER_ID, now, 'member', 'harness');
    f.sqlite.run("INSERT OR IGNORE INTO agents(id,name,source,enabled,created_at) VALUES('myco-agent','Myco','built-in',1,0)");
    await projectRepositories(f.db, deploymentSecretStore(f.db, f.serverEnv.wrappingKey)).save('proj_1', { url: repo.url, branch: 'main', revision: null }, HARNESS_MEMBER_ID, now);
    const prepared = await prepareDispatch(f.serverEnv, 'canopy-map', 'proj_1');
    if (!prepared.ok) throw new Error(prepared.refusal);
    const token = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
    const runId = 'runtime-map-contract';
    await recordDispatch(f.db, { projectId: 'proj_1' }, { id: runId, agentId: 'myco-agent', task: prepared.prepared.task,
      provider: prepared.prepared.providerType, model: prepared.prepared.model, runContext: '{}', dispatchedBy: token.tokenId, startedAt: now });
    const client = new ServerClient({ serverUrl: 'https://s', token: token.token, projectId: 'proj_1' },
      (async (input, init) => {
        const request = new Request(input, init);
        request.headers.set('cf-connecting-ip', '1.2.3.4');
        const response = await worker.fetch(request, f.env);
        const answer = await response.clone().json() as { persisted?: boolean };
        expect({ path: new URL(request.url).pathname, persisted: answer.persisted }).toEqual({ path: new URL(request.url).pathname, persisted: true });
        exercised.add(new URL(request.url).pathname);
        return response;
      }) as typeof fetch);
    const harness: AgentHarness = { id: 'claude-code', supports: () => false, execute: async (input) => {
      const tools = input.toolSurface.tools!;
      for (const path of ['AGENTS.md', 'src/module.ts']) await tools.find((tool) => tool.name === 'fs_read')!.handler({ path }, {});
      const answer = await tools.find((tool) => tool.name === 'vault_report')!.handler({ action: 'canopy_map', summary: 'Project rules.', details: {
        artifact: { directories: [{ path: 'src', annotation: 'Project code.', groundedIn: ['src/module.ts'] }], domains: [{ id: 'rules', title: 'Rules', files: [{ path: 'src/module.ts', annotation: 'Exports a value.', groundedIn: ['src/module.ts'] }] }] },
      } }, {});
      expect(JSON.stringify(answer)).toContain('report recorded');
      return { finalText: 'done', turnsUsed: 1, usage: { totalTokens: 42 } };
    } };
    expect(await runServerTask({ client, budget: { connectTimeoutMs: 1000, requestTimeoutMs: 5000 }, runId,
      taskName: prepared.prepared.task, admission: CAPTURE_DRIVEN_ADMISSION, repositoryGitPath: repo.gitPath, harness })).toMatchObject({ status: 'completed' });
    expect([...exercised].sort()).toEqual(ROUTES.filter((route) => route.path.startsWith('/runs/') && !('retired' in route && route.retired)).map((route) => route.path).sort());
  } finally { f.sqlite.close(); await repo.dispose(); }
}, 30_000);
