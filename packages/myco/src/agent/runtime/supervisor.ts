/**
 * The harness supervisor: one long-lived process that starts a runtime per run.
 *
 * `POST /launch` spawns one child per minted run id, in its own working
 * directory, with the dispatch environment layered over this process's own —
 * the harness image reaches the Claude Code CLI through `PATH` and `HOME`, and
 * a dispatch carries neither. The supervisor's own configuration is removed
 * before the child sees the environment, and where this process is root the
 * child is dropped to an unprivileged user, which is what actually withholds
 * the launch token mounted in the filesystem they share.
 *
 * Each child leads a process group, so the drain's SIGTERM and the overrun
 * SIGKILL reach the agent CLI the runtime starts rather than the runtime alone.
 *
 * A run's own ending is the runtime's to post, and a runtime that dies before
 * it can — killed inside its first second, out of memory, a bad image — leaves
 * a row live until a sweep gives up on it minutes later. The supervisor holds
 * that run's dispatch, so it posts the ending itself, and waits for that post
 * before it leaves.
 *
 * The child's exit code says whether one is owed, and what to say:
 * `RUNTIME_OWN_ENDINGS` are the two the runtime uses for a row that already
 * carries an ending; a runtime that left without claiming names a run this
 * deployment took back, which the Deployment queues a successor for; and every
 * other code is a death it did not describe — a kill, an out-of-memory, a
 * signal inside the boot window, a bundle that would not start. All of those
 * are posted, drain or no drain.
 *
 * The route authenticates before it reads anything: an unauthenticated body is
 * never buffered. The socket's `maxRequestBodySize` answers 413 to an oversize
 * Content-Length body before this handler runs; a chunked body carries no
 * length for it to check, so the authenticated read is bounded here as well.
 * `GET /probe` carries no token and discloses run ids alone.
 *
 * Refusals are the ones this process genuinely cannot serve: a run id it is
 * already running, a body it cannot read, a child that will not start, and
 * anything at all once it is draining. It counts no fleet; the dispatcher's
 * queue is the bound on how much runs at once.
 *
 * The decisions are `supervisor-policy.ts`; this file is mechanism.
 */
import { chownSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MEMBER_PROTOCOL, PROJECT_HEADER, PROTOCOL_HEADER } from '@myco/member/constants.js';
import { NO_RUNTIME_LISTENER } from './runtime-port.js';
import { MAX_RUN_ERROR_CHARS } from './run-store.js';
import { onStopSignals, RUNTIME_EXIT, RUNTIME_OWN_ENDINGS, type ProcessEvents } from './process-signals.js';

export { RUNTIME_EXIT, RUNTIME_OWN_ENDINGS } from './process-signals.js';
import {
  BACKSTOP_RETRY_MS, bearerMatches, childDeadline, childLaunchPlan, decideChildExit, decideLaunch, decideSignal,
  DEFAULT_RUNTIME_USER, LAUNCH_REFUSAL_STATUS, readableBy, type LaunchTools, type RuntimeUser, type SupervisorState,
} from './supervisor-policy.js';

/** The port the supervisor serves on when the operator names none. */
export const DEFAULT_SUPERVISOR_PORT = 8080;

/** Where the supervisor listens when the operator names nothing: nothing publishes this port, and the deployment shares the namespace. */
export const DEFAULT_SUPERVISOR_HOSTNAME = '127.0.0.1';

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
export const SUPERVISOR_ONLY_ENV = [
  'MYCO_HARNESS_TOKEN_FILE', 'MYCO_HARNESS_TOKEN', 'MYCO_SUPERVISOR_PORT',
  'MYCO_WORK_DIR', 'MYCO_HARNESS_ENTRY', 'MYCO_RUNTIME_USER',
] as const;

export class SupervisorStartupError extends Error {}

/** One started child, as this supervisor drives it. */
export interface SpawnedChild {
  pid: number;
  exited: Promise<number>;
  kill(signal: NodeJS.Signals): void;
}

/** What a spawn is asked for. */
export interface SpawnPlan {
  cmd: string[];
  cwd: string;
  env: Record<string, string | undefined>;
}

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
  /** The user each child is dropped to; null when this process is already unprivileged. */
  runAs?: RuntimeUser | null;
  /** The tools this process found for dropping privilege and leading a process group. */
  tools?: LaunchTools;
  /** How long past its own bound a child is left running before it is killed. */
  overrunMarginMs?: number;
  /** How often the kill is offered again to a child that is still there. */
  backstopRetryMs?: number;
  /** How long a launch body may go without a further byte before the read is abandoned. */
  bodyReadTimeoutMs?: number;
  /** How long the whole launch body may take. */
  bodyTotalTimeoutMs?: number;
  /** Where stop signals are listened for. */
  events?: ProcessEvents;
  /** How the process leaves once the drain is complete. */
  exit?: (code: number) => void;
  /** Test seam: how a child is started. */
  spawn?: (plan: SpawnPlan) => SpawnedChild;
}

export interface RunningSupervisor {
  /** The port the socket actually bound. */
  port: number;
  /** Stop serving and stop every child, for a caller that owns this supervisor's lifetime. */
  stop(): Promise<void>;
}

/** Where a run is claimed and closed, as its dispatch named it. */
interface RunControl {
  serverUrl: string;
  token: string;
  projectId: string;
  /** The task the dispatch named, for a close that has to say which one. */
  task: string | null;
}

/** The run-control surface a dispatch carries, or nothing when it names no server. */
export function runControlOf(envVars: Record<string, string>): RunControl | null {
  const serverUrl = envVars.MYCO_SERVER_URL;
  const token = envVars.MYCO_MEMBER_TOKEN;
  const projectId = envVars.MYCO_PROJECT;
  if (!serverUrl || !token || !projectId) return null;
  return { serverUrl: serverUrl.replace(/\/+$/, ''), token, projectId, task: envVars.MYCO_TASK ?? null };
}

/** How a run whose runtime died before it ended is recorded. */
export const RUNTIME_DIED_ERROR = 'the runtime exited before the run ended';

/** How a run whose runtime left without ever claiming it is recorded. */
export const RUNTIME_UNCLAIMED_ERROR = 'the runtime left without claiming the run';

/** How a run whose task this runtime does not have is recorded. */
export const RUNTIME_UNKNOWN_TASK_ERROR = 'the runtime does not know the task';

/** How a run the Deployment refused this runtime's claim on is recorded. */
export const RUNTIME_CLAIM_REFUSED_ERROR = 'the deployment refused the claim';

/**
 * How a run this supervisor stopped before its runtime claimed it is recorded.
 *
 * The Deployment reads this word as a run a deployment ended rather than one
 * the work ended, and queues a fresh run of the same task in its place; the
 * runtime uses it for the same case it can name itself
 * (`RUN_RECLAIMED_ERROR` in `server-runner.ts`).
 */
export const RUNTIME_RECLAIMED_ERROR = 'the platform reclaimed the runtime before the run ended';

/** How long the supervisor gives the post that closes a run its child abandoned. */
const CLOSE_TIMEOUT_MS = 5_000;

/**
 * How long a launch body may go without a further byte, and how long the whole
 * body may take.
 *
 * Both sit inside the deadline the dispatcher gives the launch call
 * (`LAUNCH_TIMEOUT_MS`), so the 408 reaches a real caller as an answer rather
 * than after it has already given up.
 */
export const BODY_READ_TIMEOUT_MS = 2_000;
export const BODY_TOTAL_TIMEOUT_MS = 5_000;

/** Close a run its runtime left open, with that run's own credential. */
async function closeAbandonedRun(
  control: RunControl, runId: string, close: { error: string; replaced: boolean }, now: number,
): Promise<Response> {
  return await fetch(`${control.serverUrl}/runs/update`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${control.token}`,
      [PROTOCOL_HEADER]: String(MEMBER_PROTOCOL),
      [PROJECT_HEADER]: control.projectId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      runId,
      update: { status: 'failed', completed_at: now, error: close.error.slice(0, MAX_RUN_ERROR_CHARS) },
      ...(close.replaced ? { replaced: true } : {}),
    }),
    signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
  });
}

/**
 * What a child's exit leaves for this supervisor to write, or nothing.
 *
 * A successor is queued for one case only: a run this supervisor stopped before
 * its runtime could claim it, which is a run a deployment took away and which
 * runs again unchanged. A task this runtime does not have, and a claim the
 * Deployment refused, fail the same way every time they are tried, and each
 * successor spends one of a Project's few per day — so they are named and left.
 */
export function closeForExit(code: number, draining: boolean, task: string | null): { error: string; replaced: boolean } | null {
  if (RUNTIME_OWN_ENDINGS.has(code)) return null;
  if (code === RUNTIME_EXIT.unclaimed) {
    return draining
      ? { error: RUNTIME_RECLAIMED_ERROR, replaced: true }
      : { error: RUNTIME_UNCLAIMED_ERROR, replaced: false };
  }
  if (code === RUNTIME_EXIT.unknownTask) {
    return { error: `${RUNTIME_UNKNOWN_TASK_ERROR} ${task ?? 'the dispatch named'}`, replaced: false };
  }
  if (code === RUNTIME_EXIT.claimRefused) return { error: RUNTIME_CLAIM_REFUSED_ERROR, replaced: false };
  return { error: `${RUNTIME_DIED_ERROR} (${code})`, replaced: false };
}

/** One run's child process, as the supervisor tracks it. */
interface Child {
  pid: number;
  startedAt: number;
  /** The run's working directory, removed when the child exits. */
  dir: string;
  /** Ask this child, and everything it started, to stop. */
  stop(): void;
  /** Stop offering the kill. */
  cancelBackstop(): void;
  /** Where this run is closed, when its runtime does not close it. */
  control: RunControl | null;
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
export function childEnv(envVars: Record<string, string>, runAs: RuntimeUser | null): Record<string, string | undefined> {
  const inherited: Record<string, string | undefined> = { ...process.env };
  for (const key of SUPERVISOR_ONLY_ENV) delete inherited[key];
  // The CLI a run spawns writes under HOME, and a dropped child cannot write under this process's.
  if (runAs !== null) inherited.HOME = runAs.home;
  return { ...inherited, ...envVars, MYCO_RUNTIME_PORT: NO_RUNTIME_LISTENER };
}

/** Why a body was not read whole: it ran past the bound, or it stopped arriving. */
export type BodyRefusal = 'too-large' | 'stalled';

/**
 * Read a request body up to `limit`, or answer why it was not read.
 *
 * A chunked body declares no length, so the socket's own bound never sees it;
 * this is where such a body stops being read. A caller that sends part of one
 * and then stops is given `timeoutMs` for its next byte and abandoned after it,
 * so a handler is never held by a body that does not end.
 */
export async function readBounded(
  request: Request, limit: number, timeoutMs = BODY_READ_TIMEOUT_MS, totalMs = BODY_TOTAL_TIMEOUT_MS,
): Promise<{ ok: true; text: string } | { ok: false; why: BodyRefusal }> {
  if (request.body === null) return { ok: true, text: '' };
  const reader = request.body.getReader();
  // A caller that keeps sending a byte at a time passes every per-read deadline
  // and never finishes; the whole body has a deadline of its own.
  const by = Date.now() + totalMs;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      let step: { done: boolean; value?: Uint8Array };
      let timer: ReturnType<typeof setTimeout> | undefined;
      const remaining = Math.min(timeoutMs, by - Date.now());
      if (remaining <= 0) return { ok: false, why: 'stalled' };
      try {
        const stalled = new Promise<'stalled'>((resolve) => { timer = setTimeout(() => { resolve('stalled'); }, remaining); });
        const next = await Promise.race([reader.read(), stalled]);
        if (next === 'stalled') return { ok: false, why: 'stalled' };
        step = next;
      } catch {
        return { ok: true, text: '' };
      } finally {
        clearTimeout(timer);
      }
      if (step.done) break;
      if (step.value === undefined) continue;
      size += step.value.byteLength;
      if (size > limit) return { ok: false, why: 'too-large' };
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let at = 0;
  for (const chunk of chunks) { joined.set(chunk, at); at += chunk.byteLength; }
  return { ok: true, text: new TextDecoder().decode(joined) };
}

/** Serve the launch endpoint until a stop signal drains it. */
export function startSupervisor(options: SupervisorOptions): RunningSupervisor {
  const events = options.events ?? process;
  const leaveProcess = options.exit ?? ((code: number) => { process.exit(code); });
  const runtimeCommand = options.runtimeCommand ?? process.execPath;
  const runAs = options.runAs ?? null;
  const tools = options.tools ?? { setsid: null, setpriv: null };
  const retryMs = options.backstopRetryMs ?? BACKSTOP_RETRY_MS;
  const plan = childLaunchPlan({ runtimeCommand, entry: options.entry, tools, runAs });
  const spawn = options.spawn ?? bunSpawn;
  const children = new Map<string, Child>();
  let draining = false;
  let leaving = false;

  const state = (): SupervisorState => ({ draining, running: [...children.keys()] });

  const server = Bun.serve({
    hostname: options.hostname ?? DEFAULT_SUPERVISOR_HOSTNAME,
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
    if (leaving) return;
    leaving = true;
    for (const [runId, child] of children) {
      attempt('backstop', runId, () => { child.cancelBackstop(); });
      stopChild(runId, child);
    }
    children.clear();
    void Promise.resolve(server.stop(true)).then(() => { leaveProcess(code); }, () => { leaveProcess(code); });
  };

  const childExited = async (runId: string, code: number): Promise<void> => {
    const decision = decideChildExit(state(), runId);
    const child = children.get(runId);
    // What the run held goes before the run leaves the map: the probe reports a
    // run released only once its working directory and its kill are gone.
    if (child !== undefined) {
      attempt('backstop', runId, () => { child.cancelBackstop(); });
      attempt('workdir', runId, () => { rmSync(child.dir, { recursive: true, force: true }); });
    }
    children.delete(runId);
    line({ kind: 'supervisor_child_exited', runId, code, running: decision.running.length });
    // A child that ended on its own terms wrote its own status; any other exit
    // left the run open, and this is the only process that can still close it.
    // The post is awaited: this process leaves behind the last child of a drain,
    // so a post that must land has to land before that.
    const close = child?.control == null ? null : closeForExit(code, decision.exit || draining, child.control.task);
    if (close !== null && child?.control != null) {
      try {
        const answered = await closeAbandonedRun(child.control, runId, close, Date.now());
        // A refusal is a 200 carrying `applied: false`: the row kept an ending
        // of its own, or this credential is not the one it names.
        const body = await answered.json().catch(() => null) as { applied?: unknown; reason?: unknown } | null;
        if (body?.applied === true) {
          line({ kind: 'supervisor_run_closed', runId, code, replaced: close.replaced });
        } else {
          line({
            kind: 'supervisor_run_close_refused', runId, code, status: answered.status,
            refusal: typeof body?.reason === 'string' ? body.reason : null,
          });
        }
      } catch (error) {
        line({ kind: 'supervisor_run_close_failed', runId, code, error: error instanceof Error ? error.message : String(error) });
      }
    }
    if (decision.exit) leave(0);
  };

  async function launch(request: Request): Promise<Response> {
    // The token before the body: an unauthenticated caller's body is never read
    // at all, whatever length it declares or declines to.
    if (!bearerMatches(request.headers.get('authorization'), options.token)) return new Response(null, { status: 401 });

    const read = await readBounded(request, MAX_LAUNCH_BODY_BYTES, options.bodyReadTimeoutMs, options.bodyTotalTimeoutMs);
    // Bodiless either way: a caller that sent too much, and one that stopped
    // sending, each learn only that this body was not taken.
    if (!read.ok) return new Response(null, { status: read.why === 'stalled' ? 408 : 413 });
    let parsed: unknown = null;
    try { parsed = JSON.parse(read.text); } catch { parsed = null; }
    const body = (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null) as { runId?: unknown; timeoutSeconds?: unknown; envVars?: unknown } | null;
    const decision = decideLaunch(state(), body?.runId);
    if (!decision.admit) {
      return Response.json({ refusal: decision.refusal }, { status: LAUNCH_REFUSAL_STATUS[decision.refusal] });
    }

    const runId = body!.runId as string;
    const envVars = record(body?.envVars);
    const dir = join(options.workDir, runId);
    let child: SpawnedChild;
    try {
      mkdirSync(dir, { recursive: true });
      // A dropped child owns the directory it works in.
      if (plan.dropped) chownSync(dir, runAs!.uid, runAs!.gid);
      child = spawn({ cmd: [...plan.cmd], cwd: dir, env: childEnv(envVars, runAs) });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      attempt('workdir', runId, () => { rmSync(dir, { recursive: true, force: true }); });
      line({ kind: 'supervisor_launch_failed', runId, error: message });
      return Response.json({ refusal: 'spawn', error: message }, { status: LAUNCH_REFUSAL_STATUS.spawn });
    }

    /** Signal the child's whole tree where it leads one, and the child alone where it does not. */
    const signal = (sig: NodeJS.Signals): void => {
      if (plan.groupLed) {
        try {
          process.kill(-child.pid, sig);
          return;
        } catch { /* no group under this id; the child itself still answers */ }
      }
      child.kill(sig);
    };

    const startedAt = Date.now();
    const timeoutSeconds = Number(body?.timeoutSeconds);
    // A run keeps its own deadline and posts its own ending; this is the floor
    // under a child that reaches neither. The kill is offered again until the
    // child is gone, so a kill that failed does not hold the run id for good.
    let backstop: ReturnType<typeof setTimeout> | undefined;
    const arm = (delay: number): void => {
      backstop = setTimeout(() => {
        line({ kind: 'supervisor_child_overran', runId, pid: child.pid });
        attempt('kill', runId, () => { signal('SIGKILL'); });
        arm(retryMs);
      }, Math.max(0, delay));
      (backstop as { unref?: () => void }).unref?.();
    };
    arm(childDeadline(startedAt, timeoutSeconds, options.overrunMarginMs) - startedAt);

    children.set(runId, {
      pid: child.pid,
      startedAt,
      dir,
      stop: () => { signal('SIGTERM'); },
      cancelBackstop: () => { clearTimeout(backstop); },
      control: runControlOf(envVars),
    });
    line({ kind: 'supervisor_launched', runId, pid: child.pid, timeoutSeconds: Number.isFinite(timeoutSeconds) ? timeoutSeconds : null });
    void child.exited.then((code) => childExited(runId, code), () => childExited(runId, -1));
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

  line({ kind: 'supervisor_children', dropped: plan.dropped, user: runAs?.name ?? null, groupLed: plan.groupLed });

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

/** The shipped spawn: the child's stdio is the container log, where a run's own JSON lines are read. */
function bunSpawn(plan: SpawnPlan): SpawnedChild {
  const child = Bun.spawn({ cmd: plan.cmd, cwd: plan.cwd, env: plan.env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  return { pid: child.pid, exited: child.exited, kill: (signal) => { child.kill(signal); } };
}

/** The user named, as this machine knows it: numeric ids and a home, from the passwd database. */
export function runtimeUserOf(name: string, passwd: string): RuntimeUser | null {
  for (const entry of passwd.split('\n')) {
    const [user, , uid, gid, , home] = entry.split(':');
    if (user !== name) continue;
    const numericUid = Number(uid);
    const numericGid = Number(gid);
    if (!Number.isInteger(numericUid) || !Number.isInteger(numericGid)) return null;
    return { name, uid: numericUid, gid: numericGid, home: home === undefined || home === '' ? '/' : home };
  }
  return null;
}

/**
 * What the operator's environment says this supervisor is.
 *
 * A missing or empty token file is refused by name: the launch endpoint spawns
 * processes with a caller-chosen environment, and it has no token to check
 * against. A root supervisor is refused when it cannot drop its children, and
 * when the user it drops them to can read that token anyway.
 */
export function supervisorOptionsFromEnv(
  env: Record<string, string | undefined> = process.env,
  machine: { uid?: number; tools?: LaunchTools; passwd?: () => string } = {},
): SupervisorOptions {
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

  const tools: LaunchTools = machine.tools ?? { setsid: Bun.which('setsid'), setpriv: Bun.which('setpriv') };
  const userName = env.MYCO_RUNTIME_USER === undefined || env.MYCO_RUNTIME_USER === '' ? DEFAULT_RUNTIME_USER : env.MYCO_RUNTIME_USER;
  let runAs: RuntimeUser | null = null;
  // Only a root supervisor has a privilege to drop; one already unprivileged
  // shares its own user with its children and says so.
  if ((machine.uid ?? process.getuid?.()) === 0) {
    if (tools.setpriv === null) {
      throw new SupervisorStartupError('this supervisor runs as root and setpriv is not on its PATH, so a child cannot be dropped to an unprivileged user');
    }
    const readPasswd = machine.passwd ?? (() => {
      try { return readFileSync('/etc/passwd', 'utf8'); } catch { return ''; }
    });
    runAs = runtimeUserOf(userName, readPasswd());
    if (runAs === null) throw new SupervisorStartupError(`MYCO_RUNTIME_USER names ${userName}, which this machine has no account for`);
    const file = statSync(tokenPath);
    if (readableBy({ mode: file.mode, uid: file.uid, gid: file.gid }, runAs)) {
      throw new SupervisorStartupError(`MYCO_HARNESS_TOKEN_FILE names ${tokenPath}, which ${userName} can read; a child dropped to that user would hold the launch token`);
    }
  }

  return {
    token,
    entry,
    port,
    tools,
    runAs,
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
