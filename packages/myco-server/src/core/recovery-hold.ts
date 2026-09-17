/**
 * The recovery hold's lifecycle around the hosted producer.
 *
 * A hold opens in this Deployment's database before an export is admitted, so every release decided while the export
 * and its object copy run keeps its candidates recorded instead of journaling objects the snapshot names. It is
 * released only on an authoritative answer from the producer (`HoldSettlement`): the attempt carrying it advances no
 * further, or no attempt carries it and the token is retired. There is no interval after which a hold lapses; an
 * answer that never comes keeps the hold, and says so.
 */
import type { ServerEnv } from './adapters.js';
import { acquireRecoveryHold, releaseRecoveryHold } from './object-release.js';
import type { HoldSettlement } from './recovery-producer.js';
import { classify, emit } from '../telemetry.js';
import { within } from './recovery-inventory.js';

/** How long settling a hold may wait for the producer's answer before the hold is kept, unverified, for the next pass. */
export const HOLD_SETTLE_MS = 30_000;

/** The hold open now, if any. */
async function openHold(env: Pick<ServerEnv, 'db'>): Promise<string | null> {
  const row = await env.db.prepare('SELECT token FROM recovery_holds WHERE released_at IS NULL').first<{ token: string }>();
  return row?.token ?? null;
}

/**
 * Settles the open hold against the producer, releasing it on a `closed` or `retired` answer. Answers the settlement,
 * or null when no hold is open. An unreachable producer, or a Deployment with none, keeps the hold.
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
 * opens and the caller answers that attempt's progress instead.
 */
export async function openHoldForAdmission(env: Pick<ServerEnv, 'db' | 'recovery'>, now: number): Promise<{ token: string } | { held: HoldSettlement | 'unverified' }> {
  const token = crypto.randomUUID();
  if (await acquireRecoveryHold(env.db, token, now)) return { token };
  const settled = await settleOpenHold(env, now);
  if (settled !== null && settled !== 'unverified' && settled.state === 'open') return { held: settled };
  if (settled === 'unverified') return { held: settled };
  if (await acquireRecoveryHold(env.db, token, now)) return { token };
  return { held: 'unverified' };
}

/** The tick job: settle the open hold, if any. Answers 1 when this pass released a hold. */
export async function recoveryHoldRelease(env: ServerEnv, now: number): Promise<number> {
  const settled = await settleOpenHold(env, now);
  return settled !== null && settled !== 'unverified' && settled.state !== 'open' ? 1 : 0;
}
