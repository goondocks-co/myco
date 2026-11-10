/**
 * Applying hosted migrations to a D1 database that answers "overloaded".
 *
 * D1 answers code 7429 when a database spends its resource allowance inside a ten-second window ("D1 DB is
 * overloaded"), or when a storage operation runs past its limit and is reset. Index builds over history-sized
 * tables, back to back, do both. Each migration file applies whole, and `wrangler d1 migrations apply` resumes after
 * the last file it recorded, so a paced retry is safe and makes progress. A migration that fails on its own, with
 * the files before it applied and the database answering, is a statement over D1's per-query limit: retrying it
 * cannot help, so it stops by name.
 */
import { CommandFailed } from './runner.js';

/** Waits spent on one update's overloaded database, across migration applies and live-schema reads. */
export const D1_OVERLOAD_RETRIES = 8;
/** D1 measures load over ten seconds; the first wait outlasts one window. */
export const D1_OVERLOAD_BACKOFF_MIN_MS = 15_000;
export const D1_OVERLOAD_BACKOFF_MAX_MS = 120_000;

export interface OverloadRetry {
  sleep?: (ms: number) => Promise<void>;
}

const OVERLOADED = /\[code:\s*7429\]|"code"\s*:\s*7429\b/;
/** Wrangler prints this once it has listed the unapplied files, before it runs the first of them. */
const MIGRATIONS_LISTED = 'Migrations to be applied';

/** Whether a Wrangler command failed with D1's own overload answer, code 7429. */
export function isD1Overload(error: unknown): error is CommandFailed {
  return error instanceof CommandFailed && OVERLOADED.test(`${error.stdout}\n${error.stderr}`);
}

/** Why the update stopped short of its target schema, with what is known of where the database stands. */
export interface SchemaStop {
  reason: 'overloaded' | 'migration_over_limit';
  databaseName: string;
  before: number;
  target: number;
  /** The live schema when the database last answered after the stop; null when it did not. */
  reached: number | null;
  /** The last live schema read during this update. */
  lastRead: number;
  /** The file that failed twice, for `migration_over_limit`. */
  migration?: string;
  retries: number;
  /** The exact command that returns the database to its pre-update recovery point, when one was recorded. */
  restoreCommand?: string;
  detail: string;
}

export class SchemaUpdateStopped extends Error {
  constructor(readonly stop: SchemaStop, options?: { cause?: unknown }) {
    super(stop.reason === 'overloaded'
      ? `schema update stopped: D1 database ${stop.databaseName} stayed overloaded (code 7429) through ${stop.retries} retries`
      : `schema update stopped: migration ${stop.migration} failed twice with D1 overload (code 7429) while the migrations before it applied`, options);
    this.name = 'SchemaUpdateStopped';
  }
}

export type PacedApply =
  /** Every migration applied; `confirmed` carries the provider error when the live schema settled a failed command. */
  | { kind: 'applied'; confirmed?: { detail: string; reached: number } }
  /** A failure that is not D1's overload, or a live schema outside the update's range: settled by the caller as before. */
  | { kind: 'failed'; error: unknown };

/**
 * Run `apply` until the live schema reaches `target`, waiting out D1's overload between attempts.
 *
 * After every overloaded attempt the live schema is read (itself retried on overload) and reported as progress. The
 * update stops by name when the waits run out, or when the same file fails twice with the database answering and
 * nothing applied in between.
 */
export async function applyMigrationsPaced(options: {
  databaseName: string;
  before: number;
  target: number;
  apply: () => Promise<unknown>;
  liveSchema: () => Promise<number>;
  /** The migration file Wrangler runs after the one that stamped `version`. */
  fileAfter: (version: number) => string | undefined;
  restoreCommand?: string;
  report?: (line: string) => void;
  retry?: OverloadRetry;
}): Promise<PacedApply> {
  const sleep = options.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const report = (line: string) => options.report?.(line);
  let retries = 0;
  let nextDelay = D1_OVERLOAD_BACKOFF_MIN_MS;
  let lastRead = options.before;
  let lastFailedFile: string | undefined;
  const oneLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const stop = (reason: SchemaStop['reason'], reached: number | null, error: unknown, migration?: string): never => {
    throw new SchemaUpdateStopped({
      reason, databaseName: options.databaseName, before: options.before, target: options.target, reached, lastRead,
      retries, detail: oneLine(error), ...(migration === undefined ? {} : { migration }),
      ...(options.restoreCommand === undefined ? {} : { restoreCommand: options.restoreCommand }),
    }, { cause: error });
  };
  /** One wait before the next attempt; false once the update has spent its waits. */
  const wait = async (progressed: boolean): Promise<boolean> => {
    if (retries >= D1_OVERLOAD_RETRIES) return false;
    const delay = progressed ? D1_OVERLOAD_BACKOFF_MIN_MS : nextDelay;
    nextDelay = Math.min(D1_OVERLOAD_BACKOFF_MAX_MS, delay * 2);
    retries += 1;
    report(`Waiting ${Math.round(delay / 1000)} s for D1's load to settle (retry ${retries} of ${D1_OVERLOAD_RETRIES}).`);
    await sleep(delay);
    return true;
  };
  const readLive = async (): Promise<{ schema: number } | { error: unknown; overloaded: boolean }> => {
    for (;;) {
      try {
        return { schema: await options.liveSchema() };
      } catch (error) {
        if (!isD1Overload(error)) return { error, overloaded: false };
        report(`D1 overloaded (code 7429) reading the live schema; last read ${lastRead} of ${options.target}.`);
        if (!(await wait(false))) return { error, overloaded: true };
      }
    }
  };

  for (;;) {
    try {
      await options.apply();
      if (retries > 0) report(`D1 migrations applied after ${retries} ${retries === 1 ? 'retry' : 'retries'}; schema ${options.target} of ${options.target}.`);
      return { kind: 'applied' };
    } catch (error) {
      if (!isD1Overload(error)) return { kind: 'failed', error };
      const live = await readLive();
      if ('error' in live) {
        if (!live.overloaded) return { kind: 'failed', error };
        return stop('overloaded', null, error);
      }
      if (live.schema === options.target) return { kind: 'applied', confirmed: { detail: oneLine(error), reached: live.schema } };
      if (live.schema < lastRead || live.schema > options.target) return { kind: 'failed', error };
      const progressed = live.schema > lastRead;
      lastRead = live.schema;
      const failedFile = `${error.stdout}\n${error.stderr}`.includes(MIGRATIONS_LISTED) ? options.fileAfter(live.schema) : undefined;
      report(`D1 overloaded (code 7429) applying migrations: schema ${live.schema} of ${options.target}${failedFile === undefined ? '' : `; ${failedFile} did not apply`}.`);
      if (failedFile !== undefined && failedFile === lastFailedFile && !progressed) return stop('migration_over_limit', live.schema, error, failedFile);
      lastFailedFile = failedFile;
      if (!(await wait(progressed))) return stop('overloaded', live.schema, error);
    }
  }
}

/** What the update did to the Worker when the schema stopped short: kept the release that was serving. */
export interface WorkerLeft {
  release: string | undefined;
  versionId: string | null;
  /** The only schema that release serves: a Worker refuses requests on any other. */
  schema: number | null;
}

/** The stop, the live schema, the Worker left serving, and the exact next command. */
export function schemaStopLines(stop: SchemaStop, worker: WorkerLeft): string[] {
  const live = stop.reached === null
    ? `The live schema could not be read while D1 was overloaded; the last read was ${stop.lastRead} of ${stop.target}.`
    : `Live schema ${stop.reached} of ${stop.target} (started at ${stop.before}).`;
  const release = `${worker.release ?? 'an unrecorded release'}${worker.versionId === null ? '' : ` (version ${worker.versionId})`}`;
  const serves = worker.schema === null
    ? 'Which schema it serves is not recorded.'
    : stop.reached === null
      ? `It serves schema ${worker.schema} only; whether it can serve the live schema is unknown until the schema can be read.`
      : stop.reached === worker.schema
        ? `It serves schema ${worker.schema}, which is the live schema, so it keeps serving.`
        : `It serves schema ${worker.schema} only, so it refuses requests while the live schema is ${stop.reached}.`;
  const lines = [
    stop.reason === 'overloaded'
      ? `Schema update stopped: D1 database ${stop.databaseName} stayed overloaded (code 7429) through ${stop.retries} retries. ${live} Each migration applies whole, so a rerun resumes after the last one applied.`
      : `Schema update stopped: migration ${stop.migration} failed twice with D1 overload (code 7429) while the migrations before it applied. A statement in it likely exceeds D1's per-query limit, so retrying will not help. ${live}`,
    `The Worker was left on its old release ${release}. ${serves}`,
    `D1 said: ${stop.detail}`,
  ];
  if (stop.reason === 'overloaded') {
    lines.push('Next: wait a few minutes for D1\'s load to settle, then run: myco server update --target cloudflare');
  } else {
    lines.push(`Next: a rerun stops at ${stop.migration} again. ${stop.restoreCommand === undefined
      ? 'Check the live schema with: myco server status --target cloudflare'
      : `To put the database back on the schema the old Worker serves, restore the bookmark recorded before this update (it discards writes made since): ${stop.restoreCommand}`}`);
  }
  return lines;
}
