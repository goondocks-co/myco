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
import type { RunEvent } from './events.js';

/** What a claim answers: the run, the harness chosen for it, and what it runs under. */
interface ClaimedRun {
  projectId: string;
  id: string;
  task: string;
  instruction: string | null;
  harness: string;
  runToken: string;
  credentialEnv: Record<string, string>;
  /** The run's own budget, as the Deployment decided it. The worker records it; the Deployment enforces it through the sweep. */
  timeoutSeconds: number;
}

export interface WorkerOptions {
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

async function post(options: WorkerOptions, path: string, body: unknown): Promise<Record<string, unknown> | null> {
  const send = options.fetchImpl ?? fetch;
  try {
    const res = await send(new URL(path, options.serverUrl).toString(), {
      method: 'POST',
      headers: { authorization: `Bearer ${options.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    const answered: unknown = await res.json();
    return answered !== null && typeof answered === 'object' ? answered as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** What the Deployment said, when it said a positive number; the fallback otherwise. */
function waitOf(told: unknown, fallback: number): number {
  return typeof told === 'number' && Number.isFinite(told) && told > 0 ? told : fallback;
}

/** What a worker keeps only until a Deployment tells it otherwise, which is on its first answer. */
const DEFAULT_HEARTBEAT_MS = 30_000;

const asRun = (value: unknown): ClaimedRun | null =>
  (value !== null && typeof value === 'object' && typeof (value as ClaimedRun).id === 'string' ? value as ClaimedRun : null);

/**
 * Drive one claimed run to its end.
 *
 * The outcome a worker reports is whether the harness reached the end of its
 * turn. What the run actually achieved is the Deployment's to decide, from the
 * writes it can see; nothing here reads the harness's own account of its
 * success.
 */
async function drive(options: WorkerOptions, run: ClaimedRun, heartbeatMs: number): Promise<{ status: 'completed' | 'failed' | 'lost'; error: string | null }> {
  const driver = driverFor(run.harness);
  if (driver === null) return { status: 'failed', error: `no driver serves the harness ${run.harness}` };

  mkdirSync(options.runRoot, { recursive: true, mode: 0o700 });
  const { scratchDir, mcpConfigPath } = writeRunDir(options.runRoot, run.id, {
    serverUrl: options.serverUrl, projectId: run.projectId, runToken: run.runToken,
  });

  const stopping = new AbortController();
  const onAbort = (): void => { stopping.abort(); };
  options.signal.addEventListener('abort', onAbort, { once: true });
  let lost = false;
  const heartbeat = setInterval(() => {
    void post(options, '/worker/lease', { projectId: run.projectId, runId: run.id }).then((answer) => {
      if (answer?.held === true) return;
      lost = true;
      options.log(`lease lost on ${run.id}; another worker holds it`);
      stopping.abort();
    });
  }, heartbeatMs);

  const events: RunEvent[] = [];
  try {
    for await (const event of driver.run({
      prompt: run.instruction ?? '',
      scratchDir,
      mcpConfigPath,
      credentialEnv: run.credentialEnv,
    }, stopping.signal)) {
      events.push(event);
      if (event.kind === 'ended') options.log(`run ${run.id} ended ${event.stop}`);
    }
  } catch (error) {
    return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearInterval(heartbeat);
    options.signal.removeEventListener('abort', onAbort);
    discardRunDir(scratchDir);
  }

  if (lost) return { status: 'lost', error: null };
  const last = events.at(-1);
  if (last === undefined || last.kind !== 'ended') return { status: 'failed', error: 'the harness wrote no ending' };
  return last.stop === 'end_turn'
    ? { status: 'completed', error: null }
    : { status: 'failed', error: `the harness stopped: ${last.stop}${last.detail === null ? '' : ` (${last.detail})`}` };
}

/** Claim runs until the caller stops the worker, or until one run has been driven when `once` is set. */
export async function runWorker(options: WorkerOptions): Promise<number> {
  const harnesses: DetectedHarness[] = detectHarnesses(options.only);
  const ready = harnesses.filter((h) => h.authenticated).map((h) => h.id);
  options.log(ready.length === 0
    ? `no harness on this machine is logged in; nothing can be claimed (found: ${harnesses.map((h) => h.id).join(', ') || 'none'})`
    : `offering ${ready.join(', ')}`);

  let driven = 0;
  while (!options.signal.aborted) {
    const answer = await post(options, '/worker/claim', { harnesses });
    if (answer === null) { await sleep(options.pollIdleMs, options.signal); continue; }
    if (answer.persisted === false) { options.log(`the Deployment refused the claim: ${String(answer.code)}`); return driven; }
    if (answer.claimed !== true) { await sleep(waitOf(answer.pollAfterMs, options.pollIdleMs), options.signal); continue; }

    const run = asRun(answer.run);
    if (run === null) { await sleep(options.pollIdleMs, options.signal); continue; }
    options.log(`claimed ${run.id} (${run.task}) on ${run.harness}, budget ${run.timeoutSeconds}s`);
    // The cadence is the Deployment's, carried on the claim it answered.
    const outcome = await drive(options, run, waitOf(answer.heartbeatMs, DEFAULT_HEARTBEAT_MS));
    // A worker that lost its lease writes nothing: the run belongs to whoever
    // holds it now, and a late outcome would be one worker reporting on
    // another's run. The Deployment refuses such a write anyway; not making it
    // is what keeps the two accounts of a run from disagreeing.
    if (outcome.status !== 'lost') {
      await post(options, '/worker/end', { projectId: run.projectId, runId: run.id, status: outcome.status, error: outcome.error });
    }
    driven += 1;
    if (options.once === true) return driven;
  }
  return driven;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const timer = setTimeout(done, ms);
    function done(): void { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); }
    signal.addEventListener('abort', done, { once: true });
  });
}
