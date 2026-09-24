/**
 * The repository map as a worker run outcome, from the dispatch to the row it
 * owed and the read an agent makes of it.
 *
 * A map run is dispatched, claimed by a worker with the checkout capability,
 * pinned to a commit through the worker's repository step — which pins the
 * run's map input with it — and writes its map over the run's own credential.
 * The Deployment then judges the close: a map this run wrote against the input
 * it pinned, or a pass over an input the current map already reflects.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { MAP_ACTION, MAP_TASK, MAP_UNCHANGED_ACTION, type MapArtifact } from '@goondocks/myco-shared/canopy';
import { REPOSITORY_CHECKOUT_CAPABILITY, RUN_REPOSITORY_DIGESTS_FILE } from '@goondocks/myco-shared/repository';
import worker from '@myco-server-worker/entry/cloudflare.js';
import { ensureMember } from '@myco-server-worker/auth/enrollment.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { capturedSinceMap, mapInputHash, readMapSettings } from '@myco-server-worker/core/canopy.js';
import { MAP_RULES } from '@myco-server-worker/core/canopy-input.js';
import { claimNextRun, dispatchTask, endLeasedRun, prepareDispatch } from '@myco-server-worker/core/harness.js';
import { projectRepositories } from '@myco-server-worker/core/repositories.js';
import { RUN_CLOSE_ARTIFACT_ERROR } from '@myco-server-worker/core/run-postconditions.js';
import { mapSourcePinOfRun, getRun } from '@myco-server-worker/core/runs.js';
import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { prepareWorkerRepository } from '@myco-server-worker/core/worker-repository.js';
import { MAP_SOURCE_UNPINNED } from '@myco-server-worker/mcp/tools/run-map.js';
import { NO_MAP_MESSAGE } from '@myco-server-worker/mcp/tools/cortex.js';
import { PROJECT_HEADER } from '@myco-server-worker/constants.js';
import { memberHeaders, sqliteEnv } from './helpers/fixtures.js';

const ORIGIN = 'https://s';
const SOURCE = { url: 'https://example.test/team/source', branch: 'main' };
const OFFERED = [{ id: 'claude-code', authenticated: true }];
const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);
const scope = { projectId: 'proj_1' };
const cleanups: Array<() => void> = [];
afterEach(() => { for (const close of cleanups.splice(0)) close(); });

const grounding = (path: string) => ({ path, sha256: 'c'.repeat(64) });
const ARTIFACT: MapArtifact = {
  directories: [{ path: 'src', annotation: 'The application source.', groundedIn: [grounding('src/main.ts')] }],
  domains: [{ id: 'startup', title: 'Startup', files: [{ path: 'src/main.ts', annotation: 'Starts the application.', groundedIn: [grounding('src/main.ts')] }] }],
};

async function rig() {
  const e = sqliteEnv();
  cleanups.push(() => e.sqlite.close());
  e.env.SECRET_WRAP_KEY = { get: async () => btoa('r'.repeat(32)) };
  let now = 1_800_000_000_000;
  const clock = () => now;
  await ensureMember(e.db, 'mem_worker', now, 'admin', 'worker');
  const workerCredential = await issueMemberToken(e.db, { memberId: 'mem_worker', machineId: 'm1' }, now);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id,name,source,enabled,created_at) VALUES ('myco-agent','myco-agent','built-in',1,?)`, [now]);
  e.sqlite.run(`INSERT OR IGNORE INTO projects (project_id, name, created_at) VALUES ('proj_1', 'proj_1', ?)`, [now]);
  e.sqlite.run(`INSERT OR IGNORE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES ('proj_1', 'canopy', 1, ?, 'test')`, [now]);
  const repositories = projectRepositories(e.db, deploymentSecretStore(e.db, e.serverEnv.wrappingKey));

  /** One tool call over a credential, as a harness child or a member makes it. */
  const call = async (token: string, name: string, input: Record<string, unknown>) => {
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST',
      headers: memberHeaders(token, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: input } }),
    }), e.env);
    const body = await res.json() as { result?: { content?: Array<{ text?: string }> }; error?: { message?: string } };
    if (body.error !== undefined) return { failed: body.error.message } as Record<string, unknown>;
    return JSON.parse(body.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
  };
  /** Dispatch a map run and have the worker claim it. */
  const claimMap = async () => {
    now += 10;
    expect(await dispatchTask(e.serverEnv, MAP_TASK, 'proj_1', { serverUrl: ORIGIN, actor: 'mem_worker' }, now))
      .toMatchObject({ dispatched: true, queued: true });
    const claimed = await claimNextRun(e.serverEnv, { tokenId: workerCredential.tokenId, machineId: 'm1', harnesses: OFFERED, capabilities: [REPOSITORY_CHECKOUT_CAPABILITY], now: now + 1 });
    if (!claimed.claimed) throw new Error(`the map run was not claimed: ${claimed.reason}`);
    return claimed.run;
  };
  /** The worker's repository step, pinning the checkout to a commit. */
  const pinCommit = (runId: string, commit: string) =>
    prepareWorkerRepository(e.serverEnv, { tokenId: workerCredential.tokenId, clock }, { projectId: 'proj_1', runId, body: { ...SOURCE, commit } });
  const end = (runId: string) => endLeasedRun(e.serverEnv, { tokenId: workerCredential.tokenId, now: clock() }, { projectId: 'proj_1', runId, status: 'completed' });
  return { e, repositories, workerCredential, call, claimMap, pinCommit, end, advance: (ms: number) => { now += ms; }, clock };
}

describe('a map run a worker claimed', () => {
  it('is refused before any row exists while the Project has no repository, and queued for a worker once it has one', async () => {
    const r = await rig();
    expect(await prepareDispatch(r.e.serverEnv, MAP_TASK, 'proj_1')).toEqual({ ok: false, refusal: 'repository_missing' });
    await r.repositories.save('proj_1', { ...SOURCE, revision: null }, 'mem_worker', r.clock());
    expect(await prepareDispatch(r.e.serverEnv, MAP_TASK, 'proj_1')).toMatchObject({ ok: true, prepared: { servedBy: 'worker' } });
  });

  it('carries a Deployment-built prompt and a checkout, and pins its map input with its commit', async () => {
    const r = await rig();
    await r.repositories.save('proj_1', { ...SOURCE, revision: null }, 'mem_worker', r.clock());
    const run = await r.claimMap();
    expect(run.task).toBe(MAP_TASK);
    expect(run.repository).toMatchObject(SOURCE);
    expect(run.instructions).toBe(MAP_RULES);
    for (const named of [SOURCE.url, RUN_REPOSITORY_DIGESTS_FILE, '`myco_run_map` op "get"', '`myco_run_map` op "write"', `"${MAP_UNCHANGED_ACTION}"`, `"${MAP_ACTION}"`]) {
      expect({ named, present: run.instruction?.includes(named) }).toEqual({ named, present: true });
    }

    // Before the checkout is pinned the run holds no input to read or write against.
    expect(await r.call(run.runToken, 'myco_run_map', { op: 'get' })).toEqual({ ok: false, error: MAP_SOURCE_UNPINNED });

    expect(await r.pinCommit(run.id, COMMIT_A)).toMatchObject({ held: true, pin: { ...SOURCE, commit: COMMIT_A } });
    const pinned = mapSourcePinOfRun((await getRun(r.e.db, scope, run.id))!);
    expect(pinned).toEqual({ inputHash: await mapInputHash(await readMapSettings(r.e.db), { ...SOURCE, commit: COMMIT_A }), priorRevision: null });
  });

  it('writes its map, closes completed on it, and is read back over myco_cortex', async () => {
    const r = await rig();
    await r.repositories.save('proj_1', { ...SOURCE, revision: null }, 'mem_worker', r.clock());
    const member = await issueMemberToken(r.e.db, { memberId: 'mem_worker', machineId: 'm1' }, r.clock());
    expect(await r.call(member.token, 'myco_cortex', { op: 'canopy_map' })).toEqual({ content: '', project_id: 'proj_1', is_empty: true, message: NO_MAP_MESSAGE });

    const run = await r.claimMap();
    await r.pinCommit(run.id, COMMIT_A);
    expect(await r.call(run.runToken, 'myco_run_map', { op: 'get' })).toMatchObject({ commit: COMMIT_A, unchanged: false, map: null });
    expect(await r.call(run.runToken, 'myco_run_map', { op: 'write', artifact: { directories: [], domains: [] } }))
      .toEqual({ ok: false, error: 'Map list is empty or exceeds its limit.' });
    expect(await r.call(run.runToken, 'myco_run_map', { op: 'write', artifact: JSON.stringify(ARTIFACT) })).toMatchObject({ written: true, commit: COMMIT_A });
    expect(await r.call(run.runToken, 'myco_run_map', { op: 'write', artifact: { ...ARTIFACT, domains: [{ ...ARTIFACT.domains[0]!, title: 'Other' }] } }))
      .toEqual({ ok: false, error: 'this run already stored its map; a run writes one map' });
    await r.call(run.runToken, 'myco_run', { op: 'report', action: MAP_ACTION, summary: 'mapped' });
    expect(await r.end(run.id)).toEqual({ ended: true, status: 'completed' });
    expect(r.e.sqlite.query(`SELECT source_run_id AS runId, repository_commit AS commitId FROM canopy_maps WHERE project_id = 'proj_1'`).get())
      .toEqual({ runId: run.id, commitId: COMMIT_A });

    const read = await r.call(member.token, 'myco_cortex', { op: 'canopy_map' });
    expect(read).toMatchObject({ project_id: 'proj_1', repository: { ...SOURCE, commit: COMMIT_A } });
    expect(read.content).toContain('## Directory skeleton');
    expect(read.content).toContain('Starts the application');
    expect(await r.call(member.token, 'myco_cortex', { op: 'canopy_entry', path: 'src/main.ts' })).toEqual({ failed: "myco_cortex op 'canopy_entry' is not offered by a Deployment" });
  });

  it('closes a second pass over the same commit as unchanged, and holds an unchanged claim over a new commit to the map it owed', async () => {
    const r = await rig();
    await r.repositories.save('proj_1', { ...SOURCE, revision: null }, 'mem_worker', r.clock());
    const first = await r.claimMap();
    await r.pinCommit(first.id, COMMIT_A);
    await r.call(first.runToken, 'myco_run_map', { op: 'write', artifact: ARTIFACT });
    await r.call(first.runToken, 'myco_run', { op: 'report', action: MAP_ACTION, summary: 'mapped' });
    expect(await r.end(first.id)).toEqual({ ended: true, status: 'completed' });

    const second = await r.claimMap();
    await r.pinCommit(second.id, COMMIT_A);
    expect(await r.call(second.runToken, 'myco_run_map', { op: 'get' })).toMatchObject({ commit: COMMIT_A, unchanged: true, map: { commit: COMMIT_A, artifact: ARTIFACT } });
    await r.call(second.runToken, 'myco_run', { op: 'report', action: MAP_UNCHANGED_ACTION, summary: 'nothing moved' });
    expect(await r.end(second.id)).toEqual({ ended: true, status: 'completed' });

    const third = await r.claimMap();
    await r.pinCommit(third.id, COMMIT_B);
    expect(await r.call(third.runToken, 'myco_run_map', { op: 'get' })).toMatchObject({ commit: COMMIT_B, unchanged: false });
    await r.call(third.runToken, 'myco_run', { op: 'report', action: MAP_UNCHANGED_ACTION, summary: 'nothing moved' });
    expect(await r.end(third.id)).toEqual({ ended: true, status: 'failed' });
    expect(r.e.sqlite.query(`SELECT error FROM agent_runs WHERE id = ?`).get(third.id)).toEqual({ error: RUN_CLOSE_ARTIFACT_ERROR });
  });

  it('is listed its map tool only on a map run, and loses the write on a dry run', async () => {
    const r = await rig();
    await r.repositories.save('proj_1', { ...SOURCE, revision: null }, 'mem_worker', r.clock());
    const run = await r.claimMap();
    const res = await worker.fetch(new Request(`${ORIGIN}/mcp`, {
      method: 'POST', headers: memberHeaders(run.runToken, { [PROJECT_HEADER]: 'proj_1' }),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    }), r.e.env);
    const tools = ((await res.json()) as { result: { tools: Array<{ name: string; inputSchema: { properties: { op?: { enum?: string[] } } } }> } }).result.tools;
    expect(tools.map((t) => t.name).sort()).toEqual(['myco_run', 'myco_run_map']);
    expect(tools.find((t) => t.name === 'myco_run_map')!.inputSchema.properties.op!.enum).toEqual(['get', 'write']);
  });
});

describe('when the clock maps a Project', () => {
  it('waits for work captured after the current map', async () => {
    const r = await rig();
    expect(await capturedSinceMap(r.e.db, scope)).toBe(false);
    r.e.sqlite.run(`INSERT INTO sessions (project_id, session_id, machine_id, created_by_token_id, first_received_at, last_received_at) VALUES ('proj_1', 's1', 'm1', 'tok_1', 100, 200)`);
    expect(await capturedSinceMap(r.e.db, scope)).toBe(true);
    r.e.sqlite.run(`INSERT INTO canopy_maps (project_id, revision, artifact, input_hash, repository_url, repository_branch, repository_commit, source_run_id, generated_at)
      VALUES ('proj_1', 'rev_1', ?, ?, ?, 'main', ?, 'run_x', 300)`, [JSON.stringify(ARTIFACT), 'd'.repeat(64), SOURCE.url, COMMIT_A]);
    expect(await capturedSinceMap(r.e.db, scope)).toBe(false);
    r.e.sqlite.run(`UPDATE sessions SET last_received_at = 400 WHERE session_id = 's1'`);
    expect(await capturedSinceMap(r.e.db, scope)).toBe(true);
  });
});
