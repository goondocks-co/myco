/**
 * The harness supervisor: one long-lived process that starts a runtime per run.
 *
 * `POST /launch` spawns one child per minted run id, in its own working
 * directory, with the dispatch environment layered over this process's own —
 * the harness image reaches the Claude Code CLI through `PATH` and `HOME`, and
 * a dispatch carries neither. The supervisor's own configuration, the launch
 * token among it, is removed before the child sees the environment.
 *
 * The route is authenticated before it reads anything, and the body it reads is
 * bounded. `GET /probe` carries no token and discloses run ids alone.
 *
 * Refusals are the ones this process genuinely cannot serve: a run id it is
 * already running, a body it cannot read, a child that will not start, and
 * anything at all once it is draining. It counts no fleet; the dispatcher's
 * queue is the bound on how much runs at once.
 *
 * The decisions are `supervisor-policy.ts`; this file is mechanism.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_RUNTIME_LISTENER } from './runtime-port.js';
import { onStopSignals, type ProcessEvents } from './process-signals.js';
import {
  bearerMatches, childDeadline, decideChildExit, decideLaunch, decideSignal,
  LAUNCH_REFUSAL_STATUS, type SupervisorState,
} from './supervisor-policy.js';

/** The port the supervisor serves on when the operator names none. */
export const DEFAULT_SUPERVISOR_PORT = 8080;

/**
 * How much of a launch body this supervisor reads.
 *
 * A launch carries a run id, a bound and the dispatch environment; the prompt a
 * task runs on rides the run row, never this route.
 */
export const MAX_LAUNCH_BODY_BYTES = 327_680;

/** The runtime bundle a launch runs, relative to this file, when the operator names none. */
const DEFAULT_ENTRY = './entry.js';

/** This supervisor's own configuration, which its children are not given. */
const SUPERVISOR_ONLY_ENV = [
  'MYCO_HARNESS_TOKEN_FILE', 'MYCO_HARNESS_TOKEN', 'MYCO_SUPERVISOR_PORT', 'MYCO_WORK_DIR', 'MYCO_HARNESS_ENTRY',
] as const;

class SupervisorStartupError extends Error {}

export interface SupervisorOptions {
  /** The bearer token every launch must present. */
  token: string;
  /** The runtime bundle each child runs. */
  entry: string;
  /** Directory the per-run working directories are made under. */
  workDir: string;
  port?: number;
  hostname?: string;
  /** The runtime that executes `entry`; this process's own by default, which is what the image installs. */
  runtimeCommand?: string;
  /** How long past its own bound a child is left running before it is killed. */
  overrunMarginMs?: number;
  /** Where stop signals are listened for. */
  events?: ProcessEvents;
  /** How the process leaves once the drain is complete. */
  exit?: (code: number) => void;
}

export interface RunningSupervisor {
  /** The port the socket actually bound. */
  port: number;
  /** Stop serving and stop every child, for a caller that owns this supervisor's lifetime. */
  stop(): Promise<void>;
}

/** One run's child process, as the supervisor tracks it. */
interface Child {
  pid: number;
  startedAt: number;
  /** The run's working directory, removed when the child exits. */
  dir: string;
  /** Ask this child to stop, as a platform would. */
  stop(): void;
  /** Stop waiting for this child to go. */
  cancelBackstop(): void;
}

const line = (fields: Record<string, unknown>): void => { console.log(JSON.stringify(fields)); };

/** Run one piece of cleanup; a failure is logged and the caller carries on. */
function attempt(what: string, runId: string, act: () => void): void {
  try {
    act();
  } catch (error) {
    line({ kind: 'supervisor_cleanup_failed', what, runId, error: error instanceof Error ? error.message : String(error) });
  }
}

const record = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
  );
};

/** The environment a child is given: this process's, less its own configuration, plus the dispatch. */
function childEnv(envVars: Record<string, string>): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = { ...process.env };
  for (const key of SUPERVISOR_ONLY_ENV) delete inherited[key];
  return { ...inherited, ...envVars, MYCO_RUNTIME_PORT: NO_RUNTIME_LISTENER };
}

/** Serve the launch endpoint until a stop signal drains it. */
export function startSupervisor(options: SupervisorOptions): RunningSupervisor {
  const events = options.events ?? process;
  const leaveProcess = options.exit ?? ((code: number) => { process.exit(code); });
  const runtimeCommand = options.runtimeCommand ?? process.execPath;
  const children = new Map<string, Child>();
  let draining = false;

  const state = (): SupervisorState => ({ draining, running: [...children.keys()] });

  const server = Bun.serve({
    // Nothing publishes this port; the deployment reaches it over the loopback
    // of the network namespace both share.
    hostname: options.hostname ?? '127.0.0.1',
    port: options.port ?? DEFAULT_SUPERVISOR_PORT,
    development: false,
    maxRequestBodySize: MAX_LAUNCH_BODY_BYTES,
    // Bodiless: the runtime's own fallback page embeds the thrown message and
    // surrounding source.
    error: () => new Response(null, { status: 500 }),
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      if (path === '/probe') {
        return Response.json({
          ok: true,
          draining,
          children: [...children.entries()].map(([runId, child]) => ({ runId, pid: child.pid, startedAt: child.startedAt })),
        });
      }
      if (path === '/launch' && request.method === 'POST') return launch(request);
      return new Response('not found', { status: 404 });
    },
  });

  const stopChild = (runId: string, child: Child): void => {
    attempt('stop', runId, () => { child.stop(); });
  };

  const leave = (code: number): void => {
    for (const [runId, child] of children) stopChild(runId, child);
    void Promise.resolve(server.stop(true)).then(() => { leaveProcess(code); }, () => { leaveProcess(code); });
  };

  const childExited = (runId: string, code: number): void => {
    const decision = decideChildExit(state(), runId);
    const child = children.get(runId);
    children.delete(runId);
    if (child !== undefined) {
      attempt('backstop', runId, () => { child.cancelBackstop(); });
      attempt('workdir', runId, () => { rmSync(child.dir, { recursive: true, force: true }); });
    }
    line({ kind: 'supervisor_child_exited', runId, code, running: decision.running.length });
    if (decision.exit) leave(0);
  };

  async function launch(request: Request): Promise<Response> {
    // The token before the body: an unauthenticated caller is answered without
    // this process reading what it sent. The bounded body is drained first so
    // the answer is not written while the caller is still sending it.
    if (!bearerMatches(request.headers.get('authorization'), options.token)) {
      await request.text().catch(() => '');
      return new Response(null, { status: 401 });
    }

    const raw = await request.text().catch(() => '');
    let parsed: unknown = null;
    try { parsed = JSON.parse(raw); } catch { parsed = null; }
    const body = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null) as { runId?: unknown; timeoutSeconds?: unknown; envVars?: unknown } | null;
    const decision = decideLaunch(state(), body?.runId);
    if (!decision.admit) {
      return Response.json({ refusal: decision.refusal }, { status: LAUNCH_REFUSAL_STATUS[decision.refusal] });
    }

    const runId = body!.runId as string;
    const dir = join(options.workDir, runId);
    let child: ReturnType<typeof Bun.spawn>;
    try {
      mkdirSync(dir, { recursive: true });
      child = Bun.spawn({
        cmd: [runtimeCommand, options.entry],
        cwd: dir,
        env: childEnv(record(body?.envVars)),
        // The container log is where a run's own JSON lines are read.
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempt('workdir', runId, () => { rmSync(dir, { recursive: true, force: true }); });
      line({ kind: 'supervisor_launch_failed', runId, error: message });
      return Response.json({ refusal: 'spawn', error: message }, { status: LAUNCH_REFUSAL_STATUS.spawn });
    }

    const startedAt = Date.now();
    const timeoutSeconds = Number(body?.timeoutSeconds);
    // A run keeps its own deadline and posts its own ending; this is the floor
    // under a child that reaches neither, so its run id is released and its
    // working directory goes.
    const backstop = setTimeout(() => {
      line({ kind: 'supervisor_child_overran', runId, pid: child.pid });
      attempt('kill', runId, () => { child.kill('SIGKILL'); });
    }, Math.max(0, childDeadline(startedAt, timeoutSeconds, options.overrunMarginMs) - startedAt));
    (backstop as { unref?: () => void }).unref?.();

    children.set(runId, {
      pid: child.pid,
      startedAt,
      dir,
      stop: () => { child.kill('SIGTERM'); },
      cancelBackstop: () => { clearTimeout(backstop); },
    });
    line({ kind: 'supervisor_launched', runId, pid: child.pid, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null });
    void child.exited.then((code) => { childExited(runId, code); }, () => { childExited(runId, -1); });
    return Response.json({ runId, pid: child.pid }, { status: 202 });
  }

  onStopSignals(events, () => {
    const decision = decideSignal(state());
    line({ kind: 'supervisor_draining', holding: decision.action === 'drain' ? decision.stop : [] });
    if (decision.action === 'exit') { leave(0); return; }
    draining = true;
    for (const runId of decision.stop) {
      const child = children.get(runId);
      if (child !== undefined) stopChild(runId, child);
    }
  });

  return {
    port: Number(server.port),
    stop: async () => {
      for (const [runId, child] of children) {
        attempt('backstop', runId, () => { child.cancelBackstop(); });
        stopChild(runId, child);
      }
      children.clear();
      await server.stop(true);
    },
  };
}

/**
 * What the operator's environment says this supervisor is.
 *
 * A missing or empty token file is refused by name: the launch endpoint spawns
 * processes with a caller-chosen environment, and it has no token to check
 * against.
 */
export function supervisorOptionsFromEnv(env: Record<string, string | undefined> = process.env): SupervisorOptions {
  const tokenPath = env.MYCO_HARNESS_TOKEN_FILE;
  if (tokenPath === undefined || tokenPath === '') {
    throw new SupervisorStartupError('MYCO_HARNESS_TOKEN_FILE is not set, and the launch endpoint is authenticated');
  }
  let text: string;
  try {
    text = readFileSync(tokenPath, 'utf8');
  } catch (err) {
    throw new SupervisorStartupError(`MYCO_HARNESS_TOKEN_FILE names ${tokenPath}, which cannot be read: ${(err as Error).message}`);
  }
  const token = text.trim();
  if (token === '') throw new SupervisorStartupError(`MYCO_HARNESS_TOKEN_FILE names ${tokenPath}, which is empty`);

  const rawPort = env.MYCO_SUPERVISOR_PORT;
  const port = rawPort === undefined || rawPort === '' ? DEFAULT_SUPERVISOR_PORT : Number(rawPort);
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new SupervisorStartupError(`MYCO_SUPERVISOR_PORT must be a port, and is ${JSON.stringify(rawPort)}`);
  }

  const entry = env.MYCO_HARNESS_ENTRY === undefined || env.MYCO_HARNESS_ENTRY === ''
    ? fileURLToPath(new URL(DEFAULT_ENTRY, import.meta.url))
    : env.MYCO_HARNESS_ENTRY;

  return {
    token,
    entry,
    port,
    workDir: env.MYCO_WORK_DIR === undefined || env.MYCO_WORK_DIR === '' ? tmpdir() : env.MYCO_WORK_DIR,
  };
}

if (import.meta.main) {
  try {
    const running = startSupervisor(supervisorOptionsFromEnv());
    line({ kind: 'supervisor_up', port: running.port });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // One line, no stack: a stack in a container log discloses paths and
    // surrounding source to whoever can read the log.
    process.stderr.write(`myco harness supervisor failed to start: ${message}\n`);
    process.exit(1);
  }
}
