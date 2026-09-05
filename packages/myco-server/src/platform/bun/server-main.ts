/**
 * The self-hosted PROCESS entry: environment in, listening server out.
 *
 * It sits in `platform/bun/`, with the rest of this target's code. `src/entry/`
 * holds request-handler wiring only, where a file may reach the pipeline and
 * its own platform and nothing else; shared source stays platform-neutral. This
 * reads the environment, validates it, and migrates, and it names `bun:sqlite`
 * and `node:fs` — a decision-making, target-specific bootstrap belongs in
 * neither of the other two zones.
 *
 * `serve()` binds a socket and answers requests; nothing in the repository
 * calls it. This is what a container runs.
 *
 * Migration is deliberately NOT here. `entry/bun.ts` refuses to serve a volume
 * whose schema is not current, and that refusal is the backstop for a volume
 * reached without the entrypoint. The entrypoint applies migrations and then
 * execs this, so a container that starts is a container already migrated, and
 * a volume that skipped the entrypoint is refused rather than migrated by the
 * first request that happens to arrive.
 *
 * Secrets arrive as FILES. Compose mounts them under /run/secrets, keeping the
 * values out of `docker inspect` and out of the environment of every child
 * process. A `*_FILE` variable names the file; the plain variable remains for
 * a non-Compose operator.
 */
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { serve } from '../../entry/bun.js';
import { SCHEMA_STEPS } from '../../db/schema.js';
import { LIVE_RUN_STATUSES } from '../../core/runs.js';
import { httpHarnessLaunch } from './harness-runner.js';
import { RuntimeDraining } from '../../core/harness.js';

class StartupError extends Error {}

/** A required value, from the file its `*_FILE` variable names or from the variable itself. */
function secretOf(name: string, required: boolean): string | undefined {
  const path = process.env[`${name}_FILE`];
  if (path !== undefined && path !== '') {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch (err) {
      throw new StartupError(`${name}_FILE names ${path}, which cannot be read: ${(err as Error).message}`);
    }
  }
  const direct = process.env[name];
  if ((direct === undefined || direct === '') && required) {
    throw new StartupError(`${name} is not set, and ${name}_FILE names no readable file`);
  }
  return direct === '' ? undefined : direct;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new StartupError(`${name} is not set`);
  return value;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new StartupError(`${name} must be a non-negative integer, and is ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * The runtime this deployment launches runs on, or none.
 *
 * `MYCO_HARNESS` names the harness supervisor's address, and a deployment that
 * names one must also name the token file both services mount. Absent, nothing
 * is bound and every dispatch answers that no runtime is available.
 */
function harnessLaunchFromEnv(callbackOrigin: () => string): ReturnType<typeof httpHarnessLaunch> | undefined {
  const url = process.env.MYCO_HARNESS;
  if (url === undefined || url === '') return undefined;
  const named = `MYCO_HARNESS must be an http:// or https:// URL naming the harness runtime, and is ${JSON.stringify(url)}`;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new StartupError(named);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new StartupError(named);
  const token = secretOf('MYCO_HARNESS_TOKEN', true);
  if (token === undefined || token === '') {
    throw new StartupError('MYCO_HARNESS_TOKEN_FILE names an empty file, and the harness launch endpoint is authenticated');
  }
  return httpHarnessLaunch({ url, token, callbackOrigin });
}

/** What this process is once it serves. */
export interface StartedDeployment {
  /** The port the socket bound, which is the port the runtime calls back to. */
  port: number;
  stop(): Promise<void>;
  /** The launch this process bound, or nothing when it names no runtime. */
  harnessLaunch?: ReturnType<typeof httpHarnessLaunch>;
}

/**
 * Bring the mounted volume's schema current, applying only the steps it is
 * behind.
 *
 * The entrypoint calls this on EVERY container start, so replaying every step
 * would fail the second start on a table that already exists. Each step stamps
 * `schema_meta.version` as its last statement, which is the ledger: steps at or
 * below the stamped version are already applied.
 *
 * This is the only production path that applies migrations for this target. The
 * request handler refuses a volume that is behind rather than migrating it, and
 * the Cloudflare target migrates through `wrangler d1 migrations apply` —
 * equally an operator action, off the request path.
 */
export function migrateOnly(databasePath: string): number {
  const sqlite = new Database(databasePath, { create: true });
  try {
    sqlite.exec('PRAGMA foreign_keys = ON');

    let stamped = 0;
    try {
      const row = sqlite.query(`SELECT value FROM schema_meta WHERE key = 'version'`)
        .get() as { value: string } | null;
      stamped = row ? Number(row.value) : 0;
    } catch (err) {
      // An absent meta table is a volume at version 0, not a failure.
      if (!/no such table/i.test((err as Error).message)) throw err;
    }

    let applied = 0;
    for (const step of SCHEMA_STEPS) {
      if (step.version <= stamped) continue;
      // Statement by statement, so a step that failed part-way re-runs: every
      // statement but ADD COLUMN is written to re-apply, and a column that is
      // already there is the one shape SQLite cannot express as IF NOT EXISTS.
      for (const statement of step.statements) {
        try {
          sqlite.exec(statement);
        } catch (err) {
          const duplicateColumn = /^ALTER TABLE \w+ ADD COLUMN/.test(statement) && /duplicate column name/i.test((err as Error).message);
          if (!duplicateColumn) throw err;
        }
      }
      applied += 1;
    }
    return applied;
  } finally {
    sqlite.close();
  }
}

/**
 * The rows a deploy reads to learn what this Deployment still has in flight.
 *
 * The columns are the ones the operator's CLI reads, and the states are the
 * dispatcher's own (`core/runs.ts`) plus one a deploy must not ship over: a
 * queued row that names a credential is a run whose child may be working under
 * it, taken back into the queue by a launch answered too late. The fleet count
 * reads the dispatcher's states alone; this read is about what a recreate would
 * interrupt. The CLI holds the same query text for the hosted target, and
 * `tests/server/deployment-data-ops.test.ts` holds the two identical.
 */
export const LIVE_RUNS_QUERY = `SELECT id, task, status, started_at, run_context FROM agent_runs`
  + ` WHERE ${LIVE_RUN_STATUSES} OR (status = 'queued' AND dispatched_by IS NOT NULL)`;

/**
 * What this Deployment has in flight, as the rows themselves.
 *
 * A second reader beside the serving process, and read-only: the volume runs in
 * WAL mode (`platform/bun/database.ts`), which admits a reader while the server
 * writes, the busy timeout covers a checkpoint holding the file as this opens
 * it, and a path naming no volume is refused rather than created empty.
 *
 * Read-only carries one cost, and it is the one to want: a volume left with a
 * hot journal by a writer that died cannot be recovered by this reader, so the
 * read fails and the deploy refuses rather than a deploy proceeding on a volume
 * whose true contents nobody has established.
 */
export function liveRuns(databasePath: string): unknown[] {
  const sqlite = new Database(databasePath, { readonly: true });
  try {
    sqlite.exec('PRAGMA busy_timeout = 5000');
    return sqlite.query(LIVE_RUNS_QUERY).all() as unknown[];
  } finally {
    sqlite.close();
  }
}

/** What a process that died before it served says on its way out: a read command names the read, a start names the start. */
export function exitFailureLine(argv: readonly string[], message: string): string {
  return `${argv.includes('--live-runs') ? 'myco-server could not read the volume' : 'myco-server failed to start'}: ${message}\n`;
}

export async function main(): Promise<StartedDeployment | undefined> {
  if (process.argv.includes('--migrate-only')) {
    migrateOnly(requireEnv('MYCO_DATABASE'));
    return undefined;
  }

  // A deploy asks the running container what it is carrying before it recreates
  // it. One document on stdout, and a volume that cannot be read exits non-zero
  // with the one line the caller refuses the deploy over.
  if (process.argv.includes('--live-runs')) {
    process.stdout.write(`${JSON.stringify(liveRuns(requireEnv('MYCO_DATABASE')))}\n`);
    return undefined;
  }

  const transport = process.env.MYCO_TRANSPORT ?? 'loopback';
  if (transport !== 'loopback' && transport !== 'proxy') {
    throw new StartupError(`MYCO_TRANSPORT must be 'loopback' or 'proxy', and is ${JSON.stringify(transport)}`);
  }

  const sourceFrom = process.env.MYCO_SOURCE_FROM;
  if (sourceFrom !== undefined && sourceFrom !== 'socket' && sourceFrom !== 'proxy') {
    throw new StartupError(`MYCO_SOURCE_FROM must be 'socket' or 'proxy', and is ${JSON.stringify(sourceFrom)}`);
  }
  // A deployment declaring a proxy source without naming the header it trusts
  // establishes no identity, which the core answers 503 to. Refusing at startup
  // reports it once, rather than as every request failing.
  if (sourceFrom === 'proxy' && (process.env.MYCO_TRUSTED_HEADER ?? '') === '') {
    throw new StartupError("MYCO_SOURCE_FROM=proxy requires MYCO_TRUSTED_HEADER to name the header this deployment's proxy sets");
  }
  // `trustedHops` below 1 establishes no identity at all (source.ts:59), which
  // the core answers 503 to. A deployment declaring a proxy source and zero
  // hops serves nothing; refusing here reports it once instead of per request.
  if (sourceFrom === 'proxy' && positiveInt('MYCO_TRUSTED_HOPS', 1) < 1) {
    throw new StartupError('MYCO_SOURCE_FROM=proxy requires MYCO_TRUSTED_HOPS to be at least 1');
  }

  // A fleet of none is not a fleet: refusing at startup reports it once, rather than as every dispatch running unbounded.
  const fleetEnv = (): number => {
    const n = positiveInt('MYCO_FLEET', 1);
    if (n < 1) throw new StartupError('MYCO_FLEET must be a whole number of runtimes, 1 or more');
    return n;
  };

  const bind = process.env.MYCO_BIND ?? 'loopback';
  if (bind !== 'loopback' && bind !== 'all') {
    throw new StartupError(`MYCO_BIND must be 'loopback' or 'all', and is ${JSON.stringify(bind)}`);
  }

  // A dashboard directory is optional; one that is named must hold the shell.
  const uiDir = process.env.MYCO_UI_DIR === '' ? undefined : process.env.MYCO_UI_DIR;
  if (uiDir !== undefined && statSync(join(uiDir, 'index.html'), { throwIfNoEntry: false })?.isFile() !== true) {
    throw new StartupError(`MYCO_UI_DIR names ${uiDir}, which holds no index.html`);
  }

  const port = positiveInt('MYCO_PORT', 8787);
  // The requested port is not the bound one where the kernel chooses it, and a
  // runtime told the wrong address posts its ending nowhere. The origin is read
  // at each launch, from the socket, and a launch before the socket is bound is
  // one the queue holds rather than one the row fails on.
  let boundPort: number | null = null;
  const harnessLaunch = harnessLaunchFromEnv(() => {
    if (boundPort === null) throw new RuntimeDraining('the deployment has not bound its port, so no runtime can be told where to call back');
    return `http://127.0.0.1:${boundPort}`;
  });

  const started = await serve({
    bind,
    uiDir,
    databasePath: requireEnv('MYCO_DATABASE'),
    blobDir: requireEnv('MYCO_BLOB_DIR'),
    port,
    transport,
    ...(harnessLaunch === undefined ? {} : { harnessLaunch }),
    sourceFrom,
    header: process.env.MYCO_TRUSTED_HEADER,
    origin: process.env.MYCO_ORIGIN,
    ...(process.env.MYCO_FLEET === undefined ? {} : { fleet: fleetEnv() }),
    trustedHops: positiveInt('MYCO_TRUSTED_HOPS', 1),
    SECRET_WRAP_KEY: secretOf('SECRET_WRAP_KEY', false),
    SESSION_SECRET: secretOf('SESSION_SECRET', false),
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID,
    GITHUB_CLIENT_SECRET: secretOf('GITHUB_CLIENT_SECRET', false),
  });
  boundPort = started.port;

  // SIGTERM is the orchestrator asking for a drain, and the drain is what is
  // awaited here: exiting on the same tick as the stop call ends the process
  // with in-flight requests still open, which is the thing
  // `stop_grace_period` exists to avoid. A second signal exits immediately, so
  // an operator is never stuck behind a request that will not finish.
  let draining = false;
  for (const signal of ['SIGTERM', 'SIGINT'] as const) {
    process.on(signal, () => {
      if (draining) process.exit(0);
      draining = true;
      void started.stop().then(() => process.exit(0), () => process.exit(1));
    });
  }

  return { port: started.port, stop: started.stop, ...(harnessLaunch === undefined ? {} : { harnessLaunch }) };
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    // One line, no stack: a stack in a container log discloses paths and
    // surrounding source to whoever can read the log.
    process.stderr.write(exitFailureLine(process.argv, err instanceof Error ? err.message : String(err)));
    process.exit(1);
  });
}
