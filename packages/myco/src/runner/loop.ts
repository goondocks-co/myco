import { parseWorkerUsage, type WorkerUsage } from '@goondocks/myco-shared/worker-usage';
/**
 * The worker: claim one run, hold it on a lease, drive a harness, end it.
 *
 * A worker is a client of the Deployment's HTTP surface and nothing more, so a
 * worker inside the laptop server process and a worker on a machine of its own
 * run the same code against the same routes. It holds a member credential that
 * administers the Deployment; the harness child it starts holds a different
 * credential entirely, scoped to its one run, and reaches only the MCP surface.
 *
 * The lease is what makes a worker's disappearance survivable. It is renewed on
 * a timer while a run is driven, and a renewal the Deployment declines says
 * another worker holds the run now: the child is stopped and nothing is written,
 * so two workers never both report an outcome for one run.
 */
import { mkdirSync } from 'node:fs';
import { detectHarnesses, type DetectedHarness } from './detect.js';
import { driverFor } from './drivers/registry.js';
import { discardRunDir, writeRunDir } from './mcp-config.js';
import { deploymentScopedHeaders, MEMBER_PROTOCOL } from '../member/constants.js';
import { classifyEventAnswer, rawAnswerOf, type RawAnswer } from '../member/transport.js';
import type { RunEvent } from './events.js';
import { parseRepositoryCheckoutSpec, REPOSITORY_CHECKOUT_CAPABILITY, type RepositoryCheckoutSpec } from '@goondocks/myco-shared/repository';
import { prepareWorkerCheckout } from './repository.js';
import type { RepositoryCheckout } from './repository-checkout.js';

/** What a claim answers: the run, the harness chosen for it, and what it runs under. */
interface ClaimedRun {
  repository?: RepositoryCheckoutSpec;
  projectId: string;
  id: string;
  task: string;
  instruction: string | null;
  /** The standing rules the Deployment handed beside the prompt, written as the run's instructions file; null where the prompt is the whole instruction. */
  instructions: string | null;
  harness: string;
  runToken: string;
  attemptId?: string;
  credentialEnv: Record<string, string>;
  /** The run's own budget, as the Deployment decided it. The worker records it; the Deployment enforces it through the sweep. */
  timeoutSeconds: number;
}

export interface WorkerOptions {
  /** Git executable override for a controlled checkout environment. */
  repositoryGitPath?: string;
  serverUrl: string;
  token: string;
  runRoot: string;
  /** Only these harnesses are offered, where the caller names any. */
  only?: readonly string[];
  /** Stop after one run rather than polling forever. */
  once?: boolean;
  /** What a worker waits when the Deployment says nothing about it. Every answer carries the Deployment's own cadence, which is what a worker actually keeps. */
  pollIdleMs: number;
  log: (line: string) => void;
  fetchImpl?: typeof fetch;
  signal: AbortSignal;
}

/**
 * What a worker's request came back as.
 *
 * Three outcomes, acted on differently and therefore distinct: an answer the
 * worker can read, a refusal of the worker itself, and a Deployment it could not
 * reach. A refusal is repeated identically on every later request and ends the
 * attachment; an unreachable Deployment is not, and the worker keeps polling. A
 * single "no answer" for both makes a refusal indistinguishable from silence.
 */
type WorkerAnswer =
  | { kind: 'answered'; body: Record<string, unknown> }
  | { kind: 'refused'; code: string; detail: string }
  | { kind: 'unreachable'; detail: string };

/**
 * One worker request, classified the way every other member call is.
 *
 * The headers are the member's own — bearer and protocol, and no Project, which
 * a Deployment-scoped route names none of — and the answer goes through the
 * member classifier, so a protocol window, a dead credential and a refusal all
 * arrive here as themselves rather than as an unreadable body.
 */
async function post(options: WorkerOptions, path: string, body: unknown): Promise<WorkerAnswer> {
  const send = options.fetchImpl ?? fetch;
  let raw: RawAnswer;
  try {
    const res = await send(new URL(path, options.serverUrl).toString(), {
      method: 'POST',
      headers: { ...deploymentScopedHeaders({ token: options.token }), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    raw = await rawAnswerOf(res);
  } catch (error) {
    raw = { kind: 'transport', detail: error instanceof Error ? error.message : String(error) };
  }
  const outcome = classifyEventAnswer(raw);
  switch (outcome.class) {
    case 'acked':
      return { kind: 'answered', body: outcome.body };
    case 'protocol':
      return {
        kind: 'refused',
        code: 'protocol_version_unsupported',
        detail: `this worker speaks member protocol ${MEMBER_PROTOCOL}; the Deployment speaks ${outcome.serverProtocol ?? '?'}`
          + ` and accepts nothing below ${outcome.minCompatMemberProtocol ?? '?'}`,
      };
    case 'unauthorized':
      return { kind: 'refused', code: 'unauthorized', detail: 'the Deployment does not hold the credential this worker presented' };
    case 'route_missing':
      return { kind: 'refused', code: 'route_missing', detail: 'the Deployment serves no worker control plane at this address' };
    case 'retry':
      // A 200 whose body is not the shape this route answers in is a wrong
      // address rather than a passing fault: nothing the worker sends next
      // time differs, so it is a refusal. Every other retry class — 429, 503,
      // 5xx, a timeout, a dead socket — is transient and keeps the worker.
      return outcome.status === 200
        ? { kind: 'refused', code: 'malformed_answer', detail: outcome.detail }
        : { kind: 'unreachable', detail: outcome.detail };
    default:
      return { kind: 'refused', code: outcome.code, detail: 'reason' in outcome ? outcome.reason : '' };
  }
}

/** What the Deployment said, when it said a positive number; the fallback otherwise. */
function waitOf(told: unknown, fallback: number): number {
  return typeof told === 'number' && Number.isFinite(told) && told > 0 ? told : fallback;
}

/** What a worker keeps only until a Deployment tells it otherwise, which is on its first answer. */
const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * How long past its own budget a run's child is left alone before the worker
 * stops it.
 *
 * The worker enforces the budget the claim answered, rather than leaving it to
 * the Deployment: the Deployment's sweep fails an overrunning run on a margin of
 * its own, and a worker that waited for that would hold a harness child for
 * minutes after the run it belongs to was already lost. This grace is small for
 * the same reason — it is there for a harness finishing its last write, not for
 * a second attempt — and well under the Deployment's margin, so the worker's own
 * account of the overrun is the one that lands.
 */
const RUN_OVERRUN_GRACE_MS = 5_000;

const asRun = (value: unknown): ClaimedRun | null => {
  if (value === null || typeof value !== 'object') return null;
  const run = value as ClaimedRun;
  const named = typeof run.id === 'string' && typeof run.task === 'string' && typeof run.harness === 'string' && typeof run.runToken === 'string';
  if (!named || !(typeof run.instruction === 'string' || run.instruction === null)) return null;
  let repository: RepositoryCheckoutSpec | undefined;
  try { repository = run.repository === undefined ? undefined : parseRepositoryCheckoutSpec(run.repository); } catch { return null; }
  return { ...run, repository, instructions: typeof run.instructions === 'string' ? run.instructions : null };
};

/**
 * Drive one claimed run to its end.
 *
 * The outcome a worker reports is whether the harness reached the end of its
 * turn. What the run actually achieved is the Deployment's to decide, from the
 * writes it can see; nothing here reads the harness's own account of its
 * success.
 */
async function drive(options: WorkerOptions, run: ClaimedRun, heartbeatMs: number): Promise<{ status: 'completed' | 'failed' | 'lost'; error: string | null; usage?: WorkerUsage | null }> {
  // A run that fails before its harness starts has no event to log it by, so it is said here.
  const failedBeforeStart = (error: string): { status: 'failed'; error: string } => {
    options.log(`run ${run.id} failed before its harness started: ${error}`);
    return { status: 'failed', error };
  };
  const driver = driverFor(run.harness);
  if (driver === null) return failedBeforeStart(`no driver serves the harness ${run.harness}`);
  // A harness given nothing to do ends its turn at once, and a worker that
  // launched it would then report a run that did nothing as one that finished.
  // The Deployment ends such a run at the claim; a Deployment that hands one
  // out anyway is answered with the failure it would otherwise have hidden.
  if (run.instruction === null || run.instruction.trim() === '') return failedBeforeStart(`the Deployment supplied no instruction for this ${run.task} run`);

  mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  const { scratchDir, mcpConfigPath } = writeRunDir(options.runRoot, run.id, {
    serverUrl: options.serverUrl, projectId: run.projectId, runToken: run.runToken,
  }, run.instructions);

  const stopping = new AbortController();
  const onAbort = (): void => { stopping.abort(); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  if (options.signal.aborted) stopping.abort();
  let lost = false;
  let unreachable = false;
  let overran = false;
  /**
   * The budget, settled by the timer rather than by the harness.
   *
   * Aborting the child is asked for, not waited on: a signal reaches the process
   * the driver started, and that process may leave a grandchild holding the same
   * standard output — a shell waiting on a sleep is enough — in which case the
   * driver's stream never ends and a worker that only read it would hold the run
   * for as long as the harness felt like living. The budget therefore ends the
   * READ as well, and the run's outcome is written from it.
   */
  let budgetReached: () => void = () => {};
  const overrunReached = new Promise<'overran'>((resolve) => { budgetReached = () => { resolve('overran'); }; });
  const budget = setTimeout(() => {
    overran = true;
    options.log(`run ${run.id} outlived its budget of ${run.timeoutSeconds}s; stopping the harness`);
    stopping.abort();
    budgetReached();
  }, run.timeoutSeconds * 1000 + RUN_OVERRUN_GRACE_MS);
  const heartbeat = setInterval(() => {
    void post(options, '/worker/lease', { projectId: run.projectId, runId: run.id }).then((answer) => {
      // A renewal that never arrived is not a renewal declined. The Deployment's
      // own sweep gives the run to another worker once the lease runs out, and
      // it refuses an outcome from a worker that no longer holds it, so a
      // network blip leaves the child running rather than killing the run.
      if (answer.kind === 'unreachable') {
        if (!unreachable) { unreachable = true; options.log(`cannot renew the lease on ${run.id}: ${answer.detail}`); }
        return;
      }
      unreachable = false;
      if (answer.kind === 'answered' && answer.body.held === true) return;
      lost = true;
      options.log(answer.kind === 'refused'
        ? `the Deployment refused the lease on ${run.id}: ${answer.code}`
        : `lease lost on ${run.id}; another worker holds it`);
      stopping.abort();
    });
  }, heartbeatMs);

  const events: RunEvent[] = [];
  let usage: WorkerUsage | null = null;
  let stream: AsyncIterator<RunEvent> | undefined;
  let checkout: RepositoryCheckout | undefined;
  let failure: string | null = null;
  try {
    if (run.repository !== undefined) {
      checkout = await prepareWorkerCheckout(run.repository, scratchDir, stopping.signal, async (input, signal) => {
        const answer = await post({ ...options, signal }, '/worker/repository', { ...input, projectId: run.projectId, runId: run.id });
        if (answer.kind !== 'answered') throw new Error(`Repository preparation failed: ${answer.detail}`);
        if (answer.body.held !== true) { lost = true; stopping.abort(); throw new Error('The repository lease is no longer held.'); }
        if (typeof answer.body.error === 'string') throw new Error(answer.body.error);
        return answer.body;
      }, options.repositoryGitPath);
    }
    stopping.signal.throwIfAborted();
    stream = driver.run({
      prompt: run.instruction, scratchDir, mcpConfigPath, credentialEnv: run.credentialEnv,
      sourceReadOnly: checkout !== undefined,
    }, stopping.signal)[Symbol.asyncIterator]();
    for (;;) {
      const step = await Promise.race([stream.next(), overrunReached]);
      if (step === 'overran' || step.done === true) break;
      events.push(step.value);
      if (step.value.kind === 'usage') {
        const { kind: _kind, ...reported } = step.value;
        const parsed = parseWorkerUsage(reported);
        usage = Object.values(parsed).every((value) => value == null) ? null : parsed;
      }
      if (step.value.kind === 'tool_call') options.log(`run ${run.id} called ${step.value.name}: ${step.value.status}`);
      if (step.value.kind === 'ended') options.log(`run ${run.id} ended ${step.value.stop}`);
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
  } finally {
    clearInterval(heartbeat);
    clearTimeout(budget);
    options.signal.removeEventListener('abort', onAbort);
    // Closing the stream runs the driver's own cleanup, which stops the child.
    // Not awaited: the driver may be blocked on the very read the budget gave up
    // on, and a worker that waited here would be held by it all over again.
    void Promise.resolve(stream?.return?.()).catch(() => undefined);
    try { await checkout?.dispose(); } finally { discardRunDir(scratchDir); }
  }

  // A lost lease is decided before anything else, including an overrun: a worker
  // that no longer holds the run writes NOTHING about it, and a run that both
  // overran and changed hands belongs to whoever holds it now. Reporting the
  // overrun instead would have this worker account for a run it does not own.
  if (lost) return { status: 'lost', error: null };
  // The budget is otherwise the outcome, whatever the harness wrote on its way
  // out: a child stopped for overrunning did not finish its turn, and a stop
  // reason it managed to emit as it died would otherwise read as one.
  if (overran) return { status: 'failed', usage, error: `the run outlived its budget of ${run.timeoutSeconds}s` };
  if (failure !== null) return { status: 'failed', error: failure, usage };
  const last = events.at(-1);
  if (last === undefined || last.kind !== 'ended') return { status: 'failed', error: 'the harness wrote no ending', usage };
  return last.stop === 'end_turn'
    ? { status: 'completed', error: null, usage }
    : { status: 'failed', usage, error: `the harness stopped: ${last.stop}${last.detail === null ? '' : ` (${last.detail})`}` };
}

/** How a worker's attachment ended: what it drove, and the code it was refused with where a Deployment refused it. */
export interface WorkerOutcome {
  driven: number;
  /** The code the Deployment answered, or null when the worker was stopped or drove its one run. A worker refused here cannot claim anything and exits non-zero. */
  refused: string | null;
}

/**
 * Claim runs until the caller stops the worker, or until one run has been
 * driven when `once` is set.
 *
 * A refusal ends the attachment and says why. There is nothing a worker can do
 * about a credential the Deployment does not hold, a protocol it does not
 * speak, or a membership that does not administer it — every later claim is
 * refused identically — so polling against one is an attached worker that drives
 * nothing and reports nothing. A Deployment it cannot reach is the opposite: the
 * worker keeps polling, and says once that it is failing and once that it is back.
 */
export async function runWorker(options: WorkerOptions): Promise<WorkerOutcome> {
  const harnesses: DetectedHarness[] = detectHarnesses(options.only);
  const ready = harnesses.filter((h) => h.authenticated).map((h) => h.id);
  options.log(ready.length === 0
    ? `no harness on this machine is logged in; nothing can be claimed (found: ${harnesses.map((h) => h.id).join(', ') || 'none'})`
    : `offering ${ready.join(', ')}`);

  let driven = 0;
  let unreachable = false;
  /** The reason the last claim answered nothing, so a change in it is said once and a repeat is not. */
  let waiting: string | null = null;
  while (!options.signal.aborted) {
    const answer = await post(options, '/worker/claim', { harnesses, capabilities: [REPOSITORY_CHECKOUT_CAPABILITY] });
    if (answer.kind === 'refused') {
      options.log(`the Deployment refused the claim: ${answer.code}${answer.detail === '' ? '' : ` — ${answer.detail}`}`);
      return { driven, refused: answer.code };
    }
    if (answer.kind === 'unreachable') {
      // Said once rather than every poll: a worker left attached across an
      // outage would otherwise fill a log with one line per poll, and the
      // recovery — the line that says claiming resumed — would be lost in it.
      if (!unreachable && !options.signal.aborted) { unreachable = true; options.log(`cannot reach ${options.serverUrl}: ${answer.detail}; still polling`); }
      await sleep(options.pollIdleMs, options.signal);
      continue;
    }
    if (unreachable) { unreachable = false; options.log(`reached ${options.serverUrl} again`); }

    const claim = answer.body;
    if (claim.claimed !== true) {
      // Said once per change rather than once per poll. `no_work` is an idle
      // queue and `no_harness` is work this worker cannot run — actionable, and
      // indistinguishable from idleness to anyone reading an unlabelled silence.
      const reason = typeof claim.reason === 'string' ? claim.reason : 'unexplained';
      if (reason !== waiting) { waiting = reason; options.log(`nothing claimed: ${reason}`); }
      await sleep(waitOf(claim.pollAfterMs, options.pollIdleMs), options.signal);
      continue;
    }
    waiting = null;

    const run = asRun(claim.run);
    if (run === null) {
      options.log('the Deployment answered a claim naming no run');
      return { driven, refused: 'malformed_answer' };
    }
    options.log(`claimed ${run.id} (${run.task}) on ${run.harness}, budget ${run.timeoutSeconds}s`);
    // The cadence is the Deployment's, carried on the claim it answered.
    const outcome = await drive(options, run, waitOf(claim.heartbeatMs, DEFAULT_HEARTBEAT_MS));
    // A worker that lost its lease writes nothing: the run belongs to whoever
    // holds it now, and a late outcome would be one worker reporting on
    // another's run. The Deployment refuses such a write anyway; not making it
    // is what keeps the two accounts of a run from disagreeing.
    if (outcome.status !== 'lost') {
      const ended = await post(options, '/worker/end', { projectId: run.projectId, runId: run.id, status: outcome.status, error: outcome.error,
        ...(run.attemptId === undefined ? {} : { attemptId: run.attemptId, usage: outcome.usage ?? null }),
      });
      if (ended.kind === 'refused') {
        options.log(`the Deployment refused the outcome of ${run.id}: ${ended.code}`);
        return { driven, refused: ended.code };
      }
      // An outcome that never arrived leaves the run to the Deployment's sweep,
      // which is what owns a run no worker reports on. Saying so is what makes
      // the difference visible between that and a run nobody ever claimed.
      if (ended.kind === 'unreachable') options.log(`could not report the outcome of ${run.id}: ${ended.detail}`);
      // The worker reports what the harness did; the Deployment records what the
      // task actually left behind, and the two differ whenever a harness ends its
      // turn having done none of the work. A worker that logged only its own
      // report would show a clean drive against a run the Deployment failed.
      if (ended.kind === 'answered') {
        const recorded = ended.body.status;
        if (typeof recorded === 'string' && recorded !== outcome.status) {
          options.log(`reported ${run.id} as ${outcome.status}; the Deployment recorded it ${recorded}`);
        }
      }
    }
    driven += 1;
    if (options.once === true) return { driven, refused: null };
  }
  return { driven, refused: null };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
