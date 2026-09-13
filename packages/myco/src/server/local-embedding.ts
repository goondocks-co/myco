import type { ServerEnv } from '@myco-server-worker/core/adapters.js';
import { RuntimeAlreadyHolding, RuntimeDraining } from '@myco-server-worker/core/harness.js';
import { EMBEDDING_TASK } from '@myco-server-worker/core/embedding/jobs.js';
import { executeEmbeddingRun } from '@myco-server-worker/core/embedding/run.js';
import { runControlClient } from '@goondocks/myco-shared/run-control';

type Launch = NonNullable<ServerEnv['harnessLaunch']>;
type LaunchSpec = Parameters<Launch>[0];

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
    const request = runControlClient({ origin, token: spec.envVars.MYCO_MEMBER_TOKEN!, projectId: spec.envVars.MYCO_PROJECT! }, fetch);
    await executeEmbeddingRun(spec, request, { signal, deadline });
  }
}
