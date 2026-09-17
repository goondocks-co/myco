/**
 * The recovery hold's lifecycle: this Deployment's own export producer, and an operator's full backup.
 *
 * A hold opens in this Deployment's database before an export is admitted, so every release decided while the export
 * and its object copy run keeps its candidates recorded instead of journaling objects the snapshot names. It is
 * released only on an authoritative answer from the producer (`HoldSettlement`): the attempt carrying it advances no
 * further, or no attempt carries it and the token is retired. There is no interval after which a hold lapses; an
 * answer that never comes keeps the hold, and says so.
 */
import type { ServerEnv } from './adapters.js';
import { acquireRecoveryHold, openRecoveryHold, readRecoveryHold, releaseOperatorHold, releaseRecoveryHold, type OperatorHoldRelease } from './object-release.js';
import type { HoldSettlement } from './recovery-producer.js';
import { classify, emit } from '../telemetry.js';
import { within } from './recovery-inventory.js';

/** How long settling a hold may wait for the producer's answer before the hold is kept, unverified, for the next pass. */
export const HOLD_SETTLE_MS = 30_000;

/** The producer hold open now, if any. An operator hold is not settled here: only its own operator releases it. */
async function openHold(env: Pick<ServerEnv, 'db'>): Promise<string | null> {
  return (await openRecoveryHold(env.db, 'producer'))?.token ?? null;
}

/**
 * Settles the open producer hold against the producer, releasing it on a `closed` or `retired` answer. Answers the
 * settlement, or null when no producer hold is open. An unreachable producer, or a Deployment with none, keeps the
 * hold. An open operator hold is never asked about and never released here.
 */
export async function settleOpenHold(env: Pick<ServerEnv, 'db' | 'recovery'>, now: number, settleMs = HOLD_SETTLE_MS): Promise<HoldSettlement | 'unverified' | null> {
  const token = await openHold(env);
  if (token === null) return null;
  if (env.recovery === undefined) {
    emit({ kind: 'recovery_hold_unverified', reason: 'refused' });
    return 'unverified';
  }
  let settlement: HoldSettlement;
  try {
    const recovery = env.recovery;
    settlement = await within(() => recovery.settleHold(token), settleMs, Date.now);
  } catch (error) {
    emit({ kind: 'recovery_hold_unverified', error_class: classify(error) });
    return 'unverified';
  }
  if (settlement.state !== 'open') {
    await releaseRecoveryHold(env.db, token, now, settlement.state === 'retired' ? 'retired' : `attempt ${settlement.attempt} ${settlement.stage}`);
  }
  return settlement;
}

/**
 * Opens a fresh hold for a new admission. A hold still open is settled first: while its attempt advances, no new hold
 * opens and the caller answers that attempt's progress instead. When the producer cannot admit a new attempt
 * (`mayOpen` false), an open hold is still settled and an advancing attempt still answered, and no hold is opened.
 */
export async function openHoldForAdmission(
  env: Pick<ServerEnv, 'db' | 'recovery'>, now: number, mayOpen = true,
): Promise<{ token: string } | { held: HoldSettlement | 'unverified' } | { refused: true }> {
  const token = crypto.randomUUID();
  if (mayOpen && await acquireRecoveryHold(env.db, token, now)) return { token };
  const settled = await settleOpenHold(env, now);
  if (settled !== null && settled !== 'unverified' && settled.state === 'open') return { held: settled };
  if (settled === 'unverified') return { held: settled };
  if (!mayOpen) return { refused: true };
  if (await acquireRecoveryHold(env.db, token, now)) return { token };
  return { held: 'unverified' };
}

/** The tick job: settle the open hold, if any. Answers 1 when this pass released a hold. */
export async function recoveryHoldRelease(env: ServerEnv, now: number): Promise<number> {
  const settled = await settleOpenHold(env, now);
  return settled !== null && settled !== 'unverified' && settled.state !== 'open' ? 1 : 0;
}

/**
 * An operator's full backup holds every object its snapshot names until its artifact completes. The hold is the
 * backup's own: nothing settles it against a producer, no age releases it, and the operator releases it when its
 * artifact completes or when it gives the attempt up. While it is open, deletion defers and this Deployment still
 * admits its own exports.
 */
export type OperatorHoldState = 'open' | 'released' | 'absent' | 'producer';

export interface OperatorHold {
  state: OperatorHoldState;
  acquiredAt: number | null;
  releasedAt: number | null;
  releaseReason: string | null;
  /** The Deployment that answered for this hold, read in the same statement: what a destination binds its hold to. */
  sourceIdentity: string;
}

/** Opens the operator hold `token`, answering whether this call opened it. Retrying the same token never opens a second. */
export async function acquireOperatorHold(env: Pick<ServerEnv, 'db'>, token: string, now: number): Promise<boolean> {
  return acquireRecoveryHold(env.db, token, now, 'operator');
}

/**
 * What the table holds for `token`: an open or released operator hold, a token no hold carries, or a token that is a
 * producer hold, which an operator never releases.
 */
export async function inspectOperatorHold(env: Pick<ServerEnv, 'db'>, token: string): Promise<OperatorHold> {
  const { hold, sourceIdentity } = await readRecoveryHold(env.db, token);
  if (hold === null) return { state: 'absent', acquiredAt: null, releasedAt: null, releaseReason: null, sourceIdentity };
  const held = { acquiredAt: hold.acquiredAt, releasedAt: hold.releasedAt, releaseReason: hold.releaseReason, sourceIdentity };
  if (hold.holder !== 'operator') return { state: 'producer', ...held };
  return { state: hold.releasedAt === null ? 'open' : 'released', ...held };
}

/** Releases the operator hold `token`, answering whether this call released it. A released hold stays released. */
export async function settleOperatorHold(env: Pick<ServerEnv, 'db'>, token: string, now: number, reason: OperatorHoldRelease): Promise<boolean> {
  return releaseOperatorHold(env.db, token, now, reason);
}

/** The operator hold open on this Deployment, if any: what a status answer reports and an operator command refuses against. */
export async function openOperatorHold(env: Pick<ServerEnv, 'db'>): Promise<{ token: string; acquiredAt: number } | null> {
  const row = await openRecoveryHold(env.db, 'operator');
  return row === null ? null : { token: row.token, acquiredAt: row.acquiredAt };
}
