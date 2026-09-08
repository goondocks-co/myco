import { expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import worker from '@myco-server-worker/index.js';
import { sqliteEnv } from '../myco-server/helpers/fixtures.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { getRun, pinRepositoryForRun, recordDispatch } from '@myco-server-worker/core/runs.js';
import { runCloseRefusal, RUN_CLOSE_ARTIFACT_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { readCanopyMap } from '@myco-server-worker/read/canopy.js';
import { ServerClient } from '@myco/member/transport.js';
import { materializedReportTool } from '@myco/agent/runtime/server-tools.js';
import { materializeRunMap, prepareRunMap } from '@myco/agent/runtime/server-canopy.js';
import { postRunControl, postRunReport } from '@myco/agent/runtime/run-store-http.js';

const repository = { url: 'https://example.test/repo.git', branch: 'main' };
const scope = { projectId: 'proj_1' };
const budget = { connectTimeoutMs: 1000, requestTimeoutMs: 5000 };
const annotation = (path: string, text: string) => ({ path, annotation: text, groundedIn: [path] });

it('publishes grounded maps through held routes, preserves unchanged domains, and verifies a zero-model refresh', async () => {
  const e = sqliteEnv();
  const root = await mkdtemp(join(tmpdir(), 'myco-map-runtime-'));
  try {
    await mkdir(join(root, 'src'));
    await writeFile(join(root, 'AGENTS.md'), 'Use project vocabulary.');
    await writeFile(join(root, 'src/a.ts'), 'export const a = 1;');
    await writeFile(join(root, 'src/b.ts'), 'export const b = 1;');
    await ensureMember(e.db, HARNESS_MEMBER_ID, Date.now(), 'member', 'harness runtime');
    e.sqlite.run("INSERT INTO agents (id,name,source,enabled,created_at) VALUES ('myco','Myco','built-in',1,0)");
    await projectRepositories(e.db, deploymentSecretStore(e.db, e.serverEnv.wrappingKey)).save(scope.projectId, { ...repository, revision: null }, HARNESS_MEMBER_ID, Date.now());
    const run = async (id: string, changedPaths: string[], task = 'canopy-map') => {
      const token = await issueMemberToken(e.db, { memberId: HARNESS_MEMBER_ID, machineId: 'harness' }, Date.now());
      await recordDispatch(e.db, scope, { id, agentId: 'myco', task, provider: 'anthropic', model: null,
        runContext: '{}', dispatchedBy: token.tokenId, startedAt: Date.now() });
      e.sqlite.query("UPDATE agent_runs SET status='running' WHERE id=?").run(id);
      const row = (await getRun(e.db, scope, id))!;
      const commit = id === 'first' ? 'a'.repeat(40) : 'b'.repeat(40);
      await pinRepositoryForRun(e.db, scope, row, { ...repository, commit });
      const client = new ServerClient({ serverUrl: 'https://s', token: token.token, projectId: scope.projectId },
        ((input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          request.headers.set('cf-connecting-ip', '1.2.3.4');
          return worker.fetch(request, e.env);
        }) as typeof fetch);
      const ctx = { client, budget, runId: id, agentId: 'myco' };
      return { ctx, prepare: async () => materializeRunMap(ctx, await prepareRunMap(ctx),
        { root, commit, changedPaths, dispose: async () => {} }, new AbortController().signal, 'map-definition') };
    };
    const first = await run('first', []);
    const prepared = await first.prepare();
    const artifact = { directories: [{ path: 'src', annotation: 'Project code.', groundedIn: ['src/a.ts'] }], domains: [
      { id: 'a', title: 'A', files: [annotation('src/a.ts', 'Exports A.')] },
      { id: 'b', title: 'B', files: [annotation('src/b.ts', 'Exports B.')] },
    ] };
    const report = materializedReportTool({ ...first.ctx, beforeReport: prepared.beforeReport }, { reports: 0 });
    const publish = () => report.handler({ action: 'canopy_map', summary: 'Initial map.', details: { artifact } }, {});
    expect(JSON.stringify(await publish())).toContain('Read the project rules');
    const read = prepared.tools.find((tool) => tool.name === 'fs_read')!;
    for (const path of ['AGENTS.md', 'src/a.ts', 'src/b.ts']) await read.handler({ path }, {});
    expect(JSON.stringify(await publish())).toContain('report recorded');
    const before = (await readCanopyMap(e.db, scope))!;
    expect(before.content).toContain('Map Provenance');
    expect(await runCloseRefusal(e.db, scope, (await getRun(e.db, scope, 'first'))!)).toBeNull();
    expect((await first.prepare()).unchanged).toBe(true);

    await writeFile(join(root, 'src/b.ts'), 'export const b = 2;');
    const next = await run('next', ['src/b.ts']);
    const changed = await next.prepare();
    const nextRead = changed.tools.find((tool) => tool.name === 'fs_read')!;
    for (const path of ['AGENTS.md', 'src/b.ts']) await nextRead.handler({ path }, {});
    const nextArtifact = { ...artifact, domains: [artifact.domains[0], { ...artifact.domains[1], files: [annotation('src/b.ts', 'Exports the updated B.')] }] };
    const nextReport = materializedReportTool({ ...next.ctx, beforeReport: changed.beforeReport }, { reports: 0 });
    expect(JSON.stringify(await nextReport.handler({ action: 'canopy_map', summary: 'Updated B.', details: { artifact: nextArtifact } }, {}))).toContain('report recorded');
    const after = (await readCanopyMap(e.db, scope))!;
    expect(after.artifact.domains[0]).toEqual(before.artifact.domains[0]);
    expect(after.artifact.domains[1].files[0].groundedIn).not.toEqual(before.artifact.domains[1].files[0].groundedIn);

    const same = await run('same', []);
    const unchanged = await same.prepare();
    expect(unchanged.unchanged).toBe(true);
    await unchanged.reportUnchanged();
    expect(await runCloseRefusal(e.db, scope, (await getRun(e.db, scope, 'same'))!)).toBeNull();
    expect((await readCanopyMap(e.db, scope))?.revision).toBe(after.revision);

    const foreignTask = await run('foreign', [], 'container-smoke');
    expect(await postRunControl(foreignTask.ctx.client, budget, '/runs/canopy-map', { runId: 'foreign', op: 'prepare' })).toMatchObject({ held: false });
    expect(await postRunControl(foreignTask.ctx.client, budget, '/runs/canopy-map', { runId: 'same', op: 'write', artifact: nextArtifact })).toMatchObject({ held: false });

    const liar = await run('liar', []);
    await postRunReport(liar.ctx.client, budget, { runId: 'liar', agentId: 'myco', action: 'canopy_map_unchanged', summary: 'Claimed unchanged.', details: null });
    expect(await runCloseRefusal(e.db, scope, (await getRun(e.db, scope, 'liar'))!)).toBe(RUN_CLOSE_ARTIFACT_ERROR);
  } finally { e.sqlite.close(); await rm(root, { recursive: true, force: true }); }
});
