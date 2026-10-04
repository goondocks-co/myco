import { RUN_REQUEST_FIELDS, RUN_UPDATE_FIELDS } from '@myco-server-worker/api/run-fields.js';
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
import { runServerTask, recordRunFailure, RUN_RECLAIMED_ERROR } from '@myco/agent/runtime/server-runner.js';
import { ServerClient } from '@myco/member/transport.js';
import type { AgentHarness } from '@myco/agent/harness/types.js';
import { sqliteEnv, turnOnGatedCapabilities } from '../myco-server/helpers/fixtures.js';
import { gitRepositoryFixture } from '../helpers/git-repository.js';
import { embeddingRuntimeContract } from '../myco-server/helpers/embedding-runtime-contract.js';

/** Every active run route accepts the values its dispatch and runtime build. */
test('run-route validators admit real dispatched runtime requests', async () => {
  const exercised = new Map<string, Set<string>>();
  const observe = (path: string, body: Record<string, unknown>) => {
    const fields = exercised.get(path) ?? new Set<string>();
    for (const [key, value] of Object.entries(body)) {
      fields.add(key);
      if (key === 'update' && typeof value === 'object' && value !== null) {
        for (const column of Object.keys(value)) fields.add(`update.${column}`);
      }
    }
    exercised.set(path, fields);
  };
  for (const runtime of ['bun-entry', 'cloudflare'] as const) {
    const f = await embeddingRuntimeContract('custom model, ' + 'm'.repeat(200), runtime, undefined, runtime === 'cloudflare' ? { target: 'cloudflare' } : {});
    try {
      expect((await f.server.env.db.prepare('SELECT status FROM agent_runs').first())?.status).toBe('completed');
      for (const [path, bodies] of f.requests) for (const body of bodies) observe(path, body);
    } finally { await f.close(); }
  }
  const refused = await embeddingRuntimeContract('custom model', 'bun', (path, body) => {
    if (path === '/runs/claim') body.agentId = '';
  });
  try {
    expect((await refused.server.env.db.prepare('SELECT error_code FROM agent_runs').first())?.error_code).toBe('parse');
    for (const [path, bodies] of refused.requests) for (const body of bodies) observe(path, body);
  } finally { await refused.close(); }
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
    const runtimeClient = (token: string) => new ServerClient({ serverUrl: 'https://s', token, projectId: 'proj_1' },
      (async (input, init) => {
        const request = new Request(input, init);
        request.headers.set('cf-connecting-ip', '1.2.3.4');
        const payload = await request.clone().json() as Record<string, unknown>;
        const response = await worker.fetch(request, f.env);
        const answer = await response.clone().json() as { persisted?: boolean };
        expect({ path: new URL(request.url).pathname, persisted: answer.persisted }).toEqual({ path: new URL(request.url).pathname, persisted: true });
        observe(new URL(request.url).pathname, payload);
        return response;
      }) as typeof fetch);
    const client = runtimeClient(token.token);
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
      taskName: prepared.prepared.task, admission: 'canopy', params: { source: prepared.prepared.task }, repositoryGitPath: repo.gitPath, harness })).toMatchObject({ status: 'completed' });
    const reclaim = await issueMemberToken(f.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, now);
    await recordDispatch(f.db, { projectId: 'proj_1' }, { id: 'reclaimed-contract', agentId: 'myco-agent', task: prepared.prepared.task,
      provider: prepared.prepared.providerType, model: prepared.prepared.model, runContext: '{}', dispatchedBy: reclaim.tokenId, startedAt: now });
    expect(await recordRunFailure({ client: runtimeClient(reclaim.token), budget: { connectTimeoutMs: 1000, requestTimeoutMs: 5000 }, runId: 'reclaimed-contract' },
      RUN_RECLAIMED_ERROR, 1, { replaced: true })).toMatchObject({ applied: true });
    expect([...exercised.keys()].sort()).toEqual(ROUTES.filter((route) => route.path.startsWith('/runs/') && !('retired' in route && route.retired)).map((route) => route.path).sort());
    expect(Object.keys(RUN_REQUEST_FIELDS).sort()).toEqual([...exercised.keys()].sort());
    const noRuntimeSends: Record<string, Record<string, string>> = {
      '/runs/claim': { maxAgeSeconds: 'Retired task age floor; both runtimes claim a dispatched run id instead.' },
      '/runs/report': { audit: 'Runtime reports send summary and details; the Deployment builds the audit from accepted artifacts.' },
    };
    for (const [path, table] of Object.entries(RUN_REQUEST_FIELDS)) {
      const declared = [...Object.keys(table), ...(path === '/runs/update' ? Object.keys(RUN_UPDATE_FIELDS).map((field) => `update.${field}`) : [])];
      const sent = exercised.get(path)!;
      const exceptions = noRuntimeSends[path] ?? {};
      for (const [field, reason] of Object.entries(exceptions)) {
        expect({ path, field, declared: declared.includes(field), sent: sent.has(field), reason: reason.length > 0 })
          .toEqual({ path, field, declared: true, sent: false, reason: true });
      }
      expect({ path, unexercised: declared.filter((field) => !sent.has(field) && !exceptions[field]) }).toEqual({ path, unexercised: [] });
    }
  } finally { f.sqlite.close(); await repo.dispose(); }
}, 30_000);
