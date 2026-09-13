import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { HARNESS_AGENT_ID, RuntimeAlreadyHolding, RuntimeDraining } from '@myco-server-worker/core/harness.js';
import { EMBEDDING_TASK } from '@myco-server-worker/core/embedding/jobs.js';
import { embeddingRunReport, runEmbeddingSteps } from '@myco-server-worker/core/embedding/run.js';
import { ServerClient, type FetchLike } from '@myco/member/transport.js';
import { postRunControl, postRunReport } from '@myco/member/run-control.js';

type Launch = NonNullable<ServerEnv['harnessLaunch']>;
type LaunchSpec = Parameters<Launch>[0];
const CONTROL_BUDGET = { connectTimeoutMs: 5_000, requestTimeoutMs: 30_000 };
const CLOSE_BUDGET = { connectTimeoutMs: 5_000, requestTimeoutMs: 5_000 };

/** Runs dispatched embedding work through the Deployment's authenticated run routes. */
export class LocalEmbeddingRuntime {
  readonly tasks = [EMBEDDING_TASK];
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private draining = false;

  constructor(private readonly report: (message: string) => void = console.error) {}

  launchFor(callbackOrigin: () => string): Launch {
    return async (spec) => {
      if (this.draining) throw new RuntimeDraining('native embedding runtime is stopping');
      if (spec.envVars.MYCO_TASK !== EMBEDDING_TASK) throw new Error('native embedding runtime does not serve this task');
      if (this.running.has(spec.runId)) throw new RuntimeAlreadyHolding('native embedding runtime already holds this run');
      const origin = callbackOrigin();
      const controller = new AbortController();
      const done = this.execute(spec, origin, controller.signal)
        .catch((error: unknown) => this.report(`Native embedding run ${spec.runId} failed: ${error instanceof Error ? error.message : String(error)}`))
        .finally(() => { this.running.delete(spec.runId); });
      this.running.set(spec.runId, { controller, done });
    };
  }

  async stop(): Promise<void> {
    this.draining = true;
    for (const run of this.running.values()) run.controller.abort();
    await Promise.all([...this.running.values()].map((run) => run.done));
  }

  private async execute(spec: LaunchSpec, origin: string, stopped: AbortSignal): Promise<void> {
    const deadline = Date.now() + spec.timeoutSeconds * 1000;
    const signal = AbortSignal.any([stopped, AbortSignal.timeout(spec.timeoutSeconds * 1000)]);
    const record = { serverUrl: origin, token: spec.envVars.MYCO_MEMBER_TOKEN!, projectId: spec.envVars.MYCO_PROJECT! };
    const boundedFetch: FetchLike = (input, init) => fetch(input, {
      ...init, signal: AbortSignal.any([signal, ...(init?.signal == null ? [] : [init.signal])]),
    });
    const client = new ServerClient(record, boundedFetch);
    const control = (route: string, body: unknown) => postRunControl(client, CONTROL_BUDGET, route, body);
    const close = async (status: 'completed' | 'failed', error?: string) => {
      const answer = await postRunControl(new ServerClient(record), CLOSE_BUDGET, '/runs/update', {
        runId: spec.runId, update: { status, completed_at: Date.now(), tokens_used: 0, ...(error === undefined ? {} : { error }) },
      });
      if (answer.applied !== true) throw new Error(`native embedding close refused: ${String(answer.reason ?? 'not applied')}`);
    };
    try {
      const claimed = await control('/runs/claim', { id: spec.runId, agentId: HARNESS_AGENT_ID, task: EMBEDDING_TASK,
        captureDriven: true, startedAt: Date.now(), provider: 'embedding', model: spec.envVars.MYCO_MODEL });
      if (claimed.claimed !== true) throw new Error('native embedding run claim refused');
      const { processed, phase } = await runEmbeddingSteps(
        () => control('/runs/embedding-step', { runId: spec.runId }), signal, deadline);
      await postRunReport(client, CONTROL_BUDGET, { runId: spec.runId, agentId: HARNESS_AGENT_ID, ...embeddingRunReport({ processed, phase }) });
      await close('completed');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { await close('failed', message); }
      catch (closeError) { throw new AggregateError([error, closeError], 'native embedding failed and its terminal update was not accepted'); }
      throw error;
    }
  }
}
