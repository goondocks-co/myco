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
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startSupervisor, supervisorOptionsFromEnv, type RunningSupervisor } from '@myco/agent/runtime/supervisor.js';

const TOKEN = 'supervisor-token';

/**
 * A stand-in runtime: it records the environment and working directory it was
 * given, and then holds until the supervisor asks it to stop.
 */
const STAND_IN = `
const out = process.env.STANDIN_OUT;
if (out !== undefined && out !== '') {
  await Bun.write(out, JSON.stringify({ env: { ...process.env }, cwd: process.cwd() }));
}
process.on('SIGTERM', () => { process.exit(0); });
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

function boot(options: { entry?: string; runtimeCommand?: string } = {}): Booted {
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
    port: 0,
    hostname: '127.0.0.1',
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
async function until(condition: () => boolean, label: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (condition()) return;
    await Bun.sleep(20);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const handed = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { env: Record<string, string>; cwd: string };

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
    expect(child.cwd).toBe(join(realpathSync(s.workDir), 'run_1'));
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
    expect((await s.launch({ runId: 'run_1', timeoutSeconds: 120, envVars: { STANDIN_OUT: out } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');
    const runDir = handed(out).cwd;

    s.signal();
    const probe = await s.probe();
    expect(probe.draining).toBe(true);
    expect(probe.children.map((c) => c.runId)).toEqual(['run_1']);

    const refused = await s.launch({ runId: 'run_2', timeoutSeconds: 120, envVars: {} });
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ refusal: 'draining' });

    // The child was asked to stop, and the supervisor left behind it.
    await until(() => s.exits.length > 0, 'the supervisor to leave');
    expect(s.exits).toEqual([0]);
    expect(existsSync(runDir)).toBe(false);
  });

  it('leaves at once when it holds no run', async () => {
    const s = boot();
    s.signal();
    await until(() => s.exits.length > 0, 'the supervisor to leave');
    expect(s.exits).toEqual([0]);
  });

  it('leaves at once on a second signal, whatever is still running', async () => {
    const s = boot();
    const out = join(s.root, 'second-signal.json');
    expect((await s.launch({ runId: 'run_1', timeoutSeconds: 600, envVars: { STANDIN_OUT: out } })).status).toBe(202);
    await until(() => existsSync(out), 'the child to run');

    s.signal('SIGTERM');
    s.signal('SIGINT');
    await until(() => s.exits.length > 0, 'the supervisor to leave');
    expect(s.exits[0]).toBe(0);
  });
});

describe('what the operator has to supply', () => {
  const withEnv = (env: Record<string, string | undefined>) => () => supervisorOptionsFromEnv(env);

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

  it('reads the token trimmed, and defaults the port, the entry beside it, and the working root', () => {
    const root = scratch();
    const path = join(root, 'token');
    writeFileSync(path, `  ${TOKEN}  \n`);

    const options = supervisorOptionsFromEnv({ MYCO_HARNESS_TOKEN_FILE: path });
    expect(options.token).toBe(TOKEN);
    expect(options.port).toBe(8080);
    expect(options.entry.endsWith('entry.js')).toBe(true);
    expect(options.workDir).toBe(tmpdir());
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
    })).toMatchObject({ port: 9111, entry: '/app/entry.js', workDir: '/work' });

    expect(() => supervisorOptionsFromEnv({ MYCO_HARNESS_TOKEN_FILE: path, MYCO_SUPERVISOR_PORT: 'eighty-eighty' }))
      .toThrow(/MYCO_SUPERVISOR_PORT/);
  });
});
