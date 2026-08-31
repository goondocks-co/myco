/**
 * The container a single agent run executes in.
 *
 * One container per run, not one container running many. `Container` extends
 * `DurableObject`, and an instance is keyed by its Durable Object id, so
 * `getContainer(env.HARNESS, runId)` gives each run its own filesystem, its own
 * memory budget, and its own fate: a run that exhausts memory takes only itself
 * down. Peak concurrency observed in practice is six.
 *
 * This class is mechanism. The rule it applies — when to renew, when to let go —
 * is `run-hold.ts`, which is tested without a deployed container.
 */
import { Container } from '@cloudflare/containers';
import { decideHold, holdDeadline, type HoldState } from './run-hold.js';

/**
 * How long a container may sit without activity before the platform stops it.
 *
 * Sized past the longest continuous run observed (59 minutes) so the window is
 * never the thing that ends a run. It is a backstop, not the mechanism: a run
 * is held by renewal and released when it finishes.
 */
export const SLEEP_AFTER = '90m';
const SLEEP_AFTER_MS = 90 * 60_000;

const HOLD_KEY = 'run-hold';

export class HarnessContainer extends Container {
  override defaultPort = 8080;
  override sleepAfter = SLEEP_AFTER;

  /**
   * Begin a run and hold this container for it.
   *
   * The deadline comes from the run's own `timeoutSeconds`: the executor aborts
   * there, so holding past it would keep a container alive for work that has
   * stopped.
   */
  async beginRun(runId: string, timeoutSeconds: number): Promise<void> {
    const state: HoldState = { runId, holdUntil: holdDeadline(Date.now(), timeoutSeconds) };
    await this.ctx.storage.put(HOLD_KEY, state);
    this.renewActivityTimeout();
    await this.scheduleNextCheck(Date.now());
  }

  /**
   * Start this run's container with its dispatch environment and take the
   * hold. Start first: a hold on an instance that failed to start renews a
   * container that is not there.
   */
  async launch(spec: { runId: string; timeoutSeconds: number; envVars: Record<string, string> }): Promise<void> {
    await this.startAndWaitForPorts({ startOptions: { envVars: spec.envVars } });
    await this.beginRun(spec.runId, spec.timeoutSeconds);
  }

  /**
   * End the hold.
   *
   * The container then sleeps and stops on its own, which is what makes a
   * per-run container cheap. Stopping between runs is the desired behaviour.
   */
  async endRun(): Promise<void> {
    await this.ctx.storage.delete(HOLD_KEY);
  }

  /**
   * The renewal itself.
   *
   * Compute does not reset a container's activity timer; incoming requests do.
   * A run that is working and answering nothing is stopped mid-run unless this
   * fires (#908: 32 seconds without it, still running at 788 seconds with it).
   */
  override async alarm(): Promise<void> {
    const state = (await this.ctx.storage.get<HoldState>(HOLD_KEY)) ?? null;
    const decision = decideHold(state, Date.now(), SLEEP_AFTER_MS);

    if (decision.action === 'release') {
      await this.ctx.storage.delete(HOLD_KEY);
      return;
    }

    this.renewActivityTimeout();
    await this.ctx.storage.setAlarm(decision.nextCheckAt);
  }

  private async scheduleNextCheck(now: number): Promise<void> {
    const state = (await this.ctx.storage.get<HoldState>(HOLD_KEY)) ?? null;
    const decision = decideHold(state, now, SLEEP_AFTER_MS);
    if (decision.action === 'renew') await this.ctx.storage.setAlarm(decision.nextCheckAt);
  }
}
