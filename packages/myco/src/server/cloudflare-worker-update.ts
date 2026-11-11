import { CloudflareAuthenticationError, runCloudflareCommand, type CloudflareOptions } from './cloudflare.js';
import { connectionFailure, refusedAccountCode, transientProviderOutput } from './object-read.js';
import { CommandFailed, CommandTimedOut, describeFailure } from './runner.js';

export const WORKER_UPDATE_RETRY_MS = 10 * 60_000;
const ATTEMPT_TIMEOUT_MS = 2 * 60_000;
const BACKOFF_MIN_MS = 15_000;
const BACKOFF_MAX_MS = 60_000;
const NEXT_UPDATE = 'myco server update --target cloudflare';

export interface WorkerRetry {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

type WorkerPhase = 'upload' | 'deploy' | 'triggers';
type StopReason = 'refused' | 'out_of_time';

const STOP_NAMES = {
  refused: 'stopped: Worker refused',
  out_of_time: 'stopped: Worker update ran out of time',
} as const;

export class WorkerUpdateStopped extends Error {
  readonly outcome;
  readonly activationUnconfirmed;

  constructor(readonly phase: WorkerPhase, readonly reason: StopReason, cause: unknown) {
    const outcome = STOP_NAMES[reason];
    super(`${outcome} during ${phase}: ${describeFailure(cause)}. Next: run: ${NEXT_UPDATE}`, { cause });
    this.name = 'WorkerUpdateStopped';
    this.outcome = outcome;
    this.activationUnconfirmed = phase === 'deploy'
      && (reason === 'out_of_time' || cause instanceof CommandTimedOut || connectionFailure(cause));
  }
}

function transientWorkerFailure(error: unknown): boolean {
  if (error instanceof CloudflareAuthenticationError || refusedAccountCode(error) !== null) return false;
  if (error instanceof CommandTimedOut || connectionFailure(error)) return true;
  if (!(error instanceof CommandFailed)) return false;
  const output = `${error.stdout}\n${error.stderr}`;
  return (/(?:\[code:\s*10021\]|"code"\s*:\s*10021\b)/i.test(output) && /try again later/i.test(output))
    || transientProviderOutput(output)
    || /\b(?:request (?:timed out|timeout)|network (?:error|failure|request failed)|socket hang up)\b/i.test(output)
    || /\b(?:HTTP(?:\/\d(?:\.\d)?)?\s+|status(?:\s+code)?[\s:=]+)5\d\d\b/i.test(output)
    || /\b5\d\d\s+(?:Internal Server Error|Bad Gateway|Service Unavailable|Gateway Tim(?:eout|e-out))\b/i.test(output);
}

/** Each instance owns one budget of command time and backoff. */
export class CloudflareWorkerUpdate {
  private leftMs = WORKER_UPDATE_RETRY_MS;
  private readonly now;
  private readonly sleep;

  constructor(private readonly options: CloudflareOptions & { report?: (line: string) => void; workerRetry?: WorkerRetry }) {
    this.now = options.workerRetry?.now ?? Date.now;
    this.sleep = options.workerRetry?.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  }

  async upload(): Promise<string> {
    return this.attempt('upload', async timeoutMs => {
      const result = await runCloudflareCommand(this.options, ['versions', 'upload'], timeoutMs);
      const version = /Worker Version ID:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i.exec(result.stdout)?.[1];
      if (version === undefined) throw new Error('upload returned no valid Worker version id; no migrations or activation were started');
      return version;
    });
  }

  async deploy(version: string): Promise<void> {
    await this.attempt('deploy', timeoutMs => runCloudflareCommand(this.options, ['versions', 'deploy', `${version}@100%`, '--yes'], timeoutMs));
  }

  async triggers(): Promise<void> {
    await this.attempt('triggers', timeoutMs => runCloudflareCommand(this.options, ['triggers', 'deploy'], timeoutMs));
  }

  private async timed<T>(run: () => Promise<T>): Promise<T> {
    const started = this.now();
    try { return await run(); }
    finally { this.leftMs -= Math.max(0, this.now() - started); }
  }

  private async attempt<T>(phase: WorkerPhase, run: (timeoutMs: number) => Promise<T>): Promise<T> {
    let attempt = 0;
    let delay = BACKOFF_MIN_MS;
    let lastError: unknown = new Error('the shared 10 minute Worker update budget is exhausted');
    for (;;) {
      if (this.leftMs <= 0) throw new WorkerUpdateStopped(phase, 'out_of_time', lastError);
      attempt += 1;
      this.options.report?.(`Worker ${phase}: attempt ${attempt} (${Math.ceil(this.leftMs / 1000)} s left for Worker commands and retries).`);
      try {
        const result = await this.timed(() => run(Math.min(ATTEMPT_TIMEOUT_MS, this.leftMs)));
        this.options.report?.(`Worker ${phase}: attempt ${attempt} succeeded.`);
        return result;
      } catch (error) {
        lastError = error;
        if (!transientWorkerFailure(error)) throw new WorkerUpdateStopped(phase, 'refused', error);
        this.options.report?.(`Worker ${phase}: attempt ${attempt} failed transiently: ${describeFailure(error).replace(/\s+/g, ' ').trim()}`);
        if (this.leftMs <= 0) throw new WorkerUpdateStopped(phase, 'out_of_time', error);
        const wait = Math.min(delay, this.leftMs);
        this.options.report?.(`Waiting ${Math.ceil(wait / 1000)} s before retrying Worker ${phase}.`);
        await this.timed(() => this.sleep(wait));
        delay = Math.min(BACKOFF_MAX_MS, delay * 2);
      }
    }
  }
}
