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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
import { HARNESS_MEMBER_ID } from '@myco-server-worker/core/harness.js';
import { startSupervisor, type RunningSupervisor } from '@myco/agent/runtime/supervisor.js';

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
  sql(command: string): Record<string, unknown>[];
  ownerHeaders(): Record<string, string>;
  dispatch(): Promise<{ runId: string; queued?: boolean; heldBy?: string }>;
  wake(): Promise<{ drained: number }>;
  /** The environment the child received, once it has run. */
  childEnv(): Record<string, string>;
  supervisor: RunningSupervisor;
  /** Stop the supervisor, as a Compose update stops the harness before it rolls the server. */
  stopHarness(): Promise<void>;
  /** Bring a supervisor back at the same address the deployment already holds. */
  startHarness(): void;
  probe(): Promise<{ draining: boolean; children: unknown[] }>;
  stop(): Promise<void>;
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
  // What a dispatch needs before it can prepare: a provider, and the Project
  // admitted to the capability this task's claim names.
  const now = Date.now();
  for (const [leaf, value] of [
    ['agent.provider.type', 'openai-compatible'],
    ['agent.provider.model', 'seam-model'],
    ['agent.provider.base_url', 'http://models.internal/v1'],
  ] as const) {
    sqlite.query(`INSERT OR REPLACE INTO deployment_settings (leaf, value, updated_at, updated_by) VALUES (?, ?, ?, ?)`)
      .run(leaf, JSON.stringify(value), now, MEMBER_ID);
  }
  sqlite.query(`INSERT OR REPLACE INTO project_capabilities (project_id, capability, enabled, updated_at, updated_by) VALUES (?, 'cortex', 1, ?, ?)`)
    .run(PROJECT_ID, now, MEMBER_ID);
  sqlite.close();

  const tokenPath = join(root, 'harness_token');
  writeFileSync(tokenPath, `${HARNESS_TOKEN}\n`);
  const supervisorPort = freePort();
  const workDir = join(root, 'work');
  let supervisor = startSupervisor({
    token: HARNESS_TOKEN,
    entry: STAND_IN,
    workDir,
    port: supervisorPort,
    hostname: '127.0.0.1',
    events: { on: () => undefined },
    exit: () => undefined,
  });

  // The adapter is built before the socket is bound, and reads the port it
  // bound at each launch, exactly as the process entry wires it.
  let boundPort: number | null = null;
  const started = await serve({
    harnessLaunch: httpHarnessLaunch({
      url: `http://127.0.0.1:${supervisorPort}`,
      token: HARNESS_TOKEN,
      callbackOrigin: () => `http://127.0.0.1:${boundPort!}`,
    }),
    databasePath,
    blobDir: join(root, 'blobs'),
    port: 0,
    bind: 'loopback',
    transport: 'loopback',
    sourceFrom: 'socket',
    wakeLoop: false,
    SESSION_SECRET,
    SECRET_WRAP_KEY: btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))),
    GITHUB_CLIENT_ID: 'seam-client',
    GITHUB_CLIENT_SECRET: 'seam-secret',
  });
  boundPort = started.port;
  const url = `http://127.0.0.1:${started.port}`;
  const cookie = `${SESSION_COOKIE}=${await signSession(SESSION_SECRET, { sub: GITHUB_SUB, login: 'seam', iat: Date.now(), exp: Date.now() + 3_600_000 })}`;
  const ownerHeaders = () => ({ cookie, origin: url });

  const sql = (command: string): Record<string, unknown>[] => {
    const handle = new Database(databasePath);
    handle.exec('PRAGMA busy_timeout = 5000');
    try {
      return handle.query(command).all() as Record<string, unknown>[];
    } finally {
      handle.close();
    }
  };

  const seam: Seam = {
    url,
    root,
    sql,
    ownerHeaders,
    supervisor,
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
    startHarness: () => {
      supervisor = startSupervisor({
        token: HARNESS_TOKEN, entry: STAND_IN, workDir, port: supervisorPort, hostname: '127.0.0.1',
        events: { on: () => undefined }, exit: () => undefined,
      });
      seam.supervisor = supervisor;
    },
    probe: async () => await (await fetch(`http://127.0.0.1:${supervisorPort}/probe`)).json() as { draining: boolean; children: unknown[] },
    stop: async () => {
      delete process.env.STANDIN_ENV_OUT;
      await supervisor.stop().catch(() => undefined);
      await started.stop();
      rmSync(root, { recursive: true, force: true });
    },
  };
  // The supervisor hands its own environment to every child, which is how the
  // child learns where to record what it receives.
  process.env.STANDIN_ENV_OUT = envOut;
  live.push(seam);
  return seam;
}

/** Polls the volume until the run reads terminal, or gives up saying what it last read. */
async function settled(seam: Seam, runId: string, ms = 45_000): Promise<Record<string, unknown>> {
  const read = () => seam.sql(`SELECT id, status, dispatched_by AS dispatchedBy, error FROM agent_runs WHERE id = '${runId}'`)[0] ?? {};
  const deadline = Date.now() + ms;
  let row = read();
  const terminal = new Set(['completed', 'failed', 'skipped']);
  while (!terminal.has(String(row.status)) && Date.now() < deadline) {
    await Bun.sleep(100);
    row = read();
  }
  return row;
}

describe('a dispatch that starts a real runtime', () => {
  it('launches over HTTP, and the run it started claims, reports, and closes itself', async () => {
    const seam = await boot();

    const dispatched = await seam.dispatch();
    expect(dispatched.queued).toBe(false);

    // The row exists before the runtime does, carrying the credential minted for it.
    const dispatchedBy = String(seam.sql(`SELECT dispatched_by AS d FROM agent_runs WHERE id = '${dispatched.runId}'`)[0]!.d);
    expect(dispatchedBy.length).toBeGreaterThan(0);

    const row = await settled(seam, dispatched.runId);
    expect({ status: row.status, error: row.error }).toEqual({ status: 'completed', error: null });
    // The claim ran under the credential the dispatch minted, and the close left it there.
    expect(row.dispatchedBy).toBe(dispatchedBy);

    // The report the runtime wrote is on the run.
    expect(seam.sql(`SELECT action, summary FROM agent_reports WHERE run_id = '${dispatched.runId}'`))
      .toEqual([{ action: 'stand-in', summary: 'the runtime ran' }]);

    // A credential that exists for one run is revoked when that run closes.
    expect(seam.sql(`SELECT revoked_at AS revokedAt FROM member_credentials WHERE id = '${dispatchedBy}' AND member_id = '${HARNESS_MEMBER_ID}'`)
      .map((r) => r.revokedAt !== null)).toEqual([true]);

    // The adapter, not the request, decided where the runtime called back.
    const child = seam.childEnv();
    expect(child.MYCO_SERVER_URL).toBe(seam.url);
    expect(child.MYCO_RUN_ID).toBe(dispatched.runId);
    expect(child.MYCO_TASK).toBe(TASK);
    expect(child.MYCO_TASK_ADMISSION).toBe('cortex');
    expect(child.MYCO_RUNTIME_PORT).toBe('none');
    // The supervisor's own configuration stayed with the supervisor.
    expect({ tokenFile: child.MYCO_HARNESS_TOKEN_FILE, port: child.MYCO_SUPERVISOR_PORT, work: child.MYCO_WORK_DIR })
      .toEqual({ tokenFile: undefined, port: undefined, work: undefined });

    // The supervisor holds nothing once the child has gone.
    expect(await seam.probe()).toEqual({ ok: true, draining: false, children: [] } as never);
  }, 60_000);

  it('queues the dispatch while no runtime will take it, and drains it when one is back', async () => {
    const seam = await boot();
    await seam.stopHarness();

    // A runtime that is not there is not a run that failed.
    const held = await seam.dispatch();
    expect(held).toMatchObject({ queued: true, heldBy: 'fleet' });
    expect(seam.sql(`SELECT status, held_by AS heldBy, dispatched_by AS dispatchedBy FROM agent_runs WHERE id = '${held.runId}'`))
      .toEqual([{ status: 'queued', heldBy: 'fleet', dispatchedBy: null }]);
    // Nothing failed, and nothing is running.
    expect(seam.sql(`SELECT COUNT(*) AS c FROM agent_runs WHERE status = 'failed'`)).toEqual([{ c: 0 }]);

    seam.startHarness();
    expect((await seam.wake()).drained).toBe(1);

    const row = await settled(seam, held.runId);
    expect({ status: row.status, error: row.error }).toEqual({ status: 'completed', error: null });
    expect(seam.childEnv().MYCO_RUN_ID).toBe(held.runId);
  }, 60_000);
});
