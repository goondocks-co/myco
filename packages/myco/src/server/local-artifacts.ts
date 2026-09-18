/**
 * Automatic recovery for a Deployment this machine runs itself: the driver over the canonical artifact writer.
 *
 * Each attempt runs this binary's own `server backup` verb in a child process the Deployment owns, so the
 * artifact is the writer's (`local-backup.ts`, `recovery-bundle.ts`) and the snapshot's synchronous work is off
 * the serving loop, where it would otherwise stall every request for as long as the snapshot takes.
 *
 * No decision here rests on memory:
 *
 * - the **attempt is its directory**, written with its record before the child starts, so it exists even if the
 *   child never writes a manifest;
 * - the **destination's own lock** decides overlap, and it is the authority on whether an attempt is still being
 *   produced: a child that outlived this process keeps that lock, and its refusal of an ask means the attempt is
 *   alive, never that it failed;
 * - the **hold** deferring deletion of everything the snapshot names lives in the Deployment's database and
 *   outlives every process involved.
 *
 * An absent child handle is therefore evidence of nothing: it neither begins a second attempt nor settles a hold.
 */
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '@myco/utils/atomic-write.js';
import { LifecycleLock } from '@myco/utils/lifecycle-lock.js';
import { resolveBinary } from '../runtime/binary-resolution.js';
import { CommandCancelled, isCommandFailure, runOrThrow, systemRunner, type CommandRunner } from './runner.js';
import { resolveLocalPaths, type LocalDeploymentPaths } from './local.js';
import { schemaMetaValue } from '@myco-server-worker/platform/bun/server-main.js';
import type { NativeSqlite } from '@myco-server-worker/platform/bun/native.js';
import {
  settlementOf, type AttemptStage, type HoldSettlement, type ProducerRefusal, type RecoveryProducerPort, type RecoveryProducerStatus,
  type StagingPrunePolicy, type StagingPruneReport, type StagingPruneRequest,
} from '@myco-server-worker/core/recovery-producer.js';
import { prunableStagings, type RetainedStaging } from '@myco-server-worker/core/staging-retention.js';

/** The directory holding one Deployment's automatic artifacts, beside the volume rather than inside it. */
export const ARTIFACTS_DIRECTORY = 'local-recovery';

/** What one attempt records before anything runs, so the attempt exists whether or not its child ever writes. */
export interface AttemptRecord {
  startedAt: number;
  /** The recovery hold this attempt was admitted under, which its own settlement is answered from. */
  holdToken: string;
  startedBy: string;
  /** How many times this attempt has been asked to carry on. Bounded, so a failing attempt is not retried forever. */
  continuations: number;
  /**
   * How the last try ended, where one ended badly.
   *
   * A refusal is not the attempt's verdict. A child of an earlier Deployment process may still be producing this
   * artifact and holding its destination's lock, and that lock refuses this owner's ask — so a refusal says only
   * that this ask did nothing. The detail stays here; the status carries a classifier once the attempt is settled.
   */
  lastRefusal?: { refusal: ProducerRefusal; detail: string; at: number };
  /** Set once this attempt will not be carried on again: it is failed, and the interval decides the next one. */
  givenUp?: true;
  /** Set on the tombstone of a released artifact: its files are gone, and its identity is all that is kept. */
  released?: true;
}

/**
 * How many times one attempt may be asked to carry on before it is left failed.
 *
 * Past this the attempt stays on disk, visibly incomplete, and the interval decides when the next one begins: a
 * Deployment whose artifact cannot be produced does not spend every wake trying.
 */
export const CONTINUATION_LIMIT = 3;

/** How long one child may take. A snapshot and its object copies are minutes of work, not hours. */
export const PRODUCE_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** How long a stop waits for a withdrawn child to answer before leaving it to its own directory. */
export const STOP_WAIT_MS = 15_000;

const RECORD_SUFFIX = '.attempt.json';

/** Where this Deployment's automatic artifacts live: `<MYCO_HOME>/server/local-recovery/<deployment id>/`. */
export function artifactsRoot(paths: LocalDeploymentPaths, deploymentId: string): string {
  return path.join(path.dirname(paths.root), ARTIFACTS_DIRECTORY, deploymentId);
}

/** One attempt as this owner reads it: its directory, its record, and what its own manifest says it reached. */
export interface Attempt {
  startedAt: number;
  directory: string;
  record: AttemptRecord;
  /**
   * True where this attempt's own record could not be read.
   *
   * Such an attempt is uncertain, not absent: its directory and the hold it was admitted under may both be real.
   * It is counted as an attempt, never released, and never given up on.
   */
  uncertain: boolean;
  /** What the canonical writer recorded, or null while it has recorded nothing yet. */
  status: 'snapshot' | 'content' | 'complete' | null;
  /** True where a manifest exists but cannot be read: an attempt whose state is uncertain is never released. */
  unreadable: boolean;
  /** The hold the artifact's own record names, which is the token whose release settles it. */
  heldBy: string | null;
}

const readJson = <T>(file: string): T | null => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
};

/**
 * Every attempt under this root, oldest first.
 *
 * An attempt is a record, a directory, or both: a record whose write was interrupted reads as an uncertain
 * attempt rather than as nothing, and a directory whose record is gone is the tombstone of a released one.
 */
export function attempts(root: string): Attempt[] {
  const held: Attempt[] = [];
  const entries = fs.existsSync(root) ? fs.readdirSync(root) : [];
  const instants = new Set<number>();
  for (const entry of entries) {
    const name = entry.endsWith(RECORD_SUFFIX) ? entry.slice(0, -RECORD_SUFFIX.length) : entry;
    const instant = Number(name);
    if (Number.isInteger(instant) && String(instant) === name) instants.add(instant);
  }
  for (const startedAt of instants) {
    const record = readJson<AttemptRecord>(path.join(root, `${startedAt}${RECORD_SUFFIX}`));
    const uncertain = record === null;
    const directory = path.join(root, String(startedAt));
    const manifestFile = path.join(directory, 'recovery.json');
    const manifest = fs.existsSync(manifestFile) ? readJson<{ status?: string }>(manifestFile) : undefined;
    const hold = readJson<{ token?: string }>(path.join(directory, '.recovery-hold.json'));
    held.push({
      startedAt,
      directory,
      // An uncertain attempt is read with the most cautious record there is: one whose hold nothing may settle
      // and which nothing may give up on.
      record: record ?? { startedAt, holdToken: '', startedBy: 'unknown', continuations: CONTINUATION_LIMIT },
      uncertain,
      status: manifest === undefined || manifest === null ? null : (manifest.status as Attempt['status'] ?? null),
      unreadable: manifest === null && fs.existsSync(path.join(directory, 'recovery.json')),
      heldBy: typeof hold?.token === 'string' ? hold.token : null,
    });
  }
  return held.sort((left, right) => left.startedAt - right.startedAt);
}

/**
 * Whether something owns this destination now, asked of the lock the canonical writer itself takes.
 *
 * This is the only authoritative answer to "is an attempt still being produced". A child of an earlier
 * Deployment process survives an abrupt end of it and keeps this lock, and its refusal of an ask says the attempt
 * is alive — never that it failed.
 */
export function destinationOwned(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  const held = LifecycleLock.acquire(path.join(directory, '.recovery.lock'), { command: 'myco server local recovery probe' });
  if (!held.acquired) return true;
  held.lock.release();
  return false;
}

/** Whether this attempt is still going somewhere: it has not completed and has not been given up on. */
const running = (attempt: Attempt): boolean =>
  attempt.status !== 'complete' && (attempt.record.givenUp !== true || attempt.uncertain);

/** What an attempt's state says in the shared stage vocabulary; a native attempt copies, completes or fails. */
function stageOf(attempt: Attempt): AttemptStage {
  if (attempt.status === 'complete') return 'complete';
  if (attempt.record.givenUp === true) return 'failed';
  return 'copy';
}

/** How much of the artifact is on disk, without walking it: the snapshot's own bytes as its manifest records them. */
function staged(attempt: Attempt): RecoveryProducerStatus['staged'] {
  if (attempt.record.released === true) return null;
  const manifest = readJson<{ snapshot?: { database?: { bytes?: number }; blobCount?: number } }>(path.join(attempt.directory, 'recovery.json'));
  const bytes = manifest?.snapshot?.database?.bytes ?? null;
  const objects = manifest?.snapshot?.blobCount ?? 0;
  const copied = fs.existsSync(path.join(attempt.directory, 'blobs'))
    ? fs.readdirSync(path.join(attempt.directory, 'blobs'), { recursive: true }).filter((entry) => typeof entry === 'string' && !entry.endsWith('.partial')).length
    : 0;
  return {
    prefix: attempt.directory,
    sqlBytes: bytes,
    downloadedBytes: bytes ?? 0,
    parts: 0,
    objects: { registered: objects, staged: Math.min(copied, objects) },
  };
}

const idle: RecoveryProducerStatus = {
  attempt: null, stage: 'idle', form: 'artifact', startedAt: null, recoverable: false, staged: null,
  export: null, error: null, transientSpent: 0, stagedSchema: null,
};

/** One attempt's progress, in the shared vocabulary, with no claim that an artifact is more than what it is. */
export function statusOf(attempt: Attempt | undefined): RecoveryProducerStatus {
  if (attempt === undefined) return idle;
  return {
    ...idle,
    attempt: attempt.startedAt,
    stage: stageOf(attempt),
    startedAt: attempt.record.startedAt,
    staged: attempt.status === null ? null : staged(attempt),
    // A classifier is the verdict of a settled attempt. One still being carried on reports its stage, not a
    // refusal an orphaned child's lock may have caused.
    error: attempt.record.givenUp === true ? attempt.record.lastRefusal?.refusal ?? null : null,
    transientSpent: attempt.record.continuations,
  };
}

/** What a child's refusal classifies as. Its own words stay in the attempt's record, out of the status. */
function refusalOf(error: unknown): { refusal: ProducerRefusal; detail: string } {
  const detail = error instanceof Error ? error.message : String(error);
  if (error instanceof CommandCancelled) return { refusal: 'artifact_cancelled', detail };
  return { refusal: 'artifact_refused', detail: detail.slice(0, 2_000) };
}

export interface LocalArtifactsOptions {
  paths?: LocalDeploymentPaths;
  native?: NativeSqlite;
  runner?: CommandRunner;
  /** How a report line reaches an operator watching the Deployment's own output. */
  report?: (line: string) => void;
  /** Injectable for tests: what this owner spawns, resolved from the running code by default. */
  command?: { path: string; args: readonly string[] };
  now?: () => number;
}

/**
 * This Deployment's own recovery producer, over the artifacts it keeps beside its volume.
 *
 * It implements the same port the hosted producer does, so one admission owner, one schedule and one retention
 * policy serve both targets; where the two genuinely differ — a staging an operator must materialize, against an
 * artifact a restore consumes — the difference travels in the status's own `form`.
 */
export class LocalArtifacts implements RecoveryProducerPort {
  private readonly paths: LocalDeploymentPaths;
  private readonly runner: CommandRunner;
  private readonly report: (line: string) => void;
  private readonly now: () => number;
  private readonly stopping = new AbortController();
  /** The child this process started, if it is still running here. Never consulted as evidence about an attempt. */
  private child: Promise<void> | null = null;
  private deployment: string | null = null;
  private waking: (() => Promise<void>) | null = null;

  constructor(private readonly options: LocalArtifactsOptions = {}) {
    this.paths = options.paths ?? resolveLocalPaths();
    this.runner = options.runner ?? systemRunner();
    this.report = options.report ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * How this owner asks its Deployment for a wake, which it can only be given once the Deployment is up.
   *
   * A settled attempt is worth a wake: the hold that defers deletion of everything its snapshot named is settled
   * by the Deployment's own hold-release job, and without a wake that waits for the next tick on the clock.
   */
  wakeWith(wake: () => Promise<void>): void {
    this.waking = wake;
  }

  /**
   * The Deployment this volume holds, read from the volume itself rather than from any configured value.
   *
   * A volume that cannot be read names nothing: this Deployment then produces no artifact and says so, rather
   * than failing every wake on a file it cannot open.
   */
  private deploymentId(): string | null {
    if (this.deployment === null) {
      try {
        this.deployment = schemaMetaValue(this.paths.databasePath, 'deployment_id', this.options.native);
      } catch { return null; }
    }
    return this.deployment;
  }

  private root(): string | null {
    const id = this.deploymentId();
    return id === null ? null : artifactsRoot(this.paths, id);
  }

  get admission(): RecoveryProducerPort['admission'] {
    if (!fs.existsSync(this.paths.databasePath)) return { ready: false, reason: 'this Deployment has no volume on this machine yet' };
    if (this.deploymentId() === null) return { ready: false, reason: 'this Deployment\'s volume names no Deployment id yet' };
    return { ready: true };
  }

  private held(): Attempt[] {
    const root = this.root();
    return root === null ? [] : attempts(root);
  }

  private newest(): Attempt | undefined {
    return this.held().at(-1);
  }

  async status(): Promise<RecoveryProducerStatus> {
    return statusOf(this.newest());
  }

  /**
   * Begin one attempt: pin it on disk, then ask a child to produce it.
   *
   * The pin is the attempt, so a child that never starts still leaves one the next wake sees and the cadence
   * counts. A hold token an attempt already carries answers that attempt, and an attempt still going answers
   * itself rather than starting a second.
   */
  async admit(admission: { holdToken: string; startedBy: string }): Promise<RecoveryProducerStatus> {
    const root = this.root();
    if (root === null) throw new Error('this Deployment holds no volume to produce an artifact from');
    const carried = this.held().find((attempt) => attempt.record.holdToken === admission.holdToken);
    if (carried !== undefined) return statusOf(carried);
    const open = this.held().find(running);
    if (open !== undefined) return statusOf(open);

    const startedAt = this.now();
    const record: AttemptRecord = { startedAt, holdToken: admission.holdToken, startedBy: admission.startedBy, continuations: 0 };
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    this.write(root, startedAt, record);
    fs.mkdirSync(path.join(root, String(startedAt)), { recursive: true, mode: 0o700 });
    this.produce(path.join(root, String(startedAt)), root, startedAt, record);
    return statusOf(this.held().find((attempt) => attempt.startedAt === startedAt));
  }

  private write(root: string, startedAt: number, record: AttemptRecord): void {
    atomicWriteFileSync(path.join(root, `${startedAt}${RECORD_SUFFIX}`), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  }

  /**
   * Ask a child to produce or carry on one artifact, returning as soon as it is started: a tick never waits for a
   * snapshot.
   *
   * The child is this binary's own backup verb, resolved from the running code — a compiled binary re-execs
   * itself, a checkout run re-execs its own entry script — so the build that produces an artifact is the build
   * serving the Deployment.
   */
  private produce(directory: string, root: string, startedAt: number, record: AttemptRecord): void {
    const resolved = this.options.command ?? (() => {
      const binary = resolveBinary('self-exec-entry');
      return { path: binary.path, args: binary.args };
    })();
    const args = [...resolved.args, 'server', 'backup', '--target', 'local', '--to', directory];
    this.write(root, startedAt, { ...record, continuations: record.continuations + 1 });
    this.report(`Producing a recovery artifact in ${directory}`);
    this.child = runOrThrow(this.runner, resolved.path, args, {
      env: { ...process.env, MYCO_HOME: path.dirname(path.dirname(this.paths.root)) },
      timeoutMs: PRODUCE_TIMEOUT_MS,
      signal: this.stopping.signal,
    }).then(() => {
      this.report(`Recovery artifact complete in ${directory}`);
    }).catch((error: unknown) => {
      // A refusal is recorded against the attempt, so it stays visible and the interval, not the next wake,
      // decides when another one begins. What the child said stays here and out of the status.
      const { refusal, detail } = refusalOf(error);
      const current = readJson<AttemptRecord>(path.join(root, `${startedAt}${RECORD_SUFFIX}`)) ?? record;
      // An attempt is given up on only when its own destination is owned by nobody. A refusal from the
      // destination's lock is evidence that something is still producing this artifact — a child of an earlier
      // Deployment process, which an abrupt end of that process does not stop — and giving up then would settle
      // the hold that defers deletion of everything its snapshot names while it is still copying them.
      const spent = (current.continuations >= CONTINUATION_LIMIT || !isCommandFailure(error))
        && !destinationOwned(directory);
      this.write(root, startedAt, {
        ...current,
        lastRefusal: { refusal, detail, at: this.now() },
        ...(spent ? { givenUp: true as const } : {}),
      });
      this.report(`Recovery artifact in ${directory} did not complete: ${detail.split('\n')[0] ?? refusal}`);
    }).finally(() => {
      this.child = null;
      // A settled attempt asks for a wake, so its hold is settled at the next tick rather than at the next hour.
      void this.waking?.().catch(() => undefined);
    });
  }

  /**
   * Carry on the attempt in flight, if it needs asking: where a child that stopped without finishing is noticed.
   *
   * The ask is the canonical writer against the same directory, which resumes that same attempt. A child still
   * running there holds the destination's lock and the ask is refused by it, rather than racing it. Nothing is
   * signalled, and no recorded pid is trusted.
   */
  async resumeAttempt(): Promise<void> {
    if (this.child !== null) return;
    const root = this.root();
    const attempt = this.newest();
    if (root === null || attempt === undefined) return;
    if (attempt.status === 'complete' || attempt.unreadable) return;
    // An attempt whose own record could not be read is left exactly as it is: nothing is concluded about it, and
    // nothing is written over the record that could not be read.
    if (attempt.uncertain || attempt.record.givenUp === true) return;
    if (attempt.record.continuations >= CONTINUATION_LIMIT) {
      // Asked as many times as the bound allows. It is failed only if nothing owns its destination; an owned one
      // is still being produced, and this owner waits for it rather than concluding anything about it.
      if (destinationOwned(attempt.directory)) {
        this.report(`The recovery artifact in ${attempt.directory} is still owned by its producer; waiting for it`);
        return;
      }
      this.write(root, attempt.startedAt, {
        ...attempt.record,
        lastRefusal: attempt.record.lastRefusal
          ?? { refusal: 'artifact_refused', detail: `the artifact did not complete in ${CONTINUATION_LIMIT} tries`, at: this.now() },
        givenUp: true,
      });
      return;
    }
    this.produce(attempt.directory, root, attempt.startedAt, attempt.record);
  }

  /**
   * Decide a recovery hold against the attempts: the one carrying it answers whether it is still going, and a
   * token no attempt carries — including one whose artifact retention released, whose tombstone keeps the token —
   * is retired.
   */
  async settleHold(token: string): Promise<HoldSettlement> {
    const carried = this.held().find((attempt) => attempt.record.holdToken === token && token !== '');
    if (carried === undefined) return { state: 'retired' };
    // A hold is closed on the attempt's own evidence: a complete artifact, or a settled one whose destination
    // nothing owns any more. While something owns it, the hold stays open however this attempt reads.
    const settled = carried.status === 'complete'
      || (!running(carried) && !carried.uncertain && !destinationOwned(carried.directory));
    return settlementOf({ id: carried.startedAt, stage: settled ? stageOf(carried) : 'copy' });
  }

  /** A native artifact is a snapshot of the volume as it was; a later schema change leaves it as it is. */
  async noteSchemaDrift(): Promise<RecoveryProducerStatus> {
    return this.status();
  }

  /** Artifacts this policy lets go of and retention has not finished releasing. */
  async pendingStagingPrunes(policy: StagingPrunePolicy): Promise<number> {
    return this.releasable(this.held(), policy).length;
  }

  /**
   * The artifacts this policy releases, oldest first, decided by the shared policy over these attempts.
   *
   * The policy excludes what is still advancing, what is uncertain and what carries a protected hold, and keeps
   * the newest complete artifact at every value; an uncertain attempt is offered to it as unconfirmed, which it
   * never selects.
   */
  private releasable(held: readonly Attempt[], policy: StagingPrunePolicy): Attempt[] {
    const rows: RetainedStaging[] = held.map((attempt) => ({
      id: attempt.startedAt,
      stage: attempt.uncertain || attempt.unreadable ? 'unconfirmed' : stageOf(attempt),
      holdToken: attempt.heldBy,
      pruneStartedAt: null,
    }));
    const selected = new Set(prunableStagings(rows, policy.keep, policy.protect));
    return held.filter((attempt) => selected.has(attempt.startedAt));
  }

  /**
   * Release what the policy lets go of, bounded by the files the request's budget allows.
   *
   * Each artifact's files go before its directory, and its record stays as a tombstone: it carries the hold token
   * that attempt was admitted under, so a settled token cannot admit another attempt, and the start the cadence
   * counts from. An artifact whose hold is still open is never released; its hold is reconciled instead, by
   * asking the canonical writer again — which is what settles a release whose answer was lost.
   */
  async pruneStagings(request: StagingPruneRequest): Promise<StagingPruneReport> {
    const root = this.root();
    if (root === null) return { releasedFiles: 0, releasedStagings: 0, pending: 0, refused: null };
    const budget = Math.max(0, Math.floor(request.budget));
    let releasedFiles = 0;
    let releasedStagings = 0;
    let refused: StagingPruneReport['refused'] = null;

    const held = this.held();
    const unsettled = held.find((attempt) => attempt.status === 'complete'
      && attempt.heldBy !== null && request.protect.includes(attempt.heldBy));
    if (unsettled !== undefined && this.child === null) {
      this.report(`Reconciling the recovery hold of the artifact in ${unsettled.directory}`);
      this.produce(unsettled.directory, root, unsettled.startedAt, unsettled.record);
    }

    for (const attempt of this.releasable(held, request)) {
      if (releasedFiles >= budget) break;
      try {
        const files = fs.existsSync(attempt.directory)
          ? fs.readdirSync(attempt.directory, { recursive: true })
            .map((entry) => path.join(attempt.directory, String(entry)))
            .filter((entry) => fs.statSync(entry, { throwIfNoEntry: false })?.isFile() === true)
          : [];
        // One file at a time, so a budget bounds what this pass deletes rather than what it starts.
        let spent = false;
        for (const file of files) {
          if (releasedFiles >= budget) { spent = true; break; }
          await fs.promises.rm(file, { force: true });
          releasedFiles += 1;
        }
        if (spent) break;
        await fs.promises.rm(attempt.directory, { recursive: true, force: true });
        this.write(root, attempt.startedAt, { ...attempt.record, released: true });
        releasedStagings += 1;
      } catch (error) {
        refused = 'unknown';
        this.report(`Could not release the recovery artifact in ${attempt.directory}: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
    return { releasedFiles, releasedStagings, pending: this.releasable(this.held(), request).length, refused };
  }

  /**
   * Stop owning the child this process started: withdrawing it ends its process group and leaves the attempt's
   * directory resumable.
   *
   * A child this process never started is not ended here and is not signalled; it holds the destination's lock
   * and finishes or stops on its own.
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    // Bounded: the runner ends the child's process group and answers what that managed, itself bounded. A child
    // that answers neither leaves an attempt its directory still describes, and a stop does not wait on it.
    await Promise.race([
      this.child?.catch(() => undefined) ?? Promise.resolve(),
      new Promise<void>((resolve) => { setTimeout(resolve, STOP_WAIT_MS).unref?.(); }),
    ]);
  }
}
