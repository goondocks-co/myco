import type { ServerEnv } from '../../core/adapters.js';
import { RuntimeAlreadyHolding, RuntimeDraining } from '../../core/harness.js';
import { EMBEDDING_TASK } from '../../core/embedding/jobs.js';
import { executeEmbeddingRun } from '../../core/embedding/run.js';
import { failStaleRun, getRun } from '../../core/runs.js';
import { releaseRun } from '../../core/release.js';
import { runControlClient } from '@goondocks/myco-shared/run-control';

type Launch = NonNullable<ServerEnv['harnessLaunch']>;
type LaunchSpec = Parameters<Launch>[0];

/** Runs dispatched embedding work through the Deployment's authenticated run routes. */
export class EmbeddingRuntime {
  readonly tasks = [EMBEDDING_TASK];
  private readonly running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private draining = false;
  private readonly failures: unknown[] = [];

  constructor(
    private readonly env: () => ServerEnv,
    private readonly fetcher: Parameters<typeof runControlClient>[1],
    private readonly report: (message: string) => void = console.error,
  ) {}

  launchFor(callbackOrigin: () => string): Launch {
    return async (spec) => {
      if (this.draining) throw new RuntimeDraining('in-process embedding runtime is stopping');
      if (spec.envVars.MYCO_TASK !== EMBEDDING_TASK) throw new Error('in-process embedding runtime does not serve this task');
      if (this.running.has(spec.runId)) throw new RuntimeAlreadyHolding('in-process embedding runtime already holds this run');
      const origin = callbackOrigin();
      const controller = new AbortController();
      const done = this.execute(spec, origin, controller.signal)
        .catch(async (error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          this.report(`Embedding run ${spec.runId} failed: ${message}`);
          try {
            const env = this.env();
            const scope = { projectId: spec.envVars.MYCO_PROJECT! };
            const now = Date.now();
            if (await failStaleRun(env.db, scope, spec.runId, now, message, 'run_failed')) {
              const run = await getRun(env.db, scope, spec.runId);
              if (run !== null) await releaseRun(env, scope, run, now);
            }
          } catch (persistenceError) {
            this.failures.push(persistenceError);
            this.report(`Embedding run ${spec.runId} failure could not be persisted: ${persistenceError instanceof Error ? persistenceError.message : String(persistenceError)}`);
          }
        })
        .finally(() => { this.running.delete(spec.runId); });
      this.running.set(spec.runId, { controller, done });
    };
  }

  async stop(): Promise<void> {
    this.draining = true;
    for (const run of this.running.values()) run.controller.abort();
    await this.waitForIdle();
  }

  async waitForIdle(): Promise<void> {
    await Promise.all([...this.running.values()].map(run => run.done));
    if (this.failures.length > 0) throw new AggregateError(this.failures, 'embedding failures could not be persisted');
  }

  private async execute(spec: LaunchSpec, origin: string, stopped: AbortSignal): Promise<void> {
    const deadline = Date.now() + spec.timeoutSeconds * 1000;
    const signal = AbortSignal.any([stopped, AbortSignal.timeout(spec.timeoutSeconds * 1000)]);
    const request = runControlClient({ origin, token: spec.envVars.MYCO_MEMBER_TOKEN!, projectId: spec.envVars.MYCO_PROJECT! }, this.fetcher);
    await executeEmbeddingRun(spec, request, { signal, deadline });
  }
}
