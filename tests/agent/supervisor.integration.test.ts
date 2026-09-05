/**
 * The harness supervisor as a running process: a socket, real children, and a
 * drain.
 *
 * The self-hosted stack has no per-run container, so the properties a container
 * gave for free are the ones proved here — two runs execute at once in one
 * namespace, one run id starts one runtime, an unauthenticated caller starts
 * nothing, and a stop signal lets the runs in flight finish before the process
 * leaves.
 *
 * The children are stand-in runtimes: they write the environment they were
 * handed and then wait for the signal the supervisor forwards.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { platform } from 'node:os';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  closeForExit, DEFAULT_SUPERVISOR_HOSTNAME, MAX_LAUNCH_BODY_BYTES, RUNTIME_CLAIM_REFUSED_ERROR, RUNTIME_DIED_ERROR,
  RUNTIME_RECLAIMED_ERROR, RUNTIME_UNCLAIMED_ERROR, RUNTIME_UNKNOWN_TASK_ERROR,
  startSupervisor, supervisorOptionsFromEnv, SUPERVISOR_ONLY_ENV,
  type RunningSupervisor, type SpawnedChild, type SpawnPlan,
} from '@myco/agent/runtime/supervisor.js';
import { RUNTIME_EXIT, RUNTIME_OWN_ENDINGS } from '@myco/agent/runtime/process-signals.js';

const TOKEN = 'supervisor-token';

/**
 * A stand-in runtime: it records the environment and working directory it was
 * given, and then holds until the supervisor asks it to stop.
 */
const STAND_IN = `
import { existsSync, writeFileSync } from 'node:fs';
const out = process.env.STANDIN_OUT;
if (out !== undefined && out !== '') {
  await Bun.write(out, JSON.stringify({ env: { ...process.env }, cwd: process.cwd() }));
}
if (process.env.STANDIN_EXIT_CODE !== undefined) process.exit(Number(process.env.STANDIN_EXIT_CODE));
if (process.env.STANDIN_GRANDCHILD !== undefined) {
  const kid = Bun.spawn(['sleep', '300'], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' });
  await Bun.write(process.env.STANDIN_GRANDCHILD, String(kid.pid));
}
if (process.env.STANDIN_EXIT_MS !== undefined) {
  setTimeout(() => { process.exit(0); }, Number(process.env.STANDIN_EXIT_MS));
}
process.on('SIGTERM', () => {
  if (process.env.STANDIN_IGNORE_SIGTERM !== undefined) return;
  const hold = process.env.STANDIN_HOLD_SIGTERM;
  if (hold === undefined) { process.exit(0); return; }
  // Say the signal arrived, then keep running until released or the window ends,
  // so a caller can observe the drain with this child provably still alive.
  writeFileSync(hold + '.signalled', '1');
  const code = process.env.STANDIN_EXIT_ON_SIGTERM === undefined ? 0 : Number(process.env.STANDIN_EXIT_ON_SIGTERM);
  const deadline = Date.now() + 5_000;
  const waiting = setInterval(() => {
    if (existsSync(hold + '.release') || Date.now() > deadline) { clearInterval(waiting); process.exit(code); }
  }, 20);
});
setInterval(() => {}, 60_000);
`;

const roots: string[] = [];
const running: RunningSupervisor[] = [];

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), 'myco-supervisor-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  for (const supervisor of running.splice(0)) await supervisor.stop();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Booted {
  supervisor: RunningSupervisor;
  root: string;
  workDir: string;
  /** The stop signals the process would have received, as the supervisor listens for them. */
  signal(name?: 'SIGTERM' | 'SIGINT'): void;
  /** The exit codes the process would have left with. */
  exits: number[];
  launch(body: unknown, token?: string | null): Promise<Response>;
  probe(): Promise<{ ok: boolean; draining: boolean; children: { runId: string; pid: number; startedAt: number }[] }>;
}

function boot(options: { entry?: string; runtimeCommand?: string; overrunMarginMs?: number; backstopRetryMs?: number; bodyReadTimeoutMs?: number; spawn?: (plan: SpawnPlan) => SpawnedChild; hostname?: string | null; tools?: { setsid: string | null; setpriv: string | null }; runAs?: { name: string; uid: number; gid: number; home: string } } = {}): Booted {
  const root = scratch();
  const workDir = join(root, 'work');
  const entry = options.entry ?? join(root, 'stand-in.js');
  if (options.entry === undefined) writeFileSync(entry, STAND_IN);

  const listeners = new Map<string, () => void>();
  const exits: number[] = [];
  const supervisor = startSupervisor({
    token: TOKEN,
    entry,
    workDir,
    ...(options.runtimeCommand === undefined ? {} : { runtimeCommand: options.runtimeCommand }),
    ...(options.overrunMarginMs === undefined ? {} : { overrunMarginMs: options.overrunMarginMs }),
    ...(options.bodyReadTimeoutMs === undefined ? {} : { bodyReadTimeoutMs: options.bodyReadTimeoutMs }),
    ...(options.backstopRetryMs === undefined ? {} : { backstopRetryMs: options.backstopRetryMs }),
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
    ...(options.tools === undefined ? {} : { tools: options.tools }),
    ...(options.runAs === undefined ? {} : { runAs: options.runAs }),
    port: 0,
    ...(options.hostname === null ? {} : { hostname: options.hostname ?? '127.0.0.1' }),
    events: { on: (event: string, listener: () => void) => listeners.set(event, listener) },
    exit: (code: number) => { exits.push(code); },
  });
  running.push(supervisor);

  const base = `http://127.0.0.1:${supervisor.port}`;
  return {
    supervisor, root, workDir, exits,
    signal: (name = 'SIGTERM') => { listeners.get(name)?.(); },
    launch: (body, token = TOKEN) => fetch(`${base}/launch`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token === null ? {} : { authorization: `Bearer ${token}` }) },
      body: JSON.stringify(body),
    }),
    probe: async () => await (await fetch(`${base}/probe`)).json() as never,
  };
}

/** Wait for a condition the supervisor's children settle into. */
async function until(condition: () => boolean | Promise<boolean>, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const handed = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { env: Record<string, string>; cwd: string };

/**
 * A launch sent as a chunked body over a raw socket.
 *
 * A chunked body declares no length, so the socket's own `maxRequestBodySize`
 * never sees it. Sending stops the moment an answer arrives, so what was
 * written is what the supervisor made this caller send before answering.
 */
async function chunkedLaunch(port: number, options: { token: string | null; totalBytes: number; stallAfter?: boolean }): Promise<{ status: number; written: number }> {
  let response = '';
  const socket = await Bun.connect({
    hostname: '127.0.0.1',
    port,
    socket: {
      data: (_s, buffer) => { response += buffer.toString(); },
      error: () => undefined,
      close: () => undefined,
    },
  });
  socket.write([
    'POST /launch HTTP/1.1',
    `host: 127.0.0.1:${port}`,
    ...(options.token === null ? [] : [`authorization: Bearer ${options.token}`]),
    'content-type: application/json',
    'transfer-encoding: chunked',
    '', '',
  ].join('\r\n'));

  const size = 16_384;
  const piece = 'x'.repeat(size);
  let written = 0;
  while (written < options.totalBytes && response === '') {
    socket.write(`${size.toString(16)}\r\n${piece}\r\n`);
    written += size;
    await Bun.sleep(1);
  }
  // A caller that sends part of a body and then goes quiet, without ever
  // closing: the socket stays open and nothing more arrives.
  const deadline = Date.now() + (options.stallAfter === true ? 10_000 : 5_000);
  while (response === '' && Date.now() < deadline) await Bun.sleep(10);
  socket.end();
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(response)?.[1] ?? 0), written };
}

describe('launching a runtime', () => {
  it('starts a child with the dispatch layered over its own environment, and no listener of its own', async () => {
    const s = boot();
    const out = join(s.root, 'one.json');

    const answered = await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: { STANDIN_OUT: out, MYCO_RUN_ID: 'run_1' } });
    expect(answered.status).toBe(202);
    expect(await answered.json()).toMatchObject({ runId: 'run_1' });

    await until(() => existsSync(out), 'the child to record its environment');
    const child = handed(out);
    // The dispatch's own values, the no-listener word, and the supervisor's
    // environment the harness image reaches the CLI through.
    expect(child.env.MYCO_RUN_ID).toBe('run_1');
    expect(child.env.MYCO_RUNTIME_PORT).toBe('none');
    expect(child.env.PATH).toBe(process.env.PATH!);
    expect(child.env.HOME).toBe(process.env.HOME!);
    expect(child.cwd).toBe(join(realpathSync(s.workDir), 'run_1'));
  });

  it('keeps the supervisor\'s own configuration out of the child, the launch token first among it', async () => {
    const s = boot();
    const out = join(s.root, 'secrets.json');
    // Every name the supervisor reads for itself, taken from the list it
    // actually strips rather than from a copy in this test.
    const held = Object.fromEntries(SUPERVISOR_ONLY_ENV.map((name) => [name, `held-${name}`]));
    Object.assign(process.env, held);
    try {
      expect((await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: { STANDIN_OUT: out } })).status).toBe(202);
      await until(() => existsSync(out), 'the child to record its environment');
      const child = handed(out);
      for (const key of Object.keys(held)) expect({ key, given: child.env[key] }).toEqual({ key, given: undefined });
      // What the image supplies is still there.
      expect(child.env.PATH).toBe(process.env.PATH!);
      expect(child.env.HOME).toBe(process.env.HOME!);
    } finally {
      for (const key of Object.keys(held)) delete process.env[key];
    }
  });

  it('releases the run and its working directory when a child ends on its own', async () => {
    const s = boot();
    const out = join(s.root, 'short.json');
    expect((await s.launch({ runId: 'run_short', timeoutSeconds: 120, envVars: { STANDIN_OUT: out, STANDIN_EXIT_MS: '30' } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');
    const runDir = handed(out).cwd;

    await until(async () => (await s.probe()).children.length === 0, 'the run to be released');
    expect(existsSync(runDir)).toBe(false);
    // A supervisor that is not draining outlives its children and keeps serving.
    expect(s.exits).toEqual([]);
    expect((await s.launch({ runId: 'run_after', timeoutSeconds: 120, envVars: {} })).status).toBe(202);
  });

  it('kills a child that outlives its bound and releases the run it held', async () => {
    const s = boot({ overrunMarginMs: 150 });
    const out = join(s.root, 'overrun.json');
    expect((await s.launch({ runId: 'run_over', timeoutSeconds: 0, envVars: { STANDIN_OUT: out, STANDIN_IGNORE_SIGTERM: '1' } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');
    const runDir = handed(out).cwd;

    await until(async () => (await s.probe()).children.length === 0, 'the overrunning child to be killed');
    expect(existsSync(runDir)).toBe(false);
  });

  it('runs two dispatches at once, which is what one shared namespace has to allow', async () => {
    const s = boot();
    const first = join(s.root, 'first.json');
    const second = join(s.root, 'second.json');

    const [a, b] = await Promise.all([
      s.launch({ runId: 'run_a', timeoutSeconds: 120, envVars: { STANDIN_OUT: first } }),
      s.launch({ runId: 'run_b', timeoutSeconds: 120, envVars: { STANDIN_OUT: second } }),
    ]);
    expect([a.status, b.status]).toEqual([202, 202]);

    await until(() => existsSync(first) && existsSync(second), 'both children to run');
    const probe = await s.probe();
    expect(probe.draining).toBe(false);
    expect(probe.children.map((c) => c.runId).sort()).toEqual(['run_a', 'run_b']);
    // Each run has its own working directory, and its own process.
    expect(handed(first).cwd).not.toBe(handed(second).cwd);
    expect(new Set(probe.children.map((c) => c.pid)).size).toBe(2);
  });

  it('refuses a second launch of a run it is already running', async () => {
    const s = boot();
    expect((await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: {} })).status).toBe(202);

    const again = await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: {} });
    expect(again.status).toBe(409);
    expect(await again.json()).toEqual({ refusal: 'duplicate' });
    expect((await s.probe()).children).toHaveLength(1);
  });

  it('refuses a body that names no run rather than making a directory out of it', async () => {
    const s = boot();
    const answered = await s.launch({ runId: '../escape', timeoutSeconds: 120, envVars: {} });
    expect(answered.status).toBe(400);
    expect(await answered.json()).toEqual({ refusal: 'invalid' });
    expect((await s.probe()).children).toEqual([]);
  });

  it('refuses a spawn it cannot perform, naming the failure, and holds no run for it', async () => {
    const s = boot({ runtimeCommand: join(tmpdir(), 'myco-supervisor-absent-runtime') });
    const answered = await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: {} });
    expect(answered.status).toBe(500);
    const body = await answered.json() as { refusal: string; error: string };
    expect(body.refusal).toBe('spawn');
    expect(body.error.length).toBeGreaterThan(0);
    expect((await s.probe()).children).toEqual([]);
    expect(existsSync(join(s.workDir, 'run_1'))).toBe(false);
  });
});

describe('who may launch', () => {
  it('answers a launch carrying no token bodilessly, and starts nothing', async () => {
    const s = boot();
    const answered = await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: {} }, null);
    expect(answered.status).toBe(401);
    expect(await answered.text()).toBe('');
    expect((await s.probe()).children).toEqual([]);
  });

  it('answers a launch carrying the wrong token the same way', async () => {
    const s = boot();
    expect((await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: {} }, 'other')).status).toBe(401);
    expect((await s.probe()).children).toEqual([]);
  });

  it('strips every name its own startup reads, so a new one cannot reach a child unnoticed', () => {
    // The names `supervisorOptionsFromEnv` reads, as its source reads them.
    const source = readFileSync(fileURLToPath(new URL('../../packages/myco/src/agent/runtime/supervisor.ts', import.meta.url)), 'utf8');
    const startup = source.slice(source.indexOf('export function supervisorOptionsFromEnv'));
    const read = [...startup.matchAll(/\benv\.(MYCO_[A-Z_]+)\b/g)].map((m) => m[1]!);
    expect(read.length).toBeGreaterThan(0);
    expect([...new Set(read)].filter((name) => !(SUPERVISOR_ONLY_ENV as readonly string[]).includes(name))).toEqual([]);
  });

  it('refuses a body larger than a launch can be, without starting anything', async () => {
    const s = boot();
    const oversize = 'x'.repeat(MAX_LAUNCH_BODY_BYTES + 1_024);
    const answered = await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: { PADDING: oversize } });
    expect(answered.status).toBe(413);
    expect((await s.probe()).children).toEqual([]);
  });

  it('leaves the connection usable after a refusal, so the next launch on it is answered', async () => {
    const s = boot();
    const padded = { runId: 'run_1', timeoutSeconds: 120, envVars: { PADDING: 'x'.repeat(64_000) } };
    expect((await s.launch(padded, null)).status).toBe(401);
    // The same client, the same pooled connection.
    expect((await s.launch(padded)).status).toBe(202);
    expect((await s.probe()).children.map((c) => c.runId)).toEqual(['run_1']);
  });

  it('answers an unauthenticated chunked body without buffering it', async () => {
    const s = boot();
    const sent = await chunkedLaunch(s.supervisor.port, { token: null, totalBytes: MAX_LAUNCH_BODY_BYTES * 8 });
    expect(sent.status).toBe(401);
    // The answer did not wait on the body, so the caller never got to send one.
    expect(sent.written).toBeLessThan(MAX_LAUNCH_BODY_BYTES);
    expect((await s.probe()).children).toEqual([]);
  });

  it('bounds an authenticated chunked body, which the socket\'s own bound never sees', async () => {
    const s = boot();
    const sent = await chunkedLaunch(s.supervisor.port, { token: TOKEN, totalBytes: MAX_LAUNCH_BODY_BYTES * 8 });
    expect(sent.status).toBe(413);
    // The read stopped at the bound rather than running to what the caller meant to send.
    expect(sent.written).toBeGreaterThan(MAX_LAUNCH_BODY_BYTES);
    expect(sent.written).toBeLessThan(MAX_LAUNCH_BODY_BYTES * 2);
    expect((await s.probe()).children).toEqual([]);
  });

  it('abandons a body that stops arriving rather than holding the handler on it', async () => {
    const s = boot({ bodyReadTimeoutMs: 150 });
    const stalled = await chunkedLaunch(s.supervisor.port, { token: TOKEN, totalBytes: 32_768, stallAfter: true });
    expect(stalled.status).toBe(408);
    expect((await s.probe()).children).toEqual([]);
    // The supervisor is still serving; only that one body was let go.
    expect((await s.launch({ runId: 'run_after_stall', timeoutSeconds: 120, envVars: {} })).status).toBe(202);
  });

  it('serves the probe to anyone: it discloses run ids and nothing else', async () => {
    const s = boot();
    const probe = await fetch(`http://127.0.0.1:${s.supervisor.port}/probe`);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ ok: true, draining: false, children: [] });
  });
});

describe('a stop signal', () => {
  it('drains: the runs in flight keep going, new ones are refused, and the process leaves with the last child', async () => {
    const s = boot();
    const out = join(s.root, 'draining.json');
    // The child holds its stop signal until released, so the drain is observed
    // with the run provably still in flight rather than in whatever window a
    // machine happens to leave between the signal and the child's exit.
    const hold = join(s.root, 'hold');
    expect((await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: { STANDIN_OUT: out, STANDIN_HOLD_SIGTERM: hold } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');
    const runDir = handed(out).cwd;

    s.signal();
    await until(() => existsSync(`${hold}.signalled`), 'the child to receive the stop signal');

    const probe = await s.probe();
    expect(probe.draining).toBe(true);
    expect(probe.children.map((c) => c.runId)).toEqual(['run_1']);

    const refused = await s.launch({ runId: 'run_2', timeoutSeconds: 120, envVars: {} });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ refusal: 'draining' });
    expect(s.exits).toEqual([]);

    // Released, the run ends and the supervisor leaves behind it.
    writeFileSync(`${hold}.release`, '1');
    await until(() => s.exits.length > 0, 'the supervisor to leave');
    expect(s.exits).toEqual([0]);
    expect(existsSync(runDir)).toBe(false);
  });

  it('leaves even where the run\'s working directory cannot be removed', async () => {
    const s = boot();
    const out = join(s.root, 'stuck.json');
    expect((await s.launch({ runId: 'run_stuck', timeoutSeconds: 120, envVars: { STANDIN_OUT: out } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');

    // A directory whose parent admits no writes cannot be removed.
    chmodSync(s.workDir, 0o500);
    try {
      s.signal();
      await until(() => s.exits.length > 0, 'the supervisor to leave');
      expect(s.exits).toEqual([0]);
    } finally {
      chmodSync(s.workDir, 0o700);
    }
  });

  it('leaves at once when it holds no run', async () => {
    const s = boot();
    s.signal();
    await until(() => s.exits.length > 0, 'the supervisor to leave');
    expect(s.exits).toEqual([0]);
  });

  it('leaves at once on a second signal, whatever is still running, and leaves once', async () => {
    const s = boot();
    const out = join(s.root, 'second-signal.json');
    expect((await s.launch({ runId: 'run_1', timeoutSeconds: 600, envVars: { STANDIN_OUT: out } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');

    s.signal('SIGTERM');
    s.signal('SIGINT');
    await until(() => s.exits.length > 0, 'the supervisor to leave');
    // The child's own exit follows the kill; the process leaves for one of them.
    await Bun.sleep(200);
    expect(s.exits).toEqual([0]);
  });
});

describe('what the supervisor does with a child it cannot be rid of', () => {
  it('offers the kill again until the child is gone', async () => {
    const kills: string[] = [];
    let refusals = 2;
    const stubborn = (): SpawnedChild => ({
      pid: 987_654,
      exited: new Promise<number>(() => undefined),
      kill: (signal: NodeJS.Signals) => {
        kills.push(signal);
        if (refusals > 0) { refusals -= 1; throw new Error('kill refused'); }
      },
    });
    const s = boot({ spawn: stubborn, overrunMarginMs: 30, backstopRetryMs: 40 });

    expect((await s.launch({ runId: 'run_stubborn', timeoutSeconds: 0, envVars: {} })).status).toBe(202);
    await until(() => kills.filter((k) => k === 'SIGKILL').length >= 3, 'the kill to be offered again');
    // A kill that failed does not end the matter, and the run is still held while it is offered.
    expect((await s.probe()).children.map((c) => c.runId)).toEqual(['run_stubborn']);
  });

  const unprivileged = process.getuid?.() === 0 ? it.skip : it;
  unprivileged('keeps launching after a working directory it could not remove (root ignores the mode this rests on)', async () => {
    const s = boot();
    const out = join(s.root, 'stale.json');
    // Long enough that the directory's mode is changed while the child is
    // provably still running, so the removal it leaves behind is the one that
    // fails rather than one that ran before the test was ready.
    expect((await s.launch({ runId: 'run_stale', timeoutSeconds: 120, envVars: { STANDIN_OUT: out, STANDIN_EXIT_MS: '1500' } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');

    chmodSync(s.workDir, 0o500);
    await until(async () => (await s.probe()).children.length === 0, 'the child to leave');
    chmodSync(s.workDir, 0o700);
    // The directory the removal could not take is still there.
    expect(existsSync(join(s.workDir, 'run_stale'))).toBe(true);

    // Neither a new run nor the same id again is held up by it.
    expect((await s.launch({ runId: 'run_after_stale', timeoutSeconds: 120, envVars: {} })).status).toBe(202);
    expect((await s.launch({ runId: 'run_stale', timeoutSeconds: 120, envVars: {} })).status).toBe(202);
  });

  const onLinux = platform() === 'linux' ? it : it.skip;
  onLinux('kills the tree a runtime started, not the runtime alone (setsid is Linux-only)', async () => {
    const s = boot({ overrunMarginMs: 100, tools: { setsid: Bun.which('setsid'), setpriv: null } });
    const out = join(s.root, 'tree.json');
    const kidFile = join(s.root, 'grandchild.pid');
    expect((await s.launch({
      runId: 'run_tree', timeoutSeconds: 0,
      envVars: { STANDIN_OUT: out, STANDIN_GRANDCHILD: kidFile, STANDIN_IGNORE_SIGTERM: '1' },
    })).status).toBe(202);
    await until(() => existsSync(kidFile), 'the runtime to start a child of its own');
    const kid = Number(readFileSync(kidFile, 'utf8'));

    const gone = (pid: number): boolean => {
      try { process.kill(pid, 0); return false; } catch { return true; }
    };
    await until(() => gone(kid), 'the grandchild to be killed with its runtime');
    // The child dies with its group too, and the run is released when the
    // supervisor observes that — which is after the grandchild is already gone.
    await until(async () => (await s.probe()).children.length === 0, 'the run to be released');
  });
});

describe('a run whose runtime died before it ended', () => {
  /** A stand-in deployment: it records the run-control posts a supervisor makes for a child that died. */
  function deployment(answer: Record<string, unknown> = { persisted: true, applied: true }): { url: string; posts: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[]; stop(): void } {
    const posts: { path: string; headers: Record<string, string>; body: Record<string, unknown> }[] = [];
    const server = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      development: false,
      fetch: async (request) => {
        posts.push({
          path: new URL(request.url).pathname,
          headers: Object.fromEntries(request.headers.entries()),
          body: await request.json() as Record<string, unknown>,
        });
        return Response.json(answer);
      },
    });
    return { url: `http://127.0.0.1:${server.port}`, posts, stop: () => { server.stop(true); } };
  }

  it('is closed by the supervisor, with that run\'s own credential', async () => {
    const s = boot();
    const deploy = deployment();
    try {
      expect((await s.launch({
        runId: 'run_died',
        timeoutSeconds: 120,
        envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_run_died', MYCO_PROJECT: 'proj_1', STANDIN_EXIT_CODE: '3' },
      })).status).toBe(202);

      await until(() => deploy.posts.length > 0, 'the supervisor to close the run');
      const post = deploy.posts[0]!;
      expect(post.path).toBe('/runs/update');
      expect(post.headers.authorization).toBe('Bearer mt_run_died');
      expect(post.headers['x-myco-project']).toBe('proj_1');
      expect(post.headers['x-myco-protocol']).toBe('1');
      expect(post.body.runId).toBe('run_died');
      const update = post.body.update as { status: string; error: string; completed_at: number };
      expect(update.status).toBe('failed');
      expect(update.error).toBe('the runtime exited before the run ended (3)');
      expect(typeof update.completed_at).toBe('number');
      // The run is released either way, so the next launch of it is admitted.
      expect((await s.probe()).children).toEqual([]);
    } finally {
      deploy.stop();
    }
  });

  it('is closed when a hard death takes it during a drain, before this process leaves', async () => {
    // A runtime the drain could not stop is killed at the backstop; the run it
    // held is named on the row before the supervisor goes.
    const s = boot({ overrunMarginMs: 120 });
    const deploy = deployment();
    const out = join(s.root, 'killed.json');
    try {
      expect((await s.launch({
        runId: 'run_killed',
        timeoutSeconds: 0,
        envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_killed', MYCO_PROJECT: 'proj_1', STANDIN_OUT: out, STANDIN_IGNORE_SIGTERM: '1' },
      })).status).toBe(202);
      await until(() => existsSync(out), 'the child to run');

      s.signal();
      await until(() => s.exits.length > 0, 'the supervisor to leave');
      // The post landed before the process left, not after it.
      expect(deploy.posts).toHaveLength(1);
      const update = deploy.posts[0]!.body.update as { status: string; error: string };
      expect(update.status).toBe('failed');
      expect(update.error).toContain(RUNTIME_DIED_ERROR);
    } finally {
      deploy.stop();
    }
  });

  it('is left to its own reclaim when this supervisor is the one that stopped it', async () => {
    const s = boot();
    const deploy = deployment();
    const out = join(s.root, 'drained.json');
    const hold = join(s.root, 'drain-hold');
    try {
      // A drained runtime records its own ending and then exits non-zero, which
      // is the ordinary shape of every `myco server update`.
      expect((await s.launch({
        runId: 'run_drained',
        timeoutSeconds: 120,
        // The code a drained runtime leaves with once it has named its own row.
        envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_drained', MYCO_PROJECT: 'proj_1', STANDIN_OUT: out, STANDIN_HOLD_SIGTERM: hold, STANDIN_EXIT_ON_SIGTERM: String(RUNTIME_EXIT.named) },
      })).status).toBe(202);
      await until(() => existsSync(out), 'the child to run');

      s.signal();
      await until(() => existsSync(`${hold}.signalled`), 'the child to receive the stop signal');
      writeFileSync(`${hold}.release`, '1');

      await until(() => s.exits.length > 0, 'the supervisor to leave');
      // Nothing is posted over the ending that run wrote for itself.
      expect(deploy.posts).toEqual([]);
    } finally {
      deploy.stop();
    }
  });

  it('is left alone for either ending the runtime writes itself, and posted for every other code', async () => {
    // Only these two mean the row already carries an ending. `1` is what a
    // bundle that would not start answers, so it is not one of them.
    expect([...RUNTIME_OWN_ENDINGS].sort()).toEqual([RUNTIME_EXIT.ran, RUNTIME_EXIT.named]);
    expect(RUNTIME_OWN_ENDINGS.has(1)).toBe(false);

    const s = boot();
    const deploy = deployment();
    try {
      for (const code of [RUNTIME_EXIT.ran, RUNTIME_EXIT.named]) {
        expect((await s.launch({
          runId: `run_own_${code}`, timeoutSeconds: 120,
          envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_own', MYCO_PROJECT: 'proj_1', STANDIN_EXIT_CODE: String(code) },
        })).status).toBe(202);
      }
      await until(async () => (await s.probe()).children.length === 0, 'both children to leave');
      await Bun.sleep(200);
      expect(deploy.posts).toEqual([]);

      // A runtime that could not start, and one that ended with a failure it
      // could not post, each leave a run this supervisor has to close.
      for (const code of [1, RUNTIME_EXIT.unposted]) {
        expect((await s.launch({
          runId: `run_owed_${code}`, timeoutSeconds: 120,
          envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_owed', MYCO_PROJECT: 'proj_1', STANDIN_EXIT_CODE: String(code) },
        })).status).toBe(202);
      }
      await until(() => deploy.posts.length === 2, 'both runs to be closed');
      expect(deploy.posts.map((p) => p.body.runId).sort()).toEqual(['run_owed_1', `run_owed_${RUNTIME_EXIT.unposted}`]);
      for (const post of deploy.posts) {
        expect((post.body.update as { status: string }).status).toBe('failed');
      }
    } finally {
      deploy.stop();
    }
  });

  it('names what each exit code owes the row it held', () => {
    // Table of the whole rule: what the supervisor writes, and for whom.
    const cases: Array<[number, boolean, { error: string; replaced: boolean } | null]> = [
      [RUNTIME_EXIT.ran, false, null],
      [RUNTIME_EXIT.named, false, null],
      [RUNTIME_EXIT.ran, true, null],
      [RUNTIME_EXIT.named, true, null],
      [RUNTIME_EXIT.unclaimed, false, { error: RUNTIME_UNCLAIMED_ERROR, replaced: false }],
      // The one case a successor is queued for: a run this supervisor stopped
      // before its runtime claimed it runs again unchanged.
      [RUNTIME_EXIT.unclaimed, true, { error: RUNTIME_RECLAIMED_ERROR, replaced: true }],
      // These two fail the same way every time they are tried, drain or no
      // drain, so each is named and left.
      [RUNTIME_EXIT.unknownTask, false, { error: `${RUNTIME_UNKNOWN_TASK_ERROR} container-smoke`, replaced: false }],
      [RUNTIME_EXIT.unknownTask, true, { error: `${RUNTIME_UNKNOWN_TASK_ERROR} container-smoke`, replaced: false }],
      [RUNTIME_EXIT.claimRefused, false, { error: RUNTIME_CLAIM_REFUSED_ERROR, replaced: false }],
      [RUNTIME_EXIT.claimRefused, true, { error: RUNTIME_CLAIM_REFUSED_ERROR, replaced: false }],
      // A run another attempt holds is not this one's to end, drain or no drain.
      [RUNTIME_EXIT.claimContended, false, null],
      [RUNTIME_EXIT.claimContended, true, null],
      [RUNTIME_EXIT.unposted, false, { error: `${RUNTIME_DIED_ERROR} (3)`, replaced: false }],
      [1, false, { error: `${RUNTIME_DIED_ERROR} (1)`, replaced: false }],
      [137, true, { error: `${RUNTIME_DIED_ERROR} (137)`, replaced: false }],
    ];
    for (const [code, draining, expected] of cases) {
      expect({ code, draining, close: closeForExit(code, draining, 'container-smoke') })
        .toEqual({ code, draining, close: expected });
    }
    // A dispatch whose task the launch did not name still says what happened.
    expect(closeForExit(RUNTIME_EXIT.unknownTask, false, null))
      .toEqual({ error: `${RUNTIME_UNKNOWN_TASK_ERROR} the dispatch named`, replaced: false });
  });

  it('writes nothing for a run another attempt holds, and says which run it was', async () => {
    const s = boot();
    const deploy = deployment();
    const logged: Record<string, unknown>[] = [];
    const log = console.log;
    console.log = (text?: unknown) => { try { logged.push(JSON.parse(String(text)) as Record<string, unknown>); } catch { /* not a line */ } };
    try {
      expect((await s.launch({
        runId: 'run_contended', timeoutSeconds: 120,
        envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_contended', MYCO_PROJECT: 'proj_1', STANDIN_EXIT_CODE: String(RUNTIME_EXIT.claimContended) },
      })).status).toBe(202);
      await until(() => logged.some((l) => l.kind === 'supervisor_run_contended'), 'the contention to be said');
      await Bun.sleep(200);
      expect(deploy.posts).toEqual([]);
      expect(logged.find((l) => l.kind === 'supervisor_run_contended')).toMatchObject({ runId: 'run_contended' });
    } finally {
      console.log = log;
      deploy.stop();
    }
  });

  it('closes a run its runtime started and never claimed', async () => {
    const s = boot();
    const deploy = deployment();
    try {
      expect((await s.launch({
        runId: 'run_never_claimed', timeoutSeconds: 120,
        envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_unclaimed', MYCO_PROJECT: 'proj_1', STANDIN_EXIT_CODE: String(RUNTIME_EXIT.unclaimed) },
      })).status).toBe(202);

      await until(() => deploy.posts.length > 0, 'the run to be closed');
      const update = deploy.posts[0]!.body.update as { status: string; error: string };
      expect(update).toMatchObject({ status: 'failed', error: RUNTIME_UNCLAIMED_ERROR });
      // Nothing asks for a successor: no deployment took this run away.
      expect(deploy.posts[0]!.body.replaced).toBeUndefined();
    } finally {
      deploy.stop();
    }
  });

  it('asks for a successor when the run it stopped had not been claimed', async () => {
    const s = boot();
    const deploy = deployment();
    const out = join(s.root, 'reclaimed.json');
    const hold = join(s.root, 'reclaim-hold');
    try {
      expect((await s.launch({
        runId: 'run_reclaimed', timeoutSeconds: 120,
        envVars: {
          MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_reclaimed', MYCO_PROJECT: 'proj_1',
          STANDIN_OUT: out, STANDIN_HOLD_SIGTERM: hold, STANDIN_EXIT_ON_SIGTERM: String(RUNTIME_EXIT.unclaimed),
        },
      })).status).toBe(202);
      await until(() => existsSync(out), 'the child to run');

      s.signal();
      await until(() => existsSync(`${hold}.signalled`), 'the child to receive the stop signal');
      writeFileSync(`${hold}.release`, '1');
      await until(() => s.exits.length > 0, 'the supervisor to leave');

      expect(deploy.posts).toHaveLength(1);
      expect(deploy.posts[0]!.body.update).toMatchObject({ status: 'failed', error: RUNTIME_RECLAIMED_ERROR });
      // The word and the flag the Deployment reads to queue a fresh run in its place.
      expect(deploy.posts[0]!.body.replaced).toBe(true);
    } finally {
      deploy.stop();
    }
  });

  it('reads the answer it got: a refusal is a 200, and is not a close', async () => {
    const s = boot();
    // The shape a stale credential makes: the row moved on, and this post is
    // answered `applied: false` with a reason rather than a status of its own.
    const deploy = deployment({ persisted: false, applied: false, reason: 'this run is dispatched under another credential' });
    const logged: Record<string, unknown>[] = [];
    const log = console.log;
    console.log = (text?: unknown) => { try { logged.push(JSON.parse(String(text)) as Record<string, unknown>); } catch { /* not a line */ } };
    try {
      expect((await s.launch({
        runId: 'run_refused_close', timeoutSeconds: 120,
        envVars: { MYCO_SERVER_URL: deploy.url, MYCO_MEMBER_TOKEN: 'mt_stale', MYCO_PROJECT: 'proj_1', STANDIN_EXIT_CODE: '9' },
      })).status).toBe(202);
      await until(() => logged.some((l) => l.kind === 'supervisor_run_close_refused'), 'the refusal to be read');
      expect(logged.filter((l) => l.kind === 'supervisor_run_closed')).toEqual([]);
      expect(logged.find((l) => l.kind === 'supervisor_run_close_refused'))
        .toMatchObject({ runId: 'run_refused_close', refusal: 'this run is dispatched under another credential' });
    } finally {
      console.log = log;
      deploy.stop();
    }
  });

  it('says nothing to a deployment a dispatch never named', async () => {
    const s = boot();
    expect((await s.launch({ runId: 'run_bare', timeoutSeconds: 120, envVars: { STANDIN_EXIT_CODE: '9' } })).status).toBe(202);
    await until(async () => (await s.probe()).children.length === 0, 'the child to leave');
  });
});

describe('a child dropped to another user', () => {
  /** Stands in for the tools the image has: it records what it was asked to do and runs the rest. */
  const RECORDER = (record: string) => `#!/bin/sh\nprintf '%s\\n' "$*" >> ${record}\nwhile [ "\${1#--}" != "$1" ]; do shift; done\nexec "$@"\n`;

  it('is spawned through the tools that drop it, in a directory of its own, under its own home', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'myco-drop-'));
    roots.push(tmp);
    const record = join(tmp, 'argv.log');
    const setpriv = join(tmp, 'setpriv');
    const home = join(tmp, 'home');
    mkdirSync(home);
    writeFileSync(setpriv, RECORDER(record), { mode: 0o755 });

    // The run's own user, as this process can actually chown to.
    const runAs = { name: 'runtime', uid: process.getuid!(), gid: process.getgid!(), home };
    const s = boot({ tools: { setsid: null, setpriv }, runAs });
    const out = join(s.root, 'dropped.json');

    expect((await s.launch({ runId: 'run_dropped', timeoutSeconds: 120, envVars: { STANDIN_OUT: out } })).status).toBe(202);
    await until(() => existsSync(out), 'the dropped child to run');

    // The drop went through the tool, naming the user and its groups.
    expect(readFileSync(record, 'utf8').trim())
      .toContain('--reuid=runtime --regid=runtime --init-groups');
    const child = handed(out);
    // The CLI a run spawns writes under a home the dropped user owns.
    expect(child.env.HOME).toBe(home);
    expect(child.cwd).toBe(join(realpathSync(s.workDir), 'run_dropped'));
    // The directory is the run's own user's to write in.
    expect(statSync(join(s.workDir, 'run_dropped')).uid).toBe(runAs.uid);
  });
});

describe('what the operator has to supply', () => {
  /** An unprivileged supervisor, whatever user happens to be running this suite. */
  const asUser = { uid: 1000, tools: { setsid: null, setpriv: null }, passwd: () => '' };
  const withEnv = (env: Record<string, string | undefined>) => () => supervisorOptionsFromEnv(env, asUser);

  it('refuses to start without a token file: the launch endpoint is authenticated', () => {
    expect(withEnv({})).toThrow(/MYCO_HARNESS_TOKEN_FILE/);
    expect(withEnv({ MYCO_HARNESS_TOKEN_FILE: '' })).toThrow(/MYCO_HARNESS_TOKEN_FILE/);
  });

  it('refuses a token file it cannot read, and one that is empty', () => {
    const root = scratch();
    expect(withEnv({ MYCO_HARNESS_TOKEN_FILE: join(root, 'absent') })).toThrow(/cannot be read/);
    const empty = join(root, 'empty');
    writeFileSync(empty, '   \n');
    expect(withEnv({ MYCO_HARNESS_TOKEN_FILE: empty })).toThrow(/is empty/);
  });

  it('listens where nothing publishes it when the operator names no address', async () => {
    expect(DEFAULT_SUPERVISOR_HOSTNAME).toBe('127.0.0.1');
    const s = boot({ hostname: null });
    // The loopback of this namespace answers, which is where the deployment reaches it.
    expect((await fetch(`http://127.0.0.1:${s.supervisor.port}/probe`)).status).toBe(200);
  });

  it('reads the token trimmed, and defaults the port, the entry beside it, and the working root', () => {
    const root = scratch();
    const path = join(root, 'token');
    writeFileSync(path, `  ${TOKEN}  \n`);

    const options = supervisorOptionsFromEnv({ MYCO_HARNESS_TOKEN_FILE: path }, asUser);
    expect(options.runAs).toBeNull();
    expect(options.token).toBe(TOKEN);
    expect(options.port).toBe(8080);
    expect(options.entry.endsWith('entry.js')).toBe(true);
    expect(options.workDir).toBe(tmpdir());
  });

  it('drops its children when it is root, and refuses when it cannot', () => {
    const root = scratch();
    const path = join(root, 'token');
    writeFileSync(path, TOKEN);
    chmodSync(path, 0o600);
    const passwd = () => 'root:x:0:0::/root:/bin/sh\nruntime:x:10002:10002::/home/runtime:/usr/sbin/nologin\n';
    const tools = { setsid: '/usr/bin/setsid', setpriv: '/usr/bin/setpriv' };
    const env = { MYCO_HARNESS_TOKEN_FILE: path };

    // A token owned by whoever runs this suite is not readable by uid 10002.
    expect(supervisorOptionsFromEnv(env, { uid: 0, tools, passwd }).runAs)
      .toEqual({ name: 'runtime', uid: 10_002, gid: 10_002, home: '/home/runtime' });

    // Nothing to drop with.
    expect(() => supervisorOptionsFromEnv(env, { uid: 0, tools: { setsid: tools.setsid, setpriv: null }, passwd }))
      .toThrow(/setpriv is not on its PATH/);

    // Nobody to drop to.
    expect(() => supervisorOptionsFromEnv({ ...env, MYCO_RUNTIME_USER: 'nobody-here' }, { uid: 0, tools, passwd }))
      .toThrow(/no account for/);

    // A secret the dropped user could read protects nothing, so it is refused by name.
    chmodSync(path, 0o644);
    expect(() => supervisorOptionsFromEnv(env, { uid: 0, tools, passwd }))
      .toThrow(/which runtime can read/);
  });

  it('takes the port, the entry, and the working root the operator named', () => {
    const root = scratch();
    const path = join(root, 'token');
    writeFileSync(path, TOKEN);

    expect(supervisorOptionsFromEnv({
      MYCO_HARNESS_TOKEN_FILE: path,
      MYCO_SUPERVISOR_PORT: '9111',
      MYCO_HARNESS_ENTRY: '/app/entry.js',
      MYCO_WORK_DIR: '/work',
    }, asUser)).toMatchObject({ port: 9111, entry: '/app/entry.js', workDir: '/work' });

    expect(() => supervisorOptionsFromEnv({ MYCO_HARNESS_TOKEN_FILE: path, MYCO_SUPERVISOR_PORT: 'eighty-eighty' }, asUser))
      .toThrow(/MYCO_SUPERVISOR_PORT/);
  });
});
