/**
 * The in-process embedding channel: four `/runs/*` routes a run credential reaches only for a run the Deployment runs
 * itself. A worker's run credential is refused on each, the routes the container harness used answer as no route at
 * all, and the embedding run's own credential still claims its run.
 */
import { describe, expect, it } from 'bun:test';
import worker from '@myco-server-worker/index.js';
import { serverEnvFromBindings } from '@myco-server-worker/platform/cloudflare/env.js';
import { claimNextRun, dispatchTask, HARNESS_MEMBER_ID, RUNTIME_SERVED_TASKS } from '@myco-server-worker/core/harness.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { IN_PROCESS_SCOPE } from '@myco-server-worker/pipeline.js';
import { RETIRED_ROUTES, ROUTES } from '@myco-server-worker/routes.js';
import { jsonBody } from '../helpers/json-body.js';
import { memberPost, sqliteEnv, turnOnGatedCapabilities, withHarness } from './helpers/fixtures.js';

const NOW = Date.now();
/** The four routes the in-process embedding runner speaks, named here rather than read from the table they gate. */
const IN_PROCESS_CHANNEL = ['/runs/claim', '/runs/embedding-step', '/runs/report', '/runs/update'];
/** The run routes only the container harness called, each now answered as no route at all. */
const HARNESS_ONLY = ['/runs/get', '/runs/failed', '/runs/resume-admission', '/runs/supersede', '/runs/reports', '/runs/events', '/runs/repository', '/runs/canopy-map',
  '/runs/cortex-instructions', '/runs/instruction', '/runs/digest', '/runs/digest-write'];

function fixture() {
  const e = sqliteEnv();
  turnOnGatedCapabilities(e.sqlite);
  e.sqlite.run(`INSERT OR IGNORE INTO agents (id, name, source, enabled, created_at) VALUES ('myco-agent', 'a', 'built-in', 1, ?)`, [NOW]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES (?, 'harness runtime', ?, 'member')`, [HARNESS_MEMBER_ID, NOW]);
  return e;
}

/** A worker's claim of one queued extraction: the run credential the claim answers. */
async function workerRunToken(e: ReturnType<typeof fixture>): Promise<{ token: string; runId: string }> {
  e.sqlite.run(`INSERT INTO agent_runs (project_id, id, agent_id, task, status, queued_at, held_by, dispatch_spec, run_context, instruction)
    VALUES ('proj_1', 'run_worker', 'myco-agent', 'extract-curate', 'queued', ?, 'worker', ?, ?, 'do the thing')`,
  [NOW, JSON.stringify({ serverUrl: 'https://s', actor: 'deployment', timeoutSeconds: 300 }), JSON.stringify({ timeoutSeconds: 300 })]);
  e.sqlite.run(`INSERT OR IGNORE INTO members (id, label, created_at, role) VALUES ('mem_w', 'a worker', ?, 'admin')`, [NOW]);
  const workerToken = (await issueMemberToken(e.db, { memberId: 'mem_w', machineId: 'mem_w' }, NOW)).tokenId;
  const claimed = await claimNextRun(e.serverEnv, { tokenId: workerToken, machineId: 'm1', harnesses: [{ id: 'claude-code', authenticated: true }], now: NOW });
  if (!claimed.claimed) throw new Error(`no claim: ${claimed.reason}`);
  return { token: claimed.run.runToken, runId: claimed.run.id };
}

describe('the in-process embedding channel', () => {
  it('is exactly four run routes, and every route the container harness used is retired', () => {
    expect(RUNTIME_SERVED_TASKS).toEqual(['embedding-reconcile']);
    const channel = ROUTES.filter((r) => 'legacyRunRoute' in r && r.legacyRunRoute === true).map((r) => r.path).sort();
    expect(channel).toEqual([...IN_PROCESS_CHANNEL].sort());
    const routed = new Set(ROUTES.map((r) => r.path));
    expect(HARNESS_ONLY.filter((path) => routed.has(path))).toEqual([]);
    const retired = new Set(RETIRED_ROUTES.map((r) => r.path));
    expect(HARNESS_ONLY.filter((path) => !retired.has(path))).toEqual([]);
  });

  it('refuses a worker run\'s credential on each of the four, and answers it on a retired route as on no route at all', async () => {
    const e = fixture();
    const { token, runId } = await workerRunToken(e);
    for (const path of IN_PROCESS_CHANNEL) {
      const answered = await worker.fetch(memberPost(token, { id: runId, runId, agentId: 'myco-agent', task: 'extract-curate' }, path), e.env as never);
      expect({ path, body: await jsonBody(answered) }).toEqual({ path, body: { persisted: false, code: 'run_scope', reason: IN_PROCESS_SCOPE } });
    }
    const absent = await worker.fetch(memberPost(token, { runId }, '/runs/no-such-route'), e.env as never);
    const absentAnswer = { status: absent.status, body: await absent.text() };
    for (const path of HARNESS_ONLY) {
      const answered = await worker.fetch(memberPost(token, { runId }, path), e.env as never);
      expect({ path, status: answered.status, body: await answered.text() }).toEqual({ path, ...absentAnswer });
    }
  });

  it('admits the embedding run\'s own credential, which claims its run', async () => {
    const e = fixture();
    const bindings = { ...e.env, AI: {}, VECTORIZE: {} };
    const launches: Array<{ runId: string; envVars: Record<string, string> }> = [];
    const dispatched = await dispatchTask(withHarness(() => serverEnvFromBindings(bindings as never), { launch: async (spec) => { launches.push(spec); } }),
      'embedding-reconcile', 'proj_1', { serverUrl: 'https://s', actor: 'mem_owner', timeoutSeconds: 120 }, NOW);
    expect(dispatched.dispatched).toBe(true);
    const spec = launches[0]!;
    const claim = await worker.fetch(memberPost(spec.envVars.MYCO_MEMBER_TOKEN!, { id: spec.runId, agentId: 'myco-agent', task: 'embedding-reconcile', captureDriven: true }, '/runs/claim'), bindings as never);
    expect(await jsonBody(claim)).toEqual({ persisted: true, claimed: true, runId: spec.runId });
  });
});
