/**
 * The harness supervisor: one long-lived process that starts a runtime per run.
 *
 * The self-hosted stack has no per-run container. The Docker socket is what a
 * container-per-run would need inside the server container, and the image
 * refuses it, so the run stays the unit of work in a different shape: one
 * minted run id becomes one child process, in its own working directory, with
 * the dispatch environment layered over this process's own. The layering is
 * load-bearing — the harness image reaches the Claude Code CLI through `PATH`
 * and `HOME` alone.
 *
 * Nothing here counts a fleet. The dispatcher's queue holds a dispatch that is
 * at the operator's limit and launches it as capacity returns; a refusal from
 * this endpoint is a terminal `failed` row instead, so a second count here
 * would fail what the queue admitted. This refuses only what it genuinely
 * cannot do: a run id it is already running, a body it cannot read, a child
 * that will not start, and anything at all once it is draining.
 *
 * `/launch` spawns a process with a caller-chosen environment, and the network
 * namespace it serves on holds the runtimes themselves. It is authenticated:
 * the bearer token comes from a file the operator mounts, and a supervisor
 * without one refuses to start.
 *
 * The decisions are `supervisor-policy.ts`; this file is mechanism.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NO_RUNTIME_LISTENER } from './runtime-port.js';
import { RUNTIME_STOP_SIGNALS, type ProcessEvents } from './process-signals.js';
import {
  bearerMatches, decideChildExit, decideLaunch, decideSignal,
  LAUNCH_REFUSAL_STATUS, type SupervisorState,
} from './supervisor-policy.js';

/** The port the supervisor serves on when the operator names none. */
export const DEFAULT_SUPERVISOR_PORT = 8080;

/** The runtime bundle a launch runs, relative to this file, when the operator names none. */
const DEFAULT_ENTRY = './entry.js';

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
}

const line = (fields: Record<string, unknown>): void => { console.log(JSON.stringify(fields)); };

const record = (value: unknown): Record<string, string> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, String(entry)]),
  );
};

/**
 * Serve the launch endpoint until a stop signal drains it.
 *
 * The socket binds every address in this process's network namespace: the
 * supervisor is reached by the server sharing that namespace, and a namespace
 * with no published port of its own is the boundary.
 */
export function startSupervisor(options: SupervisorOptions): RunningSupervisor {
  const events = options.events ?? process;
  const leaveProcess = options.exit ?? ((code: number) => { process.exit(code); });
  const runtimeCommand = options.runtimeCommand ?? process.execPath;
  const children = new Map<string, Child>();
  let draining = false;

  const state = (): SupervisorState => ({ draining, running: [...children.keys()] });

  const server = Bun.serve({
    port: options.port ?? DEFAULT_SUPERVISOR_PORT,
    hostname: options.hostname ?? '0.0.0.0',
    development: false,
    fetch: async (request) => {
      const path = new URL(request.url).pathname;
      // The probe discloses run ids and nothing else, and is what a
      // healthcheck and an operator read; it carries no token.
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

  const leave = (code: number): void => {
    for (const child of children.values()) child.stop();
    void Promise.resolve(server.stop(true)).then(() => { leaveProcess(code); }, () => { leaveProcess(code); });
  };

  const childExited = (runId: string, code: number): void => {
    const decision = decideChildExit(state(), runId);
    const child = children.get(runId);
    children.delete(runId);
    if (child !== undefined) rmSync(child.dir, { recursive: true, force: true });
    line({ kind: 'supervisor_child_exited', runId, code, running: decision.running.length });
    if (decision.exit) leave(0);
  };

  async function launch(request: Request): Promise<Response> {
    // Read before deciding: an answer written while the caller is still sending
    // its body resets the connection rather than carrying the answer.
    const raw = await request.text().catch(() => '');
    // Bodiless: a distinguishing message tells a caller which half of the
    // credential it got wrong.
    if (!bearerMatches(request.headers.get('authorization'), options.token)) return new Response(null, { status: 401 });

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
        // This process's environment first: the image puts the CLI the harness
        // spawns on `PATH`, under a `HOME` the CLI writes to, and a dispatch
        // carries neither.
        env: { ...process.env, ...record(body?.envVars), MYCO_RUNTIME_PORT: NO_RUNTIME_LISTENER },
        // The container log is where a run's own JSON lines are read.
        stdin: 'ignore',
        stdout: 'inherit',
        stderr: 'inherit',
      });
    } catch (error) {
      rmSync(dir, { recursive: true, force: true });
      const message = error instanceof Error ? error.message : String(error);
      line({ kind: 'supervisor_launch_failed', runId, error: message });
      return Response.json({ refusal: 'spawn', error: message }, { status: LAUNCH_REFUSAL_STATUS.spawn });
    }

    children.set(runId, {
      pid: child.pid,
      startedAt: Date.now(),
      dir,
      stop: () => { child.kill('SIGTERM'); },
    });
    line({ kind: 'supervisor_launched', runId, pid: child.pid, timeoutSeconds: Number(body?.timeoutSeconds) || null });
    void child.exited.then((code) => { childExited(runId, code); }, () => { childExited(runId, -1); });
    return Response.json({ runId, pid: child.pid }, { status: 202 });
  }

  const signalled = (): void => {
    const decision = decideSignal(state());
    line({ kind: 'supervisor_draining', holding: decision.action === 'drain' ? decision.stop : [] });
    if (decision.action === 'exit') { leave(0); return; }
    draining = true;
    for (const runId of decision.stop) children.get(runId)?.stop();
  };
  for (const signal of RUNTIME_STOP_SIGNALS) events.on(signal, signalled);

  return {
    port: Number(server.port),
    stop: async () => {
      for (const child of children.values()) child.stop();
      children.clear();
      await server.stop(true);
    },
  };
}

/**
 * What the operator's environment says this supervisor is.
 *
 * A missing or empty token file is refused by name here rather than at the
 * first launch: a supervisor that started without one would serve an endpoint
 * that spawns processes for any caller that reaches its namespace.
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
