import { deploymentSecretStore } from '@myco-server-worker/core/secrets.js';
import { wrappingKeyFromText } from '@myco-server-worker/platform/wrapping-key.js';
/**
 * The self-hosted launch seam, end to end and in one process.
 *
 * Everything between an owner pressing dispatch and a run row reading
 * `completed` is real here: the shipped server from `entry/bun.js` on a
 * migrated volume, the Bun launch adapter, the harness supervisor, a child
 * process spawned with the dispatch environment, and that child reaching back
 * over the run-control routes with the credential the dispatch minted. Only the
 * model call is absent.
 *
 * The parity suite proves the queue on both targets with a recording launch,
 * which starts nothing; this is the only place a runtime is actually started.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "../../support/fenced-fs.mjs";
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMigrationFiles } from '@myco-server-worker/db/migrate.js';
import { issueMemberToken } from '@myco-server-worker/auth/tokens.js';
import { sqliteRelationalStore } from '@myco-server-worker/platform/bun/sqlite.js';
import { linkStatement } from '@myco-server-worker/auth/identity-link.js';
import { signSession, SESSION_COOKIE } from '@myco-server-worker/auth/owner/cookie.js';
import { serve } from '@myco-server-worker/entry/bun.js';
import { httpHarnessLaunch } from '@myco-server-worker/platform/bun/harness-runner.js';
import { RuntimeDraining } from '@myco-server-worker/core/harness.js';
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { startSupervisor, type SpawnPlan } from '@myco/agent/runtime/supervisor.js';

const MEMBER_ID = 'mem_seam';
const MACHINE_ID = 'machine_seam';
const PROJECT_ID = 'proj_seam';
const GITHUB_SUB = '515151';
const SESSION_SECRET = 'seam-session-secret-0123456789abcdef';
const HARNESS_TOKEN = 'seam-harness-token';
const TASK = 'container-smoke';

const STAND_IN = fileURLToPath(new URL('./stand-in-runtime.ts', import.meta.url));

/** A port nothing holds: bound, read, and released, so the supervisor can come back to the same address. */
function freePort(): number {
  const probe = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => new Response('') });
  const port = Number(probe.port);
  probe.stop(true);
  return port;
}

interface Seam {
  url: string;
  root: string;
  /** The deployment's own store, read the way a deploy reads it. */
  sql(command: string): Promise<Record<string, unknown>[]>;
  ownerHeaders(): Record<string, string>;
  dispatch(): Promise<{ runId: string; queued?: boolean; heldBy?: string }>;
  wake(): Promise<{ drained: number }>;
  /** The environment the child received, once it has run. */
  childEnv(): Record<string, string>;
  finishChild(runId: string): Promise<void>;
  childReady(runId: string): Promise<void>;
  /** Stop the supervisor, as a Compose update stops the harness before it rolls the server. */
  stopHarness(): Promise<void>;
  /** Bring a supervisor back at the same address the deployment already holds. */
  startHarness(): void;
  /** Make the next launch start its child and then answer as one that timed out. */
  loseNextAnswer(): void;
  probe(): Promise<{ draining: boolean; children: unknown[] }>;
  stop(): Promise<void>;
}

const CHILD_EVENT_TIMEOUT_MS = 30_000;

async function childEvent<T>(event: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([event, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`runtime did not ${label}`)), CHILD_EVENT_TIMEOUT_MS);
    })]);
  } finally {
    clearTimeout(timer);
  }
}

const live: Seam[] = [];
afterEach(async () => { for (const seam of live.splice(0)) await seam.stop(); });

async function boot(): Promise<Seam> {
  const root = mkdtempSync(join(tmpdir(), 'myco-seam-'));
  const databasePath = join(root, 'myco.sqlite');
  const envOut = join(root, 'child-env.json');

  const sqlite = new Database(databasePath);
  sqlite.exec('PRAGMA foreign_keys = ON');
  for (const file of renderMigrationFiles()) sqlite.exec(file.sql);
  sqlite.query(`INSERT INTO members (id, label, created_at, revoked_at) VALUES (?, ?, 0, NULL)`).run(MEMBER_ID, 'seam');
  sqlite.query(`INSERT INTO projects (project_id, name, created_at) VALUES (?, 'seam', 1)`).run(PROJECT_ID);
  const db = sqliteRelationalStore(sqlite);
  await linkStatement(db, MEMBER_ID, GITHUB_SUB).run();
  await issueMemberToken(db, { memberId: MEMBER_ID, machineId: MACHINE_ID }, Date.now());
  const now = Date.now();
  const wrappingText = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))));
  await deploymentSecretStore(db, wrappingKeyFromText(async () => wrappingText, 'seam')).put('anthropic', 'sk-ant-oat-seam-test-token', MEMBER_ID, now);
  sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, 'cortex', 1, ?, ?)`)
    .run(PROJECT_ID, now, MEMBER_ID);
  sqlite.close();

  const tokenPath = join(root, 'harness_token');
  writeFileSync(tokenPath, `${HARNESS_TOKEN}\n`);
  const supervisorPort = freePort();
  const workDir = join(root, 'work');
  const children = new Map<string, { ready: Promise<void>; child: Bun.Subprocess<'ignore', 'inherit', 'inherit'> }>();
  const supervisorOptions = {
    token: HARNESS_TOKEN, entry: STAND_IN, workDir, port: supervisorPort, hostname: '127.0.0.1',
    events: { on: () => undefined }, exit: () => undefined,
    spawn: (plan: SpawnPlan) => {
      const runId = plan.env.MYCO_RUN_ID!;
      let ready!: () => void;
      const readyEvent = new Promise<void>((resolve) => { ready = resolve; });
      const child = Bun.spawn({
        ...plan, env: { ...plan.env, STANDIN_ENV_OUT: envOut },
        stdin: 'ignore', stdout: 'inherit', stderr: 'inherit',
        ipc: (message) => { if (message === 'ready') ready(); },
      });
      children.set(runId, { child, ready: readyEvent });
      return { pid: child.pid, exited: child.exited, kill: (signal: NodeJS.Signals) => { child.kill(signal); } };
    },
  };
  let supervisor = startSupervisor(supervisorOptions);

  // The adapter is built before the socket is bound, and reads the port it
  // bound at each launch, exactly as the process entry wires it.
  let boundPort: number | null = null;
  const launch = httpHarnessLaunch({
    url: `http://127.0.0.1:${supervisorPort}`,
    token: HARNESS_TOKEN,
    callbackOrigin: () => `http://127.0.0.1:${boundPort!}`,
  });
  // A launch whose answer arrives past its deadline: the child is started, and
  // the dispatcher hears nothing about it.
  let loseAnswers = 0;
  const started = await serve({
    harnessLaunch: async (spec) => {
      await launch(spec);
      if (loseAnswers > 0) {
        loseAnswers -= 1;
        throw new RuntimeDraining(`the harness runtime at http://127.0.0.1:${supervisorPort} could not be reached: timed out`, 'unreachable');
      }
    },
    databasePath,
    blobDir: join(root, 'blobs'),
    port: 0,
    bind: 'loopback',
    transport: 'loopback',
    sourceFrom: 'socket',
    wakeLoop: false,
    SESSION_SECRET,
    SECRET_WRAP_KEY: wrappingText,
    GITHUB_CLIENT_ID: 'seam-client',
    GITHUB_CLIENT_SECRET: 'seam-secret',
  });
  boundPort = started.port;
  const url = `http://127.0.0.1:${started.port}`;
  const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: GITHUB_SUB, login: 'seam', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
  const ownerHeaders = () => ({ cookie, origin: url });

  const sql = async (command: string): Promise<Record<string, unknown>[]> =>
    (await started.env.db.prepare(command).all()).results;

  const seam: Seam = {
    url,
    root,
    sql,
    ownerHeaders,
    childReady: async (runId) => {
      const runtime = children.get(runId);
      if (runtime === undefined) throw new Error(`no runtime launched for ${runId}`);
      await childEvent(Promise.race([
        runtime.ready,
        runtime.child.exited.then((code) => { throw new Error(`runtime exited before readiness: ${code}`); }),
      ]), `become ready for ${runId}`);
    },
    finishChild: async (runId) => {
      await seam.childReady(runId);
      const runtime = children.get(runId)!;
      runtime.child.send('claim');
      expect(await childEvent(runtime.child.exited, `exit for ${runId}`)).toBe(0);
    },
    dispatch: async () => {
      const res = await fetch(`${url}/api/harness/dispatch`, {
        method: 'POST',
        headers: { ...ownerHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({ task: TASK, projectId: PROJECT_ID, timeoutSeconds: 120 }),
      });
      expect(res.status).toBe(200);
      return await res.json() as { runId: string; queued?: boolean; heldBy?: string };
    },
    wake: async () => {
      const res = await fetch(`${url}/api/wake`, { method: 'POST', headers: ownerHeaders() });
      expect(res.status).toBe(200);
      return await res.json() as { drained: number };
    },
    childEnv: () => JSON.parse(readFileSync(envOut, 'utf8')) as Record<string, string>,
    stopHarness: async () => { await supervisor.stop(); },
    loseNextAnswer: () => { loseAnswers += 1; },
    startHarness: () => {
      supervisor = startSupervisor(supervisorOptions);
    },
    probe: async () => await (await fetch(`http://127.0.0.1:${supervisorPort}/probe`)).json() as { draining: boolean; children: unknown[] },
    stop: async () => {
      const outcomes = await Promise.allSettled([
        supervisor.stop(),
        ...[...children.values()].map(({ child }) => childEvent(child.exited, 'stop')),
      ]);
      const [serverOutcome] = await Promise.allSettled([started.stop()]);
      outcomes.push(serverOutcome!);
      if (serverOutcome!.status === 'fulfilled' && [...children.values()].every(({ child }) => child.exitCode !== null)) {
        rmSync(root, { recursive: true, force: true });
      }
      const errors = outcomes.flatMap((outcome) => outcome.status === 'rejected' ? [outcome.reason] : []);
      if (errors.length > 0) throw new AggregateError(errors, 'dispatch seam shutdown failed');
    },
  };
  live.push(seam);
  return seam;
}

async function settled(seam: Seam, runId: string): Promise<Record<string, unknown>> {
  await seam.finishChild(runId);
  return (await seam.sql(`SELECT id, status, dispatched_by AS dispatchedBy, error FROM agent_runs WHERE id = '${runId}'`))[0] ?? {};
}

describe('a dispatch that starts a real runtime', () => {
  it('launches over HTTP, and the run it started claims, reports, and closes itself', async () => {
    const seam = await boot();

    const dispatched = await seam.dispatch();
    expect(dispatched.queued).toBe(false);

    // The row exists before the runtime does, carrying the credential minted for it.
    const dispatchedBy = String((await seam.sql(`SELECT dispatched_by AS d FROM agent_runs WHERE id = '${dispatched.runId}'`))[0]!.d);
    expect(dispatchedBy.length).toBeGreaterThan(0);

    const row = await settled(seam, dispatched.runId);
    expect({ status: row.status, error: row.error }).toEqual({ status: 'completed', error: null });
    // The claim ran under the credential the dispatch minted, and the close left it there.
    expect(row.dispatchedBy).toBe(dispatchedBy);

    // The report the runtime wrote is on the run.
    expect(await seam.sql(`SELECT action, summary FROM agent_reports WHERE run_id = '${dispatched.runId}'`))
      .toEqual([{ action: TASK, summary: 'the runtime ran' }]);

    // A credential that exists for one run is revoked when that run closes.
    expect((await seam.sql(`SELECT revoked_at AS revokedAt FROM member_credentials WHERE id = '${dispatchedBy}' AND member_id = '${HARNESS_MEMBER_ID}'`))
      .map((r) => r.revokedAt !== null)).toEqual([true]);

    // The adapter, not the request, decided where the runtime called back.
    const child = seam.childEnv();
    expect(child.MYCO_SERVER_URL).toBe(seam.url);
    expect(child.MYCO_RUN_ID).toBe(dispatched.runId);
    expect(child.MYCO_TASK).toBe(TASK);
    expect(child.MYCO_TASK_ADMISSION).toBe('cortex');
    expect(child.MYCO_RUNTIME_PORT).toBe('none');
    // The supervisor's own configuration stayed with the supervisor.
    for (const name of ['MYCO_HARNESS_TOKEN_FILE', 'MYCO_SUPERVISOR_PORT', 'MYCO_WORK_DIR']) {
      expect(child[name]).toBeUndefined();
    }

    expect(await seam.probe()).toEqual({ ok: true, draining: false, children: [] } as never);
  }, 60_000);

  it('lands a run whose launch was answered too late, rather than failing a child that is running', async () => {
    const seam = await boot();
    // The child waits for permission to claim while its launch answer is lost.
    seam.loseNextAnswer();
    const held = await seam.dispatch();
    expect(held).toMatchObject({ queued: true, heldBy: 'runtime' });
    const launched = (await seam.sql(`SELECT dispatched_by AS d FROM agent_runs WHERE id = '${held.runId}'`))[0]!.d as string;
    // The credential the running child holds stays live on the queued row.
    expect(launched).not.toBeNull();

    await seam.childReady(held.runId);
    // The drain offers it again; the supervisor is already running it, so the
    // row goes back to pending under the credential that child holds.
    expect((await seam.wake()).drained).toBe(1);
    expect(await seam.sql(`SELECT status, dispatched_by AS d FROM agent_runs WHERE id = '${held.runId}'`))
      .toEqual([{ status: 'pending', d: launched }]);

    // The child is released, claims under it, and the run ends as any other does.
    const row = await settled(seam, held.runId);
    expect({ status: row.status, error: row.error }).toEqual({ status: 'completed', error: null });
  }, 60_000);

  it('lets the child of a launch the queue took back claim the row it is still named on', async () => {
    const seam = await boot();
    // The launch answer is lost and no drain runs before the child claims.
    seam.loseNextAnswer();
    const held = await seam.dispatch();
    expect(held).toMatchObject({ queued: true, heldBy: 'runtime' });

    // The claim lands on the queued row, which becomes a run like any other.
    const row = await settled(seam, held.runId);
    expect({ status: row.status, error: row.error }).toEqual({ status: 'completed', error: null });
    const [ended] = await seam.sql(`SELECT held_by AS heldBy, started_at AS startedAt, queued_at AS queuedAt FROM agent_runs WHERE id = '${held.runId}'`);
    // The holder that described a waiting run is gone, it has the start every
    // reader needs, and it keeps the place it took in the queue.
    expect(ended!.heldBy).toBeNull();
    expect(ended!.startedAt).not.toBeNull();
    expect(ended!.queuedAt).not.toBeNull();
  }, 60_000);

  it('queues the dispatch while no runtime will take it, and drains it when one is back', async () => {
    const seam = await boot();
    await seam.stopHarness();

    // A runtime that is not there is not a run that failed, and it is not a
    // full fleet either: the row says which of the two it is.
    const held = await seam.dispatch();
    expect(held).toMatchObject({ queued: true, heldBy: 'runtime' });
    // The row keeps the credential its launch minted: a launch that answered
    // nothing may still have started a child, and the dispatcher cannot know.
    const [waiting] = await seam.sql(`SELECT status, held_by AS heldBy, dispatched_by AS dispatchedBy FROM agent_runs WHERE id = '${held.runId}'`);
    expect(waiting).toMatchObject({ status: 'queued', heldBy: 'runtime' });
    const carried = waiting!.dispatchedBy as string;
    expect(await seam.sql(`SELECT revoked_at AS r FROM member_credentials WHERE id = '${carried}'`)).toEqual([{ r: null }]);
    // Nothing failed, and nothing is running.
    expect(await seam.sql(`SELECT COUNT(*) AS c FROM agent_runs WHERE status = 'failed'`)).toEqual([{ c: 0 }]);

    seam.startHarness();
    expect((await seam.wake()).drained).toBe(1);
    // The relaunch starts a fresh child, and retires the credential of the
    // attempt it replaced.
    expect(await seam.sql(`SELECT revoked_at IS NOT NULL AS revoked FROM member_credentials WHERE id = '${carried}'`))
      .toEqual([{ revoked: 1 }]);

    const row = await settled(seam, held.runId);
    expect({ status: row.status, error: row.error }).toEqual({ status: 'completed', error: null });
    expect(seam.childEnv().MYCO_RUN_ID).toBe(held.runId);
  }, 60_000);
});
