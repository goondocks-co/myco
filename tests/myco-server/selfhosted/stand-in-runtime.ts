/**
 * A runtime that does everything but call a model.
 *
 * The supervisor spawns this as a child exactly as it spawns the shipped
 * runtime bundle: the dispatch arrives in the environment, and everything this
 * process reaches, it reaches over the run-control routes with the credential
 * that dispatch minted. It claims its run, writes one report, closes the run
 * completed, and leaves.
 *
 * It records its own environment first, so the test can hold what the dispatch
 * and the supervisor give it — and what they do not.
 */
import { ServerClient } from '@myco/member/transport.js';
import { createHttpRunStore, postRunReport } from '@myco/agent/runtime/run-store-http.js';
import { CAPTURE_DRIVEN_ADMISSION, HARNESS_AGENT_ID } from '@myco-server-worker/core/harness.js';

const env = (name: string): string | undefined => {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
};

const out = env('STANDIN_ENV_OUT');
if (out !== undefined) await Bun.write(out, JSON.stringify({ ...process.env }));

const serverUrl = env('MYCO_SERVER_URL');
const token = env('MYCO_MEMBER_TOKEN');
const projectId = env('MYCO_PROJECT');
const runId = env('MYCO_RUN_ID');
const taskName = env('MYCO_TASK');
if (!serverUrl || !token || !projectId || !runId || !taskName) {
  console.error(`stand-in runtime: the dispatch named no ${!serverUrl ? 'server' : !token ? 'credential' : !projectId ? 'project' : !runId ? 'run' : 'task'}`);
  process.exit(2);
}

const admission = env('MYCO_TASK_ADMISSION');
const budget = { connectTimeoutMs: 10_000, requestTimeoutMs: 30_000 };
const client = new ServerClient({ serverUrl, token, projectId });
const store = createHttpRunStore({
  client,
  agentId: HARNESS_AGENT_ID,
  admissionForTask: () => (admission === CAPTURE_DRIVEN_ADMISSION ? { captureDriven: true } : { capability: admission ?? 'cortex' }),
  budget,
});

const claim = await store.claimRun(
  {
    id: runId,
    agent_id: HARNESS_AGENT_ID,
    task: taskName,
    status: 'running',
    harness: 'stand-in',
    provider: env('MYCO_PROVIDER') ?? null,
    model: env('MYCO_MODEL') ?? null,
    run_context: null,
  },
  { taskName, maxAgeSeconds: 0 },
);
if (claim.claimed !== true) {
  console.error(`stand-in runtime: the claim on ${runId} was refused`);
  process.exit(3);
}

await postRunReport(client, budget, {
  runId,
  agentId: HARNESS_AGENT_ID,
  action: 'stand-in',
  summary: env('STANDIN_SUMMARY') ?? 'the runtime ran',
});

const closed = await store.updateRunStatus(runId, 'completed', { completed_at: Date.now(), tokens_used: null } as never);
if (closed.applied !== true) {
  console.error(`stand-in runtime: the deployment refused to close ${runId}: ${closed.reason ?? ''}`);
  process.exit(4);
}
process.exit(0);
