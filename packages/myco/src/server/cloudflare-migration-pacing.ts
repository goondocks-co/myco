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
/** D1 Time Travel keeps a database's history this long on the Workers Free plan (30 days on Paid). */
const TIME_TRAVEL_FREE_RETENTION_MS = 7 * 24 * 60 * 60_000;
import { CommandFailed, CommandTimedOut } from './runner.js';
import type { DeploymentRecord } from './cloudflare.js';

/** Waits spent at one live schema on an overloaded database, across migration applies and live-schema reads; the count starts over whenever the schema advances. */
export const D1_OVERLOAD_RETRIES = 8;
/** D1 measures load over ten seconds; the first wait outlasts one window. */
export const D1_OVERLOAD_BACKOFF_MIN_MS = 15_000;
export const D1_OVERLOAD_BACKOFF_MAX_MS = 120_000;
/** One migration apply that answers nothing for this long is ended. An index build on a 2 GB table took about 26 s per statement, and a call that did commit files is resumed, so one generous limit is safe. */
export const D1_MIGRATION_APPLY_TIMEOUT_MS = 15 * 60_000;
/** The whole update, waits and applies together, may take this long before it stops for the operator to rerun it. */
export const D1_UPDATE_CEILING_MS = 2 * 60 * 60_000;
/** The least time left in which the update still starts another apply. */
export const D1_LAST_APPLY_MIN_MS = 60_000;

export interface OverloadRetry {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

const OVERLOADED = /\[code:\s*7429\]|"code"\s*:\s*7429\b/;
/** Wrangler prints this once it has listed the unapplied files, before it runs the first of them. */
const MIGRATIONS_LISTED = 'Migrations to be applied';

/** Whether a Wrangler command failed with D1's own overload answer, code 7429. */
export function isD1Overload(error: unknown): error is CommandFailed {
  return error instanceof CommandFailed && OVERLOADED.test(`${error.stdout}\n${error.stderr}`);
}

/** A recorded Time Travel bookmark and the command that restores the database to it. */
export interface RecoveryPoint {
  bookmark: string;
  /** The schema the database was at when the bookmark was taken. */
  schema: number;
  recordedAt: string;
  command: string;
}

/** What the record shows of the Worker an update leaves serving, and the recovery points that bear on it. */
export interface StopEvidence {
  /** The only schema the recorded Worker serves, when the record shows it. */
  workerSchema?: number;
  /** The latest bookmark taken while the database was at `workerSchema` under that Worker. */
  compatible?: RecoveryPoint;
  /** This update's own recovery point. */
  current?: RecoveryPoint;
}

/**
 * The schema the recorded Worker serves and the latest bookmark taken at it. The first update attempted against that
 * Worker started from the schema it was deployed on, since a Worker serves only the schema it was built for; later
 * attempts against the same Worker may start from a schema an earlier stop left behind.
 */
export function workerSchemaEvidence(record: DeploymentRecord): { schema: number; bookmark: { bookmark: string; schemaBefore: number; recordedAt: string } } | undefined {
  if (record.versionId === null) return undefined;
  const entries = (record.schemaUpdates ?? []).filter((entry) => entry.workerVersionBefore === record.versionId);
  const schema = entries[0]?.schemaBefore;
  if (schema === undefined) return undefined;
  return { schema, bookmark: entries.filter((entry) => entry.schemaBefore === schema).at(-1)! };
}

/** Why the update stopped short of its target schema, with what is known of where the database stands. */
export interface SchemaStop {
  reason: 'overloaded' | 'migration_over_limit' | 'migration_timed_out' | 'out_of_time';
  databaseName: string;
  before: number;
  target: number;
  /** The live schema when the database last answered after the stop; null when it did not. */
  reached: number | null;
  /** The last live schema read during this update. */
  lastRead: number;
  /** The file that failed twice, for `migration_over_limit` and `migration_timed_out`. */
  migration?: string;
  /** Waits spent at the live schema the update stopped on. */
  retries: number;
  /** Whether a timed-out apply may still be running, for `migration_timed_out`. */
  stillRunning?: boolean;
  /** The time the timed-out apply was given, for `migration_timed_out`. */
  timeoutMs?: number;
  evidence: StopEvidence;
  detail: string;
}

/** A limit in the words a person reads it in. */
const minutes = (ms: number) => ms % 3_600_000 === 0 ? `${ms / 3_600_000} hours`
  : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} minutes`;

/** The first sentence of a stop, after "Schema update stopped:" in a summary and inside the thrown message. */
function stopHeadline(stop: SchemaStop): string {
  switch (stop.reason) {
    case 'overloaded':
      return `D1 database ${stop.databaseName} stayed overloaded (code 7429) through ${stop.retries} retries at schema ${stop.reached ?? stop.lastRead}`;
    case 'migration_over_limit':
      return `migration ${stop.migration} failed twice with D1 overload (code 7429) while the migrations before it applied`;
    case 'migration_timed_out':
      return stop.stillRunning === true
        ? `the migration command answered nothing for ${minutes(stop.timeoutMs ?? D1_MIGRATION_APPLY_TIMEOUT_MS)} and could not be ended`
        : `the migration command answered nothing for ${minutes(D1_MIGRATION_APPLY_TIMEOUT_MS)}, twice, with no migration applied in between; the next one is ${stop.migration}`;
    case 'out_of_time':
      return `the update ran past its ${minutes(D1_UPDATE_CEILING_MS)} limit with the schema at ${stop.reached ?? stop.lastRead} of ${stop.target}`;
  }
}

export class SchemaUpdateStopped extends Error {
  constructor(readonly stop: SchemaStop, options?: { cause?: unknown }) {
    super(`schema update stopped: ${stopHeadline(stop)}`, options);
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
 * `apply` gets the time one attempt may take. After every overloaded or timed-out attempt the live schema is read
 * (itself retried on overload) and reported as progress; a timed-out attempt may have committed files, so it is never
 * rerun blind. The waits at one schema are bounded, and start over when the schema advances. The update stops by name
 * when the waits at one schema run out, when the same file fails twice with nothing applied in between, or when the
 * whole update passes its ceiling. No attempt starts after the ceiling, and an attempt gets at most the time left.
 */
export async function applyMigrationsPaced(options: {
  databaseName: string;
  before: number;
  target: number;
  apply: (timeoutMs: number) => Promise<unknown>;
  liveSchema: () => Promise<number>;
  /** The migration file Wrangler runs after the one that stamped `version`. */
  fileAfter: (version: number) => string | undefined;
  evidence: StopEvidence;
  report?: (line: string) => void;
  retry?: OverloadRetry;
}): Promise<PacedApply> {
  const sleep = options.retry?.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.retry?.now ?? Date.now;
  const deadline = now() + D1_UPDATE_CEILING_MS;
  const remaining = () => deadline - now();
  const report = (line: string) => options.report?.(line);
  /** Waits spent at the current live schema, and across the whole update. */
  let retries = 0;
  let totalRetries = 0;
  let nextDelay = D1_OVERLOAD_BACKOFF_MIN_MS;
  let lastRead = options.before;
  /** The file that failed with no schema progress, how, and how many times in a row at this live schema. */
  let suspect: { file: string; kind: 'overload' | 'timeout'; failures: number } | undefined;
  const oneLine = (error: unknown) => (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ').trim();
  const stop = (reason: SchemaStop['reason'], reached: number | null, error: unknown, extra: Pick<SchemaStop, 'migration' | 'stillRunning' | 'timeoutMs'> = {}): never => {
    throw new SchemaUpdateStopped({
      reason, databaseName: options.databaseName, before: options.before, target: options.target, reached, lastRead,
      retries, detail: oneLine(error), evidence: options.evidence, ...extra,
    }, { cause: error });
  };
  /** One wait before the next attempt; the reason to stop instead once the waits at this schema or the update's time are spent. */
  const wait = async (): Promise<'overloaded' | 'out_of_time' | undefined> => {
    const left = remaining();
    if (left <= 0) return 'out_of_time';
    if (retries >= D1_OVERLOAD_RETRIES) return 'overloaded';
    const delay = Math.min(nextDelay, left);
    nextDelay = Math.min(D1_OVERLOAD_BACKOFF_MAX_MS, nextDelay * 2);
    retries += 1;
    totalRetries += 1;
    report(`Waiting ${Math.round(delay / 1000)} s for D1's load to settle (retry ${retries} of ${D1_OVERLOAD_RETRIES} at schema ${lastRead}).`);
    await sleep(delay);
    return undefined;
  };
  const readLive = async (): Promise<{ schema: number } | { error: unknown; stopReason?: 'overloaded' | 'out_of_time' }> => {
    for (;;) {
      try {
        return { schema: await options.liveSchema() };
      } catch (error) {
        if (!isD1Overload(error)) return { error };
        report(`D1 overloaded (code 7429) reading the live schema; last read ${lastRead} of ${options.target}.`);
        const stopReason = await wait();
        if (stopReason !== undefined) return { error, stopReason };
      }
    }
  };

  let lastError: unknown;
  for (;;) {
    let kind: 'overload' | 'timeout';
    let error: unknown;
    // No attempt starts past the deadline, and none may run past it: the last one gets only the time that is left,
    // read once so the check and the limit agree. An attempt with under a minute left would only be cut off mid-file.
    const left = remaining();
    if (left < D1_LAST_APPLY_MIN_MS) return stop('out_of_time', lastRead, lastError);
    const budget = Math.min(D1_MIGRATION_APPLY_TIMEOUT_MS, left);
    try {
      await options.apply(budget);
      if (totalRetries > 0) report(`D1 migrations applied after ${totalRetries} ${totalRetries === 1 ? 'retry' : 'retries'}; schema ${options.target} of ${options.target}.`);
      return { kind: 'applied' };
    } catch (caught) {
      error = caught;
      if (caught instanceof CommandTimedOut) kind = 'timeout';
      else if (isD1Overload(caught)) kind = 'overload';
      else return { kind: 'failed', error: caught };
    }
    if (error instanceof CommandTimedOut && (error.treeEnd === 'failed' || error.treeEnd === 'unknown')) {
      return stop('migration_timed_out', null, error, { stillRunning: true, timeoutMs: error.timeoutMs, ...(options.fileAfter(lastRead) === undefined ? {} : { migration: options.fileAfter(lastRead)! }) });
    }
    lastError = error;
    const live = await readLive();
    if ('error' in live) {
      if (live.stopReason === undefined) return { kind: 'failed', error };
      return stop(live.stopReason, null, error);
    }
    if (live.schema === options.target) return { kind: 'applied', confirmed: { detail: oneLine(error), reached: live.schema } };
    if (live.schema < lastRead || live.schema > options.target) return { kind: 'failed', error };
    const progressed = live.schema > lastRead;
    lastRead = live.schema;
    if (progressed) {
      retries = 0;
      nextDelay = D1_OVERLOAD_BACKOFF_MIN_MS;
    }
    // An overloaded attempt that advanced the schema may have ended on a file that committed and still answered 7429,
    // so it says nothing about the next file. Only an attempt that listed the files and applied none of them failed
    // on the next. A timed-out attempt listed nothing we can read, so it counts when nothing was applied.
    const next = options.fileAfter(live.schema);
    const listed = kind === 'timeout' || `${(error as CommandFailed).stdout}\n${(error as CommandFailed).stderr}`.includes(MIGRATIONS_LISTED);
    suspect = progressed || !listed || next === undefined ? undefined
      : { file: next, kind, failures: suspect?.file === next && suspect.kind === kind ? suspect.failures + 1 : 1 };
    report(kind === 'timeout'
      ? `${budget < D1_MIGRATION_APPLY_TIMEOUT_MS ? `The update's time ran out after ${minutes(budget)} of this migration command, so it was ended` : `The migration command answered nothing for ${minutes(budget)} and was ended`}: schema ${live.schema} of ${options.target}${suspect === undefined ? '' : `; ${suspect.file} did not apply`}.`
      : `D1 overloaded (code 7429) applying migrations: schema ${live.schema} of ${options.target}${suspect === undefined ? '' : `; ${suspect.file} did not apply`}.`);
    if (remaining() <= 0) return stop('out_of_time', live.schema, error);
    if (suspect !== undefined && suspect.failures >= 2) return stop(kind === 'timeout' ? 'migration_timed_out' : 'migration_over_limit', live.schema, error, { migration: suspect.file });
    const stopReason = await wait();
    if (stopReason !== undefined) return stop(stopReason, live.schema, error);
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
export function schemaStopLines(stop: SchemaStop, worker: WorkerLeft, now = Date.now()): string[] {
  const live = stop.reached === null
    ? `The live schema was not read ${stop.stillRunning === true ? 'because the stalled command may still be running' : 'while D1 was overloaded'}; the last read was ${stop.lastRead} of ${stop.target}.`
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
    `Schema update stopped: ${stopHeadline(stop)}. ${stop.reason === 'migration_over_limit'
      ? `A statement in it likely exceeds D1's per-query limit, so retrying will not help. ${live}`
      : `${live} Each migration applies whole, so a rerun resumes after the last one applied.`}`,
    `The Worker was left on its old release ${release}. ${serves}`,
    `D1 said: ${stop.detail}`,
  ];
  if (stop.reason === 'overloaded') {
    lines.push('Next: wait a few minutes for D1\'s load to settle, then run: myco server update --target cloudflare');
  } else if (stop.reason === 'out_of_time') {
    lines.push('Next: run: myco server update --target cloudflare; the schema keeps the migrations already applied, so it carries on from there.');
  } else if (stop.reason === 'migration_timed_out') {
    lines.push(stop.stillRunning === true
      ? `Next: the stalled command could not be ended and may still be running; make sure no wrangler process from this update is left, then run: myco server update --target cloudflare`
      : `Next: check that D1 database ${stop.databaseName} is answering, then run: myco server update --target cloudflare. A rerun stops at ${stop.migration} again if that migration needs more than ${minutes(D1_MIGRATION_APPLY_TIMEOUT_MS)}. ${recoveryAdvice(stop.evidence, now)}`);
  } else {
    lines.push(`Next: a rerun stops at ${stop.migration} again. ${recoveryAdvice(stop.evidence, now)}`);
  }
  return lines;
}

/** How to put the database back on the schema the Worker left serving accepts, claiming only what the record shows. */
function recoveryAdvice(evidence: StopEvidence, now: number): string {
  const { workerSchema, compatible, current } = evidence;
  const parts: string[] = [];
  if (workerSchema === undefined) {
    parts.push('The record does not show which schema the old Worker serves, so no recorded bookmark is known to suit it; check the live schema with: myco server status --target cloudflare');
  } else if (compatible === undefined) {
    parts.push(`No bookmark is recorded at schema ${workerSchema}, which the old Worker serves; check the live schema with: myco server status --target cloudflare`);
  } else if (now - Date.parse(compatible.recordedAt) > TIME_TRAVEL_FREE_RETENTION_MS) {
    parts.push(`Bookmark ${compatible.bookmark} was taken at schema ${workerSchema}, which the old Worker serves, but on ${compatible.recordedAt}, more than 7 days ago; D1 Time Travel keeps 7 days of history on the Workers Free plan and 30 on Paid, so it may be gone. If D1 still holds it, restoring it puts the database back on schema ${workerSchema} and discards writes made since: ${compatible.command}`);
  } else {
    parts.push(`To put the database back on schema ${workerSchema}, which the old Worker serves, restore bookmark ${compatible.bookmark}, taken on ${compatible.recordedAt} (it discards writes made since): ${compatible.command}`);
  }
  if (current !== undefined && current.bookmark !== compatible?.bookmark) {
    parts.push(`This update's own recovery point, bookmark ${current.bookmark}, returns the database to schema ${current.schema}${workerSchema === undefined ? '; whether the old Worker serves it is not recorded' : current.schema === workerSchema ? '' : ', which the old Worker does not serve'}: ${current.command}`);
  }
  return parts.join(' ');
}
