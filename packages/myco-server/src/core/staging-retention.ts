/**
 * Which staged recovery payloads a Deployment keeps, and which it lets go of.
 *
 * Each scheduled backup writes a staging of the Deployment's whole database under its own prefix. This bounds how
 * many of those payloads the recovery store holds: it keeps the newest complete stagings, keeps the newest failed
 * one for diagnostics, and lets older settled payloads go.
 *
 * What is never let go of comes from the attempts' own state: an attempt still advancing, one resting
 * unconfirmed whose publication is uncertain, a legacy attempt that only downloaded, and any attempt whose hold
 * the Deployment still holds open. A payload already released is not selected again.
 *
 * Deciding is pure, so the rule is testable without a store, and the store that holds the payloads decides
 * nothing.
 */
import type { RelationalStore, ServerEnv } from './adapters.js';
import { leafValues } from './settings.js';
import { openRecoveryHold } from './object-release.js';
import { within } from './recovery-inventory.js';
import { classify, emit } from '../telemetry.js';
import { ADVANCING_STAGES, type AttemptStage, type StagingPrunePolicy } from './recovery-producer.js';

export { STAGING_RETENTION_JOB } from './jobs.js';

/** The leaf an owner edits: how many complete stagings this Deployment keeps. */
export const KEEP_STAGINGS_SETTING = 'backup.recovery.keep_stagings';

/**
 * The default for a Deployment whose leaf holds no value: the newest complete staging and the one before it.
 *
 * Unset means this default, never "keep everything": a Deployment that schedules backups and never visits its
 * settings still bounds its own store.
 */
export const KEEP_STAGINGS_DEFAULT = 2;

/** One complete staging is the floor. A policy may not leave a Deployment with no recovery data at all. */
export const KEEP_STAGINGS_MIN = 1;

/** The newest failed staging is kept for diagnostics; older settled failures are payload the store need not hold. */
export const KEEP_FAILED_STAGINGS = 1;

/**
 * Files one wake may release.
 *
 * A staging holds one file per registered object, so a Deployment with a large inventory needs more than one pass.
 * A pass releases up to this many files and reports what it left; the next wake carries on from the same cursor.
 */
export const PRUNE_FILE_BUDGET = 200;

/** How many complete stagings this Deployment keeps now, with the default for a leaf never written. */
export async function keptStagings(db: RelationalStore): Promise<number> {
  const raw = (await leafValues(db, [KEEP_STAGINGS_SETTING])).get(KEEP_STAGINGS_SETTING);
  if (raw === undefined) return KEEP_STAGINGS_DEFAULT;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return KEEP_STAGINGS_DEFAULT; }
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return KEEP_STAGINGS_DEFAULT;
  return Math.max(KEEP_STAGINGS_MIN, Math.floor(parsed));
}

/** How long a pass waits for the producer's own reading before this wake leaves retention alone. */
export const PRUNE_READ_MS = 5_000;

/**
 * What this Deployment keeps, and whose stagings nothing may touch.
 *
 * The protected tokens are the holds open in this Deployment's own table: its producer's, while an attempt is
 * advancing or its settlement is still unverified, and its operator's, while a full backup runs. A hold stays open
 * until the producer answers for it, so a Deployment that cannot reach its producer protects that attempt.
 */
export async function stagingPrunePolicy(env: Pick<ServerEnv, 'db'>): Promise<StagingPrunePolicy> {
  const [keep, producer, operator] = await Promise.all([
    keptStagings(env.db), openRecoveryHold(env.db, 'producer'), openRecoveryHold(env.db, 'operator'),
  ]);
  return { keep, protect: [producer?.token, operator?.token].filter((token): token is string => token !== undefined) };
}

/**
 * Whether staged payloads are waiting to be released, for the engine's own depth assertion.
 *
 * A Deployment with cleanup owing is held no deeper than sleep, which is where the job that does it runs, and the
 * assertion drops as soon as the last payload has gone. A producer that cannot answer inside the window asserts
 * nothing, and says how its refusal classifies: an unreachable producer holds no Deployment awake, and reads as
 * an unanswered producer rather than as a Deployment with no cleanup owing.
 */
export async function stagingPruneDue(env: Pick<ServerEnv, 'db' | 'recovery'>, readMs = PRUNE_READ_MS): Promise<boolean> {
  const recovery = env.recovery;
  if (recovery === undefined) return false;
  const policy = await stagingPrunePolicy(env);
  const pending = await within(() => recovery.pendingStagingPrunes(policy), readMs, Date.now)
    .catch((error: unknown) => { emit({ kind: 'recovery_prune_unreadable', error_class: classify(error) }); return 0; });
  return pending > 0;
}

/** One attempt as retention reads it: what it reached, whose hold it carries, and whether its release began. */
export interface RetainedStaging {
  id: number;
  stage: AttemptStage | string;
  holdToken: string | null;
  /** Set once this attempt's release began. Such an attempt is resumed by its own cursor, never selected again. */
  pruneStartedAt: number | null;
}

/** The stages whose payload may ever be released: settled, and settled in a way that says what became of it. */
const SETTLED = ['complete', 'failed'] as const;

/**
 * The attempts whose staged payload may be released now, oldest first.
 *
 * Oldest first, so a bounded pass makes monotone progress: the payload that has been kept longest goes first,
 * and a pass that runs out of budget leaves the rest for the next one.
 *
 * `protectedTokens` are the hold tokens the Deployment still holds open, or whose state it could not read. An
 * attempt carrying one of those is never selected, whatever its stage says.
 */
export function prunableStagings(
  rows: readonly RetainedStaging[],
  keep: number,
  protectedTokens: readonly string[] = [],
): number[] {
  const kept = Math.max(KEEP_STAGINGS_MIN, Math.floor(keep));
  const protect = new Set(protectedTokens);
  const settled = rows
    .filter((row) => row.pruneStartedAt === null)
    .filter((row) => (SETTLED as readonly string[]).includes(row.stage))
    .filter((row) => !(ADVANCING_STAGES as readonly string[]).includes(row.stage))
    .filter((row) => row.holdToken === null || !protect.has(row.holdToken))
    .sort((a, b) => b.id - a.id);

  const newestFirst = (stage: string): RetainedStaging[] => settled.filter((row) => row.stage === stage);
  // The newest complete stagings count toward the policy: `kept` of them survive, and the newest of them is
  // always among those, so the last good staging stands through every later attempt.
  const releasable = [
    ...newestFirst('complete').slice(kept),
    ...newestFirst('failed').slice(KEEP_FAILED_STAGINGS),
  ];
  return releasable.map((row) => row.id).sort((a, b) => a - b);
}
